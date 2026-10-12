use openbitfun_core::external_session_import::{
    apply_codex_session_import, list_codex_sessions, plan_codex_session_import,
};
use openbitfun_product_domains::external_sources::ExternalSourceOperationResult;
use openbitfun_product_domains::session_import::{
    ExternalSessionCatalog, ExternalSessionImportApplied, ExternalSessionImportMode,
    ExternalSessionImportPlan, ExternalSessionImportRequest,
};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListExternalSessionImportRequest {
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
    pub workspace_id: String,
    pub candidate_id: String,
    #[serde(default)]
    pub mode: ExternalSessionImportMode,
}

#[tauri::command]
pub async fn list_external_session_import_candidates(
    request: ListExternalSessionImportRequest,
) -> ExternalSourceOperationResult<ExternalSessionCatalog> {
    list_codex_sessions(request.cursor, request.limit, &request.query).await
}

#[tauri::command]
pub async fn plan_external_session_import(
    request: PlanExternalSessionImportRequest,
) -> ExternalSourceOperationResult<ExternalSessionImportPlan> {
    plan_codex_session_import(&request.workspace_id, &request.candidate_id, request.mode).await
}

#[tauri::command]
pub async fn apply_external_session_import(
    request: ExternalSessionImportRequest,
) -> ExternalSourceOperationResult<ExternalSessionImportApplied> {
    apply_codex_session_import(request).await
}
