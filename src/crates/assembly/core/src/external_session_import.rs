//! Import and local continuation of external Agent sessions.

use openbitfun_codex_adapter::session::{CodexSessionReader, SOURCE_REVISION};
use openbitfun_product_domains::external_sources::{
    ExternalSourceOperationError, ExternalSourceOperationErrorCode, ExternalSourceOperationResult,
};
use openbitfun_product_domains::session_import::{
    CodexSessionDocument, ExternalSessionCandidate, ExternalSessionCatalogScope,
    ExternalSessionImportApplied, ExternalSessionImportMode, ExternalSessionImportPlan,
    ExternalSessionImportRequest, ExternalSessionWorkspaceMapping,
    EXTERNAL_SESSION_IMPORT_SCHEMA_V1,
};
use openbitfun_runtime_ports::SessionStorePort;
use openbitfun_services_core::session::{
    DialogTurnData, ModelRoundData, OfflineSessionBundle, OfflineSessionImportStore,
    SessionMemoryMode, SessionMetadata, SessionStatus, TextItemData, ThinkingItemData,
    ToolCallData, ToolItemData, ToolResultData, TurnStatus, UserMessageData,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

const MAX_LIST_LIMIT: usize = 50;

type ImportOperations = HashMap<String, (Arc<AtomicBool>, Instant)>;
static IMPORT_OPERATIONS: LazyLock<Mutex<ImportOperations>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct ImportOperation {
    id: String,
    cancelled: Arc<AtomicBool>,
    keep_for_apply: bool,
}

impl ImportOperation {
    fn start(id: &str) -> ExternalSourceOperationResult<Self> {
        Uuid::parse_str(id).map_err(|_| {
            operation(
                ExternalSourceOperationErrorCode::InvalidRequest,
                "Invalid import operation ID",
                false,
            )
        })?;
        let mut operations = IMPORT_OPERATIONS
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // Reclaim abandoned plans; an executing operation holds its own Arc.
        operations.retain(|_, (cancelled, created)| {
            Arc::strong_count(cancelled) > 1 || created.elapsed() < Duration::from_secs(600)
        });
        if operations.contains_key(id) {
            return Err(operation(
                ExternalSourceOperationErrorCode::Conflict,
                "Import operation already exists",
                false,
            ));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        operations.insert(id.to_owned(), (cancelled.clone(), Instant::now()));
        Ok(Self {
            id: id.to_owned(),
            cancelled,
            keep_for_apply: false,
        })
    }

    fn resume(id: &str) -> ExternalSourceOperationResult<Self> {
        let operations = IMPORT_OPERATIONS
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (cancelled, _) = operations.get(id).ok_or_else(cancelled_import)?;
        if Arc::strong_count(cancelled) > 1 {
            return Err(operation(
                ExternalSourceOperationErrorCode::Conflict,
                "Import operation is still running",
                false,
            ));
        }
        Ok(Self {
            id: id.to_owned(),
            cancelled: cancelled.clone(),
            keep_for_apply: false,
        })
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    fn check(&self) -> ExternalSourceOperationResult<()> {
        if self.is_cancelled() {
            Err(cancelled_import())
        } else {
            Ok(())
        }
    }
}

impl Drop for ImportOperation {
    fn drop(&mut self) {
        if !self.keep_for_apply {
            let mut operations = IMPORT_OPERATIONS
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if operations
                .get(&self.id)
                .is_some_and(|(token, _)| Arc::ptr_eq(token, &self.cancelled))
            {
                operations.remove(&self.id);
            }
        }
    }
}

fn cancelled_import() -> ExternalSourceOperationError {
    operation(
        ExternalSourceOperationErrorCode::Cancelled,
        "Session import cancelled",
        false,
    )
}

pub fn cancel_codex_session_import(operation_id: &str) -> bool {
    let entry = IMPORT_OPERATIONS
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(operation_id);
    if let Some((cancelled, _)) = entry {
        cancelled.store(true, Ordering::Release);
        true
    } else {
        false
    }
}

pub async fn list_codex_sessions(
    cursor: usize,
    limit: usize,
    query: &str,
    scope: Option<ExternalSessionCatalogScope>,
) -> ExternalSourceOperationResult<openbitfun_product_domains::session_import::ExternalSessionCatalog>
{
    let reader = CodexSessionReader::default();
    let query = query.to_owned();
    let mut catalog = tokio::task::spawn_blocking(move || match scope {
        Some(scope) => reader.discover_workspaces(cursor, limit.min(MAX_LIST_LIMIT), &query, scope),
        None => reader.discover(cursor, limit.min(MAX_LIST_LIMIT), &query),
    })
    .await
    .map_err(|error| {
        operation(
            ExternalSourceOperationErrorCode::Internal,
            error.to_string(),
            true,
        )
    })?
    .map_err(|error| operation(ExternalSourceOperationErrorCode::Unavailable, error, true))?;
    annotate_catalog(&mut catalog).await?;
    Ok(catalog)
}

pub async fn plan_codex_session_import(
    _workspace_id: Option<&str>,
    candidate_id: &str,
    _mode: ExternalSessionImportMode,
    operation_id: Option<&str>,
) -> ExternalSourceOperationResult<ExternalSessionImportPlan> {
    let mut import_operation = operation_id.map(ImportOperation::start).transpose()?;
    let reader = CodexSessionReader::default();
    let candidate_id = candidate_id.to_owned();
    let document = tokio::task::spawn_blocking(move || {
        reader.read_candidate(&candidate_id, ExternalSessionImportMode::Full)
    })
    .await
    .map_err(|error| {
        operation(
            ExternalSourceOperationErrorCode::Internal,
            error.to_string(),
            true,
        )
    })?
    .map_err(|error| operation(ExternalSourceOperationErrorCode::NotFound, error, false))?;
    if let Some(operation) = &import_operation {
        operation.check()?;
    }
    let workspace = resolve_import_workspace(&document.candidate).await?;
    let plan = build_plan(
        &workspace.id,
        &workspace.name,
        &workspace.root_path,
        document,
        ExternalSessionImportMode::Full,
    );
    if let Some(operation) = &mut import_operation {
        operation.check()?;
        operation.keep_for_apply = true;
    }
    Ok(plan)
}

pub async fn apply_codex_session_import(
    request: ExternalSessionImportRequest,
) -> ExternalSourceOperationResult<ExternalSessionImportApplied> {
    let import_operation = request
        .operation_id
        .as_deref()
        .map(ImportOperation::resume)
        .transpose()?;
    if let Some(operation) = &import_operation {
        operation.check()?;
    }
    if request.schema_version != EXTERNAL_SESSION_IMPORT_SCHEMA_V1 {
        return Err(operation(
            ExternalSourceOperationErrorCode::IncompatibleVersion,
            "Unsupported external Session import schema",
            false,
        ));
    }
    let reader = CodexSessionReader::default();
    let candidate_id = request.candidate_id.clone();
    let document = tokio::task::spawn_blocking(move || {
        reader.read_candidate(&candidate_id, ExternalSessionImportMode::Full)
    })
    .await
    .map_err(|error| {
        operation(
            ExternalSourceOperationErrorCode::Internal,
            error.to_string(),
            true,
        )
    })?
    .map_err(|error| operation(ExternalSourceOperationErrorCode::NotFound, error, false))?;
    if let Some(operation) = &import_operation {
        operation.check()?;
    }
    let workspace = resolve_import_workspace(&document.candidate).await?;
    if workspace.id != request.target_workspace_id {
        return Err(operation(
            ExternalSourceOperationErrorCode::InvalidRequest,
            "The selected workspace does not match the Codex session workspace",
            false,
        ));
    }
    let plan = build_plan(
        &workspace.id,
        &workspace.name,
        &workspace.root_path,
        document.clone(),
        ExternalSessionImportMode::Full,
    );
    if plan.plan_fingerprint != request.plan_fingerprint {
        return Err(operation(
            ExternalSourceOperationErrorCode::StaleRevision,
            "Codex Session changed; refresh the import preview",
            true,
        ));
    }

    let (store, project) = import_storage(&workspace).await?;
    if let Some(existing) = store
        .list_metadata_including_internal()
        .await
        .map_err(|error| {
            operation(
                ExternalSourceOperationErrorCode::Internal,
                format!("Failed to inspect imported Codex Sessions: {error}"),
                true,
            )
        })?
        .into_iter()
        .find(|metadata| {
            metadata.workspace_id.as_deref() == Some(request.target_workspace_id.as_str())
                && metadata
                    .custom_metadata
                    .as_ref()
                    .and_then(|value| value.get("importedFrom"))
                    .and_then(serde_json::Value::as_str)
                    == Some("codex")
                && metadata
                    .custom_metadata
                    .as_ref()
                    .and_then(|value| value.get("sourceSessionId"))
                    .and_then(serde_json::Value::as_str)
                    == Some(document.candidate.source_session_id.as_str())
                && metadata
                    .custom_metadata
                    .as_ref()
                    .and_then(|value| value.get("sourceFingerprint"))
                    .and_then(serde_json::Value::as_str)
                    == Some(document.candidate.fingerprint.as_str())
        })
    {
        return Ok(ExternalSessionImportApplied {
            schema_version: EXTERNAL_SESSION_IMPORT_SCHEMA_V1,
            session_id: existing.session_id,
            imported_turn_count: existing.turn_count,
            warning_codes: document
                .warnings
                .into_iter()
                .map(|warning| warning.code)
                .collect(),
            already_imported: true,
        });
    }

    let session_id = format!("codex-import-{}", Uuid::new_v4());
    let session_name = request
        .session_title
        .filter(|value| !value.trim().is_empty())
        .or(document.candidate.title.clone())
        .unwrap_or_else(|| "Imported Codex Session".to_string());
    let bundle = convert_document(
        &session_id,
        &workspace,
        &project,
        &request.agent_id,
        &session_name,
        &document,
        request.include_tool_history,
        request.include_thinking,
    )?;

    store
        .write_bundle_atomic_cancellable(&bundle, || {
            import_operation
                .as_ref()
                .is_some_and(ImportOperation::is_cancelled)
        })
        .await
        .map_err(|error| {
            if matches!(
                error,
                openbitfun_services_core::session::OfflineSessionImportError::Cancelled
            ) {
                return cancelled_import();
            }
            operation(
                ExternalSourceOperationErrorCode::Internal,
                format!("Failed to persist imported Codex Session: {error}"),
                true,
            )
        })?;

    Ok(ExternalSessionImportApplied {
        schema_version: EXTERNAL_SESSION_IMPORT_SCHEMA_V1,
        session_id,
        imported_turn_count: bundle.turns.len(),
        warning_codes: document
            .warnings
            .into_iter()
            .map(|warning| warning.code)
            .collect(),
        already_imported: false,
    })
}

async fn resolve_import_workspace(
    candidate: &ExternalSessionCandidate,
) -> ExternalSourceOperationResult<crate::service::workspace::WorkspaceInfo> {
    let source_path = candidate
        .cwd
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| {
            operation(
                ExternalSourceOperationErrorCode::InvalidRequest,
                "Codex session does not identify a workspace directory",
                false,
            )
        })?;
    let service = crate::service::workspace::get_global_workspace_service().ok_or_else(|| {
        operation(
            ExternalSourceOperationErrorCode::Unavailable,
            "Workspace service is unavailable",
            true,
        )
    })?;
    let source = Path::new(source_path);
    if !source.is_absolute() || !source.is_dir() {
        return Err(operation(
            ExternalSourceOperationErrorCode::InvalidRequest,
            "The Codex workspace directory is unavailable on this host",
            false,
        ));
    }
    let workspaces = service.list_workspace_infos().await;
    if let Some(workspace) = matching_workspace(&workspaces, source) {
        return Ok(workspace.clone());
    }
    service
        .register_local_workspace_record(PathBuf::from(source_path))
        .await
        .map_err(|error| {
            operation(
                ExternalSourceOperationErrorCode::InvalidRequest,
                format!("The Codex workspace is unavailable: {error}"),
                false,
            )
        })
}

async fn annotate_catalog(
    catalog: &mut openbitfun_product_domains::session_import::ExternalSessionCatalog,
) -> ExternalSourceOperationResult<()> {
    let service = crate::service::workspace::get_global_workspace_service().ok_or_else(|| {
        operation(
            ExternalSourceOperationErrorCode::Unavailable,
            "Workspace service is unavailable",
            true,
        )
    })?;
    let workspaces = service.list_workspace_infos().await;
    let mut candidates: Vec<_> = catalog
        .candidates
        .iter_mut()
        .chain(
            catalog
                .workspaces
                .iter_mut()
                .flatten()
                .flat_map(|group| group.candidates.iter_mut()),
        )
        .collect();
    for candidate in &mut candidates {
        let Some(source_path) = candidate.cwd.as_deref().filter(|path| !path.is_empty()) else {
            continue;
        };
        let Some(workspace) = matching_workspace(&workspaces, Path::new(source_path)) else {
            continue;
        };
        candidate.target_workspace_id = Some(workspace.id.clone());
        candidate.target_workspace_name = Some(workspace.name.clone());
    }
    let mut imported_by_workspace: HashMap<String, HashMap<String, String>> = HashMap::new();
    for workspace in workspaces.iter().filter(|workspace| {
        candidates.iter().any(|candidate| {
            candidate.target_workspace_id.as_deref() == Some(workspace.id.as_str())
        })
    }) {
        let (store, _) = import_storage(workspace).await?;
        let metadata = store
            .list_metadata_including_internal()
            .await
            .map_err(|error| {
                operation(
                    ExternalSourceOperationErrorCode::Internal,
                    format!("Failed to inspect imported Codex Sessions: {error}"),
                    true,
                )
            })?;
        let imported = metadata
            .into_iter()
            .filter_map(|metadata| {
                if metadata.workspace_id.as_deref() != Some(workspace.id.as_str()) {
                    return None;
                }
                let custom = metadata.custom_metadata.as_ref()?;
                if custom
                    .get("importedFrom")
                    .and_then(serde_json::Value::as_str)
                    != Some("codex")
                {
                    return None;
                }
                let source_id = custom
                    .get("sourceSessionId")
                    .and_then(serde_json::Value::as_str)?;
                Some((source_id.to_string(), metadata.session_id))
            })
            .collect::<HashMap<_, _>>();
        imported_by_workspace.insert(workspace.id.clone(), imported);
    }
    for candidate in &mut candidates {
        let Some(workspace_id) = candidate.target_workspace_id.as_deref() else {
            continue;
        };
        candidate.imported_session_id = imported_by_workspace
            .get(workspace_id)
            .and_then(|sessions| sessions.get(&candidate.source_session_id))
            .cloned();
    }
    Ok(())
}

async fn import_storage(
    workspace: &crate::service::workspace::WorkspaceInfo,
) -> ExternalSourceOperationResult<(
    OfflineSessionImportStore,
    crate::service::workspace::WorkspaceInfo,
)> {
    let resolution = crate::agentic::session::CoreSessionStorePort::default()
        .resolve_workspace_storage(&workspace.id)
        .await
        .map_err(|error| {
            operation(
                ExternalSourceOperationErrorCode::Unavailable,
                error.to_string(),
                true,
            )
        })?;
    let project_id = workspace.project_workspace_id().map_err(|error| {
        operation(
            ExternalSourceOperationErrorCode::InvalidRequest,
            error,
            false,
        )
    })?;
    let project = if project_id == workspace.id {
        workspace.clone()
    } else {
        let service =
            crate::service::workspace::get_global_workspace_service().ok_or_else(|| {
                operation(
                    ExternalSourceOperationErrorCode::Unavailable,
                    "Workspace service is unavailable",
                    true,
                )
            })?;
        service
            .require_workspace(project_id)
            .await
            .map_err(|error| {
                operation(
                    ExternalSourceOperationErrorCode::Unavailable,
                    error.to_string(),
                    true,
                )
            })?
    };
    Ok((
        OfflineSessionImportStore::new(resolution.effective_storage_path),
        project,
    ))
}

fn matching_workspace<'a>(
    workspaces: &'a [crate::service::workspace::WorkspaceInfo],
    source: &Path,
) -> Option<&'a crate::service::workspace::WorkspaceInfo> {
    let source = normalized_path(source);
    workspaces
        .iter()
        .filter(|workspace| {
            workspace.workspace_kind != crate::service::workspace::WorkspaceKind::Remote
        })
        .filter_map(|workspace| {
            let root = normalized_path(&workspace.root_path);
            let matches = source == root || source.starts_with(&(root.clone() + "/"));
            matches.then_some((root.len(), workspace))
        })
        .max_by_key(|(length, _)| *length)
        .map(|(_, workspace)| workspace)
}

