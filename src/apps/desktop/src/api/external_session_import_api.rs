use openbitfun_core::external_session_import::{
    apply_external_session_import as apply_import, cancel_external_session_import as cancel_import,
    list_external_sessions, plan_external_session_import as plan_import,
};
use openbitfun_product_domains::external_sources::ExternalSourceOperationResult;
use openbitfun_product_domains::session_import::{
    ExternalSessionCatalog, ExternalSessionCatalogScope, ExternalSessionImportApplied,
    ExternalSessionImportMode, ExternalSessionImportPlan, ExternalSessionImportRequest,
};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListExternalSessionImportRequest {
    #[serde(default)]
    pub ecosystem_id: Option<String>,
    #[serde(default)]
    pub scope: Option<ExternalSessionCatalogScope>,
    #[serde(default)]
    pub cursor: usize,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub query: String,
}

fn default_limit() -> usize {
    50
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanExternalSessionImportRequest {
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub candidate_id: String,
    #[serde(default = "default_full_mode")]
    pub mode: ExternalSessionImportMode,
}

fn default_full_mode() -> ExternalSessionImportMode {
    ExternalSessionImportMode::Full
}

#[tauri::command]
pub async fn list_external_session_import_candidates(
    request: ListExternalSessionImportRequest,
) -> ExternalSourceOperationResult<ExternalSessionCatalog> {
    list_external_sessions(
        request.ecosystem_id.as_deref().unwrap_or("codex"),
        request.cursor,
        request.limit,
        &request.query,
        request.scope,
    )
    .await
}

#[tauri::command]
pub async fn plan_external_session_import(
    request: PlanExternalSessionImportRequest,
) -> ExternalSourceOperationResult<ExternalSessionImportPlan> {
    plan_import(
        request.workspace_id.as_deref(),
        &request.candidate_id,
        request.mode,
        request.operation_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn apply_external_session_import(
    request: ExternalSessionImportRequest,
) -> ExternalSourceOperationResult<ExternalSessionImportApplied> {
    apply_import(request).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelExternalSessionImportRequest {
    pub operation_id: String,
}

#[tauri::command]
pub fn cancel_external_session_import(request: CancelExternalSessionImportRequest) -> bool {
    cancel_import(&request.operation_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_list_request_retains_flat_catalog_defaults() {
        let request: ListExternalSessionImportRequest =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(request.scope.is_none());
        assert!(request.ecosystem_id.is_none());
        assert_eq!(request.cursor, 0);
        assert_eq!(request.limit, 50);
        assert!(request.query.is_empty());
    }

    #[test]
    fn workspace_list_requests_keep_the_two_cursor_scopes_distinct() {
        let request: ListExternalSessionImportRequest = serde_json::from_value(serde_json::json!({
            "cursor": 5, "limit": 5, "scope": { "kind": "workspaces", "previewLimit": 5 }
        }))
        .unwrap();
        assert_eq!(request.cursor, 5);
        assert!(matches!(
            request.scope,
            Some(ExternalSessionCatalogScope::Workspaces { preview_limit: 5 })
        ));
        let request: ListExternalSessionImportRequest = serde_json::from_value(serde_json::json!({
            "cursor": 30, "limit": 25, "scope": { "kind": "workspace", "workspaceKey": "source" }
        }))
        .unwrap();
        assert_eq!(request.cursor, 30);
        assert!(
            matches!(request.scope, Some(ExternalSessionCatalogScope::Workspace { workspace_key }) if workspace_key == "source")
        );
    }

    #[test]
    fn zcode_discovery_keeps_an_explicit_ecosystem_separate_from_legacy_codex_requests() {
        let request: ListExternalSessionImportRequest = serde_json::from_value(serde_json::json!({
            "ecosystemId": "zcode", "scope": { "kind": "workspaces", "previewLimit": 5 }
        }))
        .unwrap();
        assert_eq!(request.ecosystem_id.as_deref(), Some("zcode"));
        assert_eq!(request.cursor, 0);
    }
}
