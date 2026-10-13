//! Product contracts for importing external agent sessions.
//!
//! These DTOs deliberately describe the import boundary only. Ecosystem
//! adapters own their source formats; Assembly owns conversion into the
//! OpenBitFun Session storage model.

use serde::{Deserialize, Serialize};

pub const EXTERNAL_SESSION_IMPORT_SCHEMA_V1: u32 = 1;
pub const EXTERNAL_SESSION_IMPORT_ECOSYSTEM_CODEX: &str = "codex";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalSessionStatus {
    Complete,
    Interrupted,
    Unsupported,
    Corrupt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalSessionWorkspaceMapping {
    Exact,
    UserSelected,
    MissingSourcePath,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSessionCandidate {
    pub candidate_id: String,
    pub ecosystem_id: String,
    pub source_session_id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub created_at: Option<u64>,
    pub updated_at: Option<u64>,
    pub model_provider: Option<String>,
    pub model_name: Option<String>,
    pub turn_count: Option<usize>,
    pub file_size_bytes: u64,
    pub format_version: Option<String>,
    pub status: ExternalSessionStatus,
    pub fingerprint: String,
    /// A display-only path label. The raw host path is never required from a
    /// client in order to apply an import.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_location: Option<String>,
    /// The tracked local workspace that owns the source working directory.
    /// This is resolved by the host, never inferred from the active UI
    /// workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_workspace_name: Option<String>,
    /// Existing OpenBitFun session created from this source rollout, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSessionTurnPreview {
    pub source_turn_id: String,
    pub turn_index: usize,
    pub user_preview: String,
    pub assistant_preview: Option<String>,
    pub tool_call_count: usize,
    pub source_event_count: usize,
    pub status: ExternalSessionStatus,
    pub estimated_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSessionImportWarning {
    pub code: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSessionImportPlan {
    pub schema_version: u32,
    pub plan_fingerprint: String,
    pub candidate: ExternalSessionCandidate,
    pub target_workspace_id: String,
    pub workspace_mapping: ExternalSessionWorkspaceMapping,
    pub turns: Vec<ExternalSessionTurnPreview>,
    pub estimated_storage_bytes: u64,
    pub warnings: Vec<ExternalSessionImportWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSessionImportRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub schema_version: u32,
    pub plan_fingerprint: String,
    pub candidate_id: String,
    pub target_workspace_id: String,
    pub agent_id: String,
    pub session_title: Option<String>,
    #[serde(default = "default_true")]
    pub include_tool_history: bool,
    #[serde(default)]
    pub include_thinking: bool,
    #[serde(default = "default_full_import_mode")]
    pub mode: ExternalSessionImportMode,
}

fn default_true() -> bool {
    true
}

fn default_full_import_mode() -> ExternalSessionImportMode {
    ExternalSessionImportMode::Full
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSessionImportApplied {
    pub schema_version: u32,
    pub session_id: String,
    pub imported_turn_count: usize,
    pub warning_codes: Vec<String>,
    pub already_imported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSessionCatalog {
    pub schema_version: u32,
    pub ecosystem_id: String,
    pub source_revision: String,
    pub candidates: Vec<ExternalSessionCandidate>,
    pub diagnostics: Vec<ExternalSessionImportWarning>,
    pub next_cursor: Option<usize>,
    /// Present only for workspace-scoped discovery. Legacy flat pages retain
    /// their original wire shape and cursor semantics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspaces: Option<Vec<ExternalSessionWorkspaceGroup>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExternalSessionCatalogScope {
    Workspaces { preview_limit: usize },
    Workspace { workspace_key: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSessionWorkspaceGroup {
    /// Stable source identity, independent of registration in OpenBitFun.
    pub workspace_key: String,
    pub cwd: Option<String>,
    pub total_count: usize,
    pub candidates: Vec<ExternalSessionCandidate>,
    /// A session cursor within this workspace, never a global session offset.
    pub next_cursor: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalSessionImportMode {
    #[default]
    Full,
    LatestCompacted,
}

/// Neutral, non-executable history supplied by an ecosystem reader.
#[derive(Clone, Serialize)]
pub struct ExternalSessionTurn {
    pub source_turn_id: String,
    pub timestamp: u64,
    pub user_text: String,
    pub items: Vec<ExternalSessionItem>,
    pub source_event_count: usize,
    pub status: ExternalSessionStatus,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExternalSessionItem {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    Tool {
        id: String,
        name: String,
        input: serde_json::Value,
        result: Option<serde_json::Value>,
        success: Option<bool>,
    },
}

#[derive(Clone)]
pub struct CodexSessionDocument {
    pub candidate: ExternalSessionCandidate,
    pub turns: Vec<ExternalSessionTurn>,
    pub warnings: Vec<ExternalSessionImportWarning>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_flat_catalog_round_trips_without_workspace_pagination_fields() {
        let legacy = serde_json::json!({
            "schemaVersion": 1, "ecosystemId": "codex", "sourceRevision": "v1",
            "candidates": [], "diagnostics": [], "nextCursor": 50
        });
        let catalog: ExternalSessionCatalog = serde_json::from_value(legacy.clone()).unwrap();
        assert!(catalog.workspaces.is_none());
        assert_eq!(serde_json::to_value(catalog).unwrap(), legacy);
    }

    #[test]
    fn workspace_scope_uses_distinct_typed_cursor_contracts() {
        let scope: ExternalSessionCatalogScope = serde_json::from_value(serde_json::json!({
            "kind": "workspaces", "previewLimit": 5
        }))
        .unwrap();
        assert!(matches!(
            scope,
            ExternalSessionCatalogScope::Workspaces { preview_limit: 5 }
        ));
        let source = serde_json::json!({ "kind": "workspace", "workspaceKey": "source" });
        let scope: ExternalSessionCatalogScope = serde_json::from_value(source.clone()).unwrap();
        assert_eq!(serde_json::to_value(scope).unwrap(), source);
    }

    #[test]
    fn import_request_defaults_to_including_tool_history() {
        let request: ExternalSessionImportRequest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "planFingerprint": "sha256:test",
            "candidateId": "codex:test",
            "targetWorkspaceId": "workspace-1",
            "agentId": "code"
        }))
        .expect("request should deserialize");
        assert!(request.include_tool_history);
        assert!(!request.include_thinking);
        assert!(request.operation_id.is_none());
        assert_eq!(request.mode, ExternalSessionImportMode::Full);
    }

    #[test]
    fn legacy_candidate_round_trips_without_workspace_annotations() {
        let legacy = serde_json::json!({
            "candidateId": "codex:session", "ecosystemId": "codex",
            "sourceSessionId": "session", "title": null, "cwd": "/project",
            "createdAt": null, "updatedAt": null, "modelProvider": null,
            "modelName": null, "turnCount": null, "fileSizeBytes": 120,
            "formatVersion": null, "status": "complete", "fingerprint": "sha256:test"
        });
        let candidate: ExternalSessionCandidate = serde_json::from_value(legacy.clone()).unwrap();
        assert!(candidate.target_workspace_id.is_none());
        assert!(candidate.target_workspace_name.is_none());
        assert!(candidate.imported_session_id.is_none());
        assert_eq!(serde_json::to_value(candidate).unwrap(), legacy);
    }

    #[test]
    fn explicit_legacy_import_mode_remains_readable() {
        let legacy = serde_json::json!({
            "schemaVersion": 1, "planFingerprint": "sha256:test",
            "candidateId": "codex:test", "targetWorkspaceId": "workspace-1",
            "agentId": "code", "sessionTitle": null,
            "includeToolHistory": true, "includeThinking": false,
            "mode": "latest_compacted"
        });
        let request: ExternalSessionImportRequest = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(request.mode, ExternalSessionImportMode::LatestCompacted);
        assert_eq!(serde_json::to_value(request).unwrap(), legacy);
    }
}