fn normalized_path(path: &Path) -> String {
    let path = dunce::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    if cfg!(windows) {
        path.to_ascii_lowercase()
    } else {
        path
    }
}

fn build_plan(
    workspace_id: &str,
    workspace_name: &str,
    workspace_root: &Path,
    mut document: CodexSessionDocument,
    mode: ExternalSessionImportMode,
) -> ExternalSessionImportPlan {
    let mapping = document
        .candidate
        .cwd
        .as_deref()
        .map(|source| {
            let source = dunce::canonicalize(source).unwrap_or_else(|_| source.into());
            let target = dunce::canonicalize(workspace_root)
                .unwrap_or_else(|_| workspace_root.to_path_buf());
            if source == target || source.starts_with(target) {
                ExternalSessionWorkspaceMapping::Exact
            } else {
                ExternalSessionWorkspaceMapping::Unsupported
            }
        })
        .unwrap_or(ExternalSessionWorkspaceMapping::MissingSourcePath);
    document.candidate.target_workspace_id = Some(workspace_id.to_string());
    document.candidate.target_workspace_name = Some(workspace_name.to_string());
    let turns = document
        .turns
        .iter()
        .enumerate()
        .map(|(index, turn)| openbitfun_product_domains::session_import::ExternalSessionTurnPreview {
            source_turn_id: turn.source_turn_id.clone(),
            turn_index: index,
            user_preview: crate::external_session_import::preview(&turn.user_text, 240),
            assistant_preview: turn
                .items
                .iter()
                .filter_map(|item| match item {
                    openbitfun_product_domains::session_import::ExternalSessionItem::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .next()
                .map(|text| preview(text, 240)),
            tool_call_count: turn
                .items
                .iter()
                .filter(|item| matches!(item, openbitfun_product_domains::session_import::ExternalSessionItem::Tool { .. }))
                .count(),
            source_event_count: turn.source_event_count,
            status: turn.status,
            estimated_bytes: serde_json::to_vec(turn).map(|bytes| bytes.len() as u64).unwrap_or(0),
        })
        .collect::<Vec<_>>();
    let mut hasher = Sha256::new();
    hasher.update(document.candidate.fingerprint.as_bytes());
    hasher.update(workspace_id.as_bytes());
    hasher.update(format!("{mode:?}").as_bytes());
    let plan_fingerprint = format!("sha256:{}", hex::encode(hasher.finalize()));
    let estimated_storage_bytes = turns.iter().map(|turn| turn.estimated_bytes).sum();
    ExternalSessionImportPlan {
        schema_version: EXTERNAL_SESSION_IMPORT_SCHEMA_V1,
        plan_fingerprint,
        candidate: document.candidate,
        target_workspace_id: workspace_id.to_string(),
        workspace_mapping: mapping,
        turns,
        estimated_storage_bytes,
        warnings: document.warnings,
    }
}

fn convert_document(
    session_id: &str,
    workspace: &crate::service::workspace::WorkspaceInfo,
    project: &crate::service::workspace::WorkspaceInfo,
    agent_id: &str,
    session_name: &str,
    document: &CodexSessionDocument,
    include_tool_history: bool,
    include_thinking: bool,
) -> ExternalSourceOperationResult<OfflineSessionBundle> {
    // The source model is retained on the imported rounds and provenance
    // metadata, while continuation uses the target host's configured primary
    // model instead of assuming the source model exists locally.
    let model_name = "primary".to_string();
    let mut metadata = SessionMetadata::new(
        session_id.to_string(),
        session_name.to_string(),
        agent_id.to_string(),
        model_name,
    );
    metadata.workspace_id = Some(workspace.id.clone());
    metadata.workspace_path = Some(workspace.root_path.to_string_lossy().to_string());
    metadata.project_workspace_id = Some(project.id.clone());
    metadata.project_workspace_path = Some(project.root_path.to_string_lossy().to_string());
    metadata.memory_mode = SessionMemoryMode::Disabled;
    metadata.status = SessionStatus::Completed;
    metadata.custom_metadata = Some(json!({
        "importedFrom": "codex",
        "sourceSessionId": document.candidate.source_session_id,
        "sourceFingerprint": document.candidate.fingerprint,
        "sourceFormat": "codex-rollout-jsonl",
        "sourceRevision": SOURCE_REVISION,
        "sourceCwd": document.candidate.cwd,
        "sourceModelProvider": document.candidate.model_provider,
        "sourceModel": document.candidate.model_name,
        "continuationMode": "openbitfun_local"
    }));

    let mut turns = Vec::with_capacity(document.turns.len());
    for (turn_index, source) in document.turns.iter().enumerate() {
        let turn_id = format!("{session_id}-turn-{turn_index}");
        let timestamp = if source.timestamp == 0 {
            current_time_ms()
        } else {
            source.timestamp
        };
        let mut turn = DialogTurnData::new_with_kind(
            openbitfun_services_core::session::DialogTurnKind::UserDialog,
            turn_id.clone(),
            turn_index,
            session_id.to_string(),
            Some(agent_id.to_string()),
            UserMessageData {
                id: format!("{turn_id}-user"),
                content: source.user_text.clone(),
                timestamp,
                metadata: Some(
                    json!({"importedFrom":"codex","sourceTurnId":source.source_turn_id}),
                ),
            },
        );
        turn.timestamp = timestamp;
        turn.start_time = timestamp;
        let mut round = ModelRoundData {
            id: format!("{turn_id}-round-0"),
            turn_id: turn_id.clone(),
            round_index: 0,
            round_group_id: None,
            timestamp,
            text_items: Vec::new(),
            tool_items: Vec::new(),
            thinking_items: Vec::new(),
            start_time: timestamp,
            end_time: Some(timestamp),
            duration_ms: Some(0),
            provider_id: document.candidate.model_provider.clone(),
            model_config_id: None,
            effective_model_name: document.candidate.model_name.clone(),
            first_chunk_ms: None,
            first_visible_output_ms: None,
            stream_duration_ms: None,
            attempt_count: None,
            attempt_diagnostics: Vec::new(),
            failure_category: None,
            token_details: None,
            status: "completed".to_string(),
        };
        let mut order = 0usize;
        for item in &source.items {
            match item {
                openbitfun_product_domains::session_import::ExternalSessionItem::Text { text } => {
                    round.text_items.push(TextItemData {
                        id: format!("{turn_id}-text-{order}"),
                        content: text.clone(),
                        is_streaming: false,
                        timestamp,
                        is_markdown: true,
                        order_index: Some(order),
                        is_subagent_item: None,
                        parent_task_tool_id: None,
                        subagent_session_id: None,
                        status: Some("completed".to_string()),
                        attempt_id: None,
                        attempt_index: None,
                    });
                }
                openbitfun_product_domains::session_import::ExternalSessionItem::Thinking {
                    text,
                } if include_thinking => {
                    round.thinking_items.push(ThinkingItemData {
                        id: format!("{turn_id}-thinking-{order}"),
                        content: text.clone(),
                        reasoning_kind: None,
                        is_streaming: false,
                        is_collapsed: true,
                        timestamp,
                        order_index: Some(order),
                        status: Some("completed".to_string()),
                        is_subagent_item: None,
                        parent_task_tool_id: None,
                        subagent_session_id: None,
                        attempt_id: None,
                        attempt_index: None,
                    });
                }
                openbitfun_product_domains::session_import::ExternalSessionItem::Thinking {
                    ..
                } => {}
                openbitfun_product_domains::session_import::ExternalSessionItem::Tool {
                    id,
                    name,
                    input,
                    result,
                    success,
                } if include_tool_history => {
                    round.tool_items.push(ToolItemData {
                        id: format!("{turn_id}-tool-{order}"),
                        tool_name: name.clone(),
                        tool_call: ToolCallData {
                            input: input.clone(),
                            id: id.clone(),
                        },
                        tool_result: result.clone().map(|result| ToolResultData {
                            result,
                            success: success.unwrap_or(true),
                            result_for_assistant: None,
                            image_attachments: None,
                            error: None,
                            duration_ms: None,
                        }),
                        ai_intent: None,
                        start_time: timestamp,
                        end_time: Some(timestamp),
                        duration_ms: Some(0),
                        queue_wait_ms: None,
                        preflight_ms: None,
                        confirmation_wait_ms: None,
                        execution_ms: None,
                        order_index: Some(order),
                        is_subagent_item: None,
                        parent_task_tool_id: None,
                        subagent_session_id: None,
                        subagent_dialog_turn_id: None,
                        attempt_id: None,
                        attempt_index: None,
                        subagent_model_id: None,
                        subagent_model_display_name: None,
                        status: Some(
                            if success.unwrap_or(true) {
                                "completed"
                            } else {
                                "error"
                            }
                            .to_string(),
                        ),
                        interruption_reason: None,
                    });
                }
                openbitfun_product_domains::session_import::ExternalSessionItem::Tool {
                    ..
                } => {}
            }
            order += 1;
        }
        turn.model_rounds.push(round);
        turn.end_time = Some(timestamp);
        turn.duration_ms = Some(0);
        turn.has_final_response = Some(source.items.iter().any(|item| {
            matches!(
                item,
                openbitfun_product_domains::session_import::ExternalSessionItem::Text { .. }
            )
        }));
        turn.status = match source.status {
            openbitfun_product_domains::session_import::ExternalSessionStatus::Interrupted => {
                TurnStatus::Cancelled
            }
            openbitfun_product_domains::session_import::ExternalSessionStatus::Corrupt => {
                TurnStatus::Error
            }
            _ => TurnStatus::Completed,
        };
        turns.push(turn);
    }
    metadata.turn_count = turns.len();
    metadata.message_count = turns.len()
        + turns
            .iter()
            .map(|turn| {
                turn.model_rounds
                    .iter()
                    .map(|round| round.text_items.len())
                    .sum::<usize>()
            })
            .sum::<usize>();
    metadata.tool_call_count = turns.iter().map(DialogTurnData::count_tool_calls).sum();
    metadata.last_active_at = turns
        .last()
        .and_then(|turn| turn.end_time)
        .unwrap_or_else(current_time_ms);
    metadata.last_finished_at = Some(metadata.last_active_at);
    Ok(OfflineSessionBundle { metadata, turns })
}

fn current_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn preview(value: &str, chars: usize) -> String {
    value.chars().take(chars).collect()
}

fn operation(
    code: ExternalSourceOperationErrorCode,
    detail: impl Into<String>,
    retryable: bool,
) -> ExternalSourceOperationError {
    ExternalSourceOperationError::new(code, detail, retryable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::workspace::{WorkspaceInfo, WorkspaceKind};

    #[test]
    fn cancelled_plan_cannot_be_applied() {
        let id = Uuid::new_v4().to_string();
        let mut plan = ImportOperation::start(&id).unwrap();
        assert!(cancel_codex_session_import(&id));
        assert!(plan.check().is_err());
        plan.keep_for_apply = true;
        drop(plan);
        assert!(ImportOperation::resume(&id).is_err());
    }

    #[test]
    fn cancellation_reaches_an_active_apply_and_prevents_duplicate_apply() {
        let id = Uuid::new_v4().to_string();
        let mut plan = ImportOperation::start(&id).unwrap();
        plan.keep_for_apply = true;
        drop(plan);
        let applying = ImportOperation::resume(&id).unwrap();
        assert!(ImportOperation::resume(&id).is_err());
        assert!(cancel_codex_session_import(&id));
        assert!(applying.is_cancelled());
        drop(applying);
        assert!(!cancel_codex_session_import(&id));
    }

    #[test]
    fn failed_plan_releases_its_operation() {
        let id = Uuid::new_v4().to_string();
        drop(ImportOperation::start(&id).unwrap());
        assert!(ImportOperation::resume(&id).is_err());
    }

    fn workspace(id: &str, root: &Path, kind: WorkspaceKind) -> WorkspaceInfo {
        serde_json::from_value(json!({
            "id": id,
            "name": id,
            "rootPath": root,
            "workspaceType": "Other",
            "workspaceKind": kind,
            "status": "Inactive",
            "languages": [],
            "openedAt": "2026-01-01T00:00:00Z",
            "lastAccessed": "2026-01-01T00:00:00Z",
            "tags": [],
            "metadata": {}
        }))
        .unwrap()
    }

    #[test]
    fn source_directory_selects_the_nearest_registered_workspace() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let nested = project.join("nested");
        let source = nested.join("src");
        std::fs::create_dir_all(&source).unwrap();
        let workspaces = vec![
            workspace(
                "unrelated",
                &root.path().join("other"),
                WorkspaceKind::Normal,
            ),
            workspace("project", &project, WorkspaceKind::Normal),
            workspace("nested", &nested, WorkspaceKind::Normal),
        ];

        assert_eq!(
            matching_workspace(&workspaces, &source).unwrap().id,
            "nested"
        );
    }

    #[test]
    fn similarly_named_directory_does_not_reuse_an_unrelated_workspace() {
        let root = tempfile::tempdir().unwrap();
        let workspaces = vec![workspace(
            "project",
            &root.path().join("project"),
            WorkspaceKind::Normal,
        )];

        assert!(matching_workspace(&workspaces, &root.path().join("project-other")).is_none());
    }

    #[test]
    fn remote_workspace_path_never_claims_a_local_codex_session() {
        let root = tempfile::tempdir().unwrap();
        let workspaces = vec![workspace("remote", root.path(), WorkspaceKind::Remote)];

        assert!(matching_workspace(&workspaces, root.path()).is_none());
    }

    #[test]
    fn imported_worktree_session_preserves_execution_and_project_ownership() {
        let root = tempfile::tempdir().unwrap();
        let project = workspace(
            "project",
            &root.path().join("project"),
            WorkspaceKind::Normal,
        );
        let execution = workspace(
            "worktree",
            &root.path().join("worktree"),
            WorkspaceKind::Normal,
        );
        let document = CodexSessionDocument {
            candidate: serde_json::from_value(json!({
                "candidateId": "source", "ecosystemId": "codex", "sourceSessionId": "source",
                "fileSizeBytes": 1, "status": "complete", "fingerprint": "test"
            }))
            .unwrap(),
            turns: Vec::new(),
            warnings: Vec::new(),
        };

        let bundle = convert_document(
            "imported", &execution, &project, "primary", "Imported", &document, true, false,
        )
        .unwrap();

        assert_eq!(bundle.metadata.workspace_id.as_deref(), Some("worktree"));
        assert_eq!(
            bundle.metadata.project_workspace_id.as_deref(),
            Some("project")
        );
        assert_eq!(
            bundle.metadata.workspace_path,
            Some(execution.root_path.to_string_lossy().into_owned())
        );
        assert_eq!(
            bundle.metadata.project_workspace_path,
            Some(project.root_path.to_string_lossy().into_owned())
        );
    }
}
