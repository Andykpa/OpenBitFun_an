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
    #[serde(default)]
    pub mode: ExternalSessionImportMode,
}

fn default_true() -> bool {
    true
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalSessionImportMode {
    Full,
    #[default]
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
    }
}
