//! Import and local continuation of external Agent sessions.

use openbitfun_codex_adapter::session::{CodexSessionReader, SOURCE_REVISION};
use openbitfun_product_domains::external_sources::{
    ExternalSourceOperationError, ExternalSourceOperationErrorCode, ExternalSourceOperationResult,
};
use openbitfun_product_domains::session_import::{
    CodexSessionDocument, ExternalSessionImportApplied, ExternalSessionImportMode,
    ExternalSessionImportPlan, ExternalSessionImportRequest, ExternalSessionWorkspaceMapping,
    EXTERNAL_SESSION_IMPORT_SCHEMA_V1,
};
use openbitfun_services_core::session::{
    DialogTurnData, ModelRoundData, OfflineSessionBundle, OfflineSessionImportStore,
    SessionMemoryMode, SessionMetadata, SessionStatus, TextItemData, ThinkingItemData,
    ToolCallData, ToolItemData, ToolResultData, TurnStatus, UserMessageData,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::Path;
use uuid::Uuid;

const MAX_LIST_LIMIT: usize = 50;

pub async fn list_codex_sessions(
    cursor: usize,
    limit: usize,
    query: &str,
) -> ExternalSourceOperationResult<openbitfun_product_domains::session_import::ExternalSessionCatalog>
{
    let reader = CodexSessionReader::default();
    let query = query.to_owned();
    tokio::task::spawn_blocking(move || reader.discover(cursor, limit.min(MAX_LIST_LIMIT), &query))
        .await
        .map_err(|error| {
            operation(
                ExternalSourceOperationErrorCode::Internal,
                error.to_string(),
                true,
            )
        })?
        .map_err(|error| operation(ExternalSourceOperationErrorCode::Unavailable, error, true))
}

pub async fn plan_codex_session_import(
    workspace_id: &str,
    candidate_id: &str,
    mode: ExternalSessionImportMode,
) -> ExternalSourceOperationResult<ExternalSessionImportPlan> {
    let workspace = local_workspace(workspace_id).await?;
    let reader = CodexSessionReader::default();
    let candidate_id = candidate_id.to_owned();
    let document = tokio::task::spawn_blocking(move || reader.read_candidate(&candidate_id, mode))
        .await
        .map_err(|error| {
            operation(
                ExternalSourceOperationErrorCode::Internal,
                error.to_string(),
                true,
            )
        })?
        .map_err(|error| operation(ExternalSourceOperationErrorCode::NotFound, error, false))?;
    Ok(build_plan(
        workspace_id,
        &workspace.root_path,
        document,
        mode,
    ))
}

pub async fn apply_codex_session_import(
    request: ExternalSessionImportRequest,
) -> ExternalSourceOperationResult<ExternalSessionImportApplied> {
    if request.schema_version != EXTERNAL_SESSION_IMPORT_SCHEMA_V1 {
        return Err(operation(
            ExternalSourceOperationErrorCode::IncompatibleVersion,
            "Unsupported external Session import schema",
            false,
        ));
    }
    let workspace = local_workspace(&request.target_workspace_id).await?;
    let reader = CodexSessionReader::default();
    let candidate_id = request.candidate_id.clone();
    let mode = request.mode;
    let document = tokio::task::spawn_blocking(move || reader.read_candidate(&candidate_id, mode))
        .await
        .map_err(|error| {
            operation(
                ExternalSourceOperationErrorCode::Internal,
                error.to_string(),
                true,
            )
        })?
        .map_err(|error| operation(ExternalSourceOperationErrorCode::NotFound, error, false))?;
    let plan = build_plan(
        &request.target_workspace_id,
        &workspace.root_path,
        document.clone(),
        request.mode,
    );
    if plan.plan_fingerprint != request.plan_fingerprint {
        return Err(operation(
            ExternalSourceOperationErrorCode::StaleRevision,
            "Codex Session changed; refresh the import preview",
            true,
        ));
    }

    let sessions_root =
        crate::infrastructure::get_path_manager_arc().project_sessions_dir(&workspace.root_path);
    let store = OfflineSessionImportStore::new(sessions_root);
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
        &request.target_workspace_id,
        &workspace.root_path,
        &request.agent_id,
        &session_name,
        &document,
        request.include_tool_history,
        request.include_thinking,
    )?;

    store.write_bundle_atomic(&bundle).await.map_err(|error| {
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

async fn local_workspace(
    workspace_id: &str,
) -> ExternalSourceOperationResult<crate::service::workspace::WorkspaceInfo> {
    let service = crate::service::workspace::get_global_workspace_service().ok_or_else(|| {
        operation(
            ExternalSourceOperationErrorCode::Unavailable,
            "Workspace service is unavailable",
            true,
        )
    })?;
    let workspace = service
        .require_workspace(workspace_id)
        .await
        .map_err(|error| {
            operation(
                ExternalSourceOperationErrorCode::InvalidRequest,
                error.to_string(),
                false,
            )
        })?;
    if workspace.workspace_kind == crate::service::workspace::WorkspaceKind::Remote {
        return Err(operation(
            ExternalSourceOperationErrorCode::Unsupported,
            "Codex Session import is currently available only for local workspaces",
            false,
        ));
    }
    Ok(workspace)
}

fn build_plan(
    workspace_id: &str,
    workspace_root: &Path,
    document: CodexSessionDocument,
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
            if source == target {
                ExternalSessionWorkspaceMapping::Exact
            } else {
                ExternalSessionWorkspaceMapping::UserSelected
            }
        })
        .unwrap_or(ExternalSessionWorkspaceMapping::MissingSourcePath);
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
    workspace_id: &str,
    workspace_root: &Path,
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
    metadata.workspace_id = Some(workspace_id.to_string());
    metadata.workspace_path = Some(workspace_root.to_string_lossy().to_string());
    metadata.project_workspace_path = metadata.workspace_path.clone();
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
