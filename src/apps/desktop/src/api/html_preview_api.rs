//! Controller-owned HTTP gateway for workspace HTML, including SSH and peer hosts.

use crate::api::app_state::AppState;
use crate::api::remote_connect_api::{
    account_context_generation, account_context_is_current, account_device_rpc,
};
use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, Method, StatusCode, Uri},
    response::Response,
    routing::any,
    Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use openbitfun_core::service::filesystem::html_preview::resolve_html_preview_source;
use openbitfun_product_domains::{
    html_preview::{
        HtmlPreviewError, HtmlPreviewErrorCode as Code, HtmlPreviewResource,
        HtmlPreviewResourceReply, HtmlPreviewResourceRequest, MAX_PREVIEW_BYTES,
        PREVIEW_CHUNK_BYTES,
    },
    remote_surface::PeerHostCapability,
};
use openbitfun_services_integrations::remote_connect::{
    html_preview::HtmlPreviewSource, RemoteCommand, RemoteResponse,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::{net::TcpListener, sync::watch};
use uuid::Uuid;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPreviewCreateRequest {
    pub file_path: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Temporary pre-ID wire fields; current clients send workspaceId.
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub peer_device_mode: bool,
    #[serde(default)]
    pub peer_device_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPreviewCreateResponse {
    pub url: String,
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPreviewReleaseRequest {
    pub session_id: String,
}

#[async_trait::async_trait]
trait PreviewReader: Send + Sync {
    fn is_current(&self) -> bool {
        true
    }
    async fn read(
        &self,
        request: &HtmlPreviewResourceRequest,
    ) -> Result<HtmlPreviewResource, HtmlPreviewError>;
}

#[async_trait::async_trait]
impl PreviewReader for HtmlPreviewSource {
    async fn read(
        &self,
        request: &HtmlPreviewResourceRequest,
    ) -> Result<HtmlPreviewResource, HtmlPreviewError> {
        HtmlPreviewSource::read(self, request).await
    }
}

struct PeerPreviewReader {
    device_id: String,
    account_generation: u64,
}

impl PeerPreviewReader {
    async fn invoke(
        &self,
        command: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, HtmlPreviewError> {
        if !self.is_current() {
            return Err(HtmlPreviewError::unavailable(
                "HTML preview account changed; reopen the preview",
            ));
        }
        let command = serde_json::to_string(&RemoteCommand::HostInvoke {
            command: command.to_string(),
            args,
        })
        .map_err(|error| HtmlPreviewError::unavailable(error.to_string()))?;
        let raw = account_device_rpc(self.device_id.clone(), command, None)
            .await
            .map_err(HtmlPreviewError::unavailable)?;
        if !self.is_current() {
            return Err(HtmlPreviewError::unavailable(
                "HTML preview account changed; reopen the preview",
            ));
        }
        decode_peer_result(&raw)
    }

    async fn ensure_supported(&self) -> Result<(), HtmlPreviewError> {
        let ping = self.invoke("peer_mode_ping", serde_json::json!({})).await?;
        require_preview_capability(&ping)
    }
}

fn require_preview_capability(ping: &serde_json::Value) -> Result<(), HtmlPreviewError> {
    if ping
        .get("capabilities")
        .and_then(|caps| caps.get(PeerHostCapability::WorkspaceHtmlPreviewV1.key()))
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return Err(HtmlPreviewError::unavailable("This device does not support HTML preview resources; update OpenBitFun on the controlled device"));
    }
    Ok(())
}

fn decode_peer_result(raw: &str) -> Result<serde_json::Value, HtmlPreviewError> {
    match serde_json::from_str::<RemoteResponse>(raw)
        .map_err(|_| HtmlPreviewError::unavailable("Invalid peer HTML preview response"))?
    {
        RemoteResponse::HostInvokeResult {
            ok: true,
            value: Some(value),
            ..
        } => Ok(value),
        RemoteResponse::HostInvokeResult { error, .. } => Err(HtmlPreviewError::unavailable(
            error.unwrap_or_else(|| "Peer HTML preview failed".into()),
        )),
        RemoteResponse::Error { message } => Err(HtmlPreviewError::unavailable(message)),
        _ => Err(HtmlPreviewError::unavailable(
            "Invalid peer HTML preview response",
        )),
    }
}

#[async_trait::async_trait]
impl PreviewReader for PeerPreviewReader {
    fn is_current(&self) -> bool {
        account_context_is_current(self.account_generation)
    }
    async fn read(
        &self,
        request: &HtmlPreviewResourceRequest,
    ) -> Result<HtmlPreviewResource, HtmlPreviewError> {
        let value = self
            .invoke(
                "html_preview_read_resource",
                serde_json::json!({ "request": request }),
            )
            .await?;
        serde_json::from_value::<HtmlPreviewResourceReply>(value)
            .map_err(|_| HtmlPreviewError::unavailable("Invalid peer HTML preview resource"))?
            .into_result()
    }
}

#[derive(Clone)]
struct PreviewState {
    token: String,
    cookie_name: String,
    entry_path: String,
    request: HtmlPreviewResourceRequest,
    reader: Arc<dyn PreviewReader>,
    closed: watch::Receiver<bool>,
}

static SESSIONS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, watch::Sender<bool>>>,
> = std::sync::OnceLock::new();
fn sessions() -> &'static std::sync::Mutex<std::collections::HashMap<String, watch::Sender<bool>>> {
    SESSIONS.get_or_init(Default::default)
}

#[tauri::command]
pub async fn html_preview_create(
    app_state: tauri::State<'_, AppState>,
    request: HtmlPreviewCreateRequest,
) -> Result<HtmlPreviewCreateResponse, String> {
    let is_peer = request.peer_device_mode
        || request.peer_device_id.is_some()
        || super::peer_host_invoke::is_peer_controller_active();
    let reader: Arc<dyn PreviewReader>;
    let workspace_id;
    if is_peer {
        let device_id = request
            .peer_device_id
            .filter(|id| !id.trim().is_empty())
            .ok_or("HTML preview requires the selected peer device identity; reopen the file")?;
        workspace_id = request
            .workspace_id
            .filter(|id| !id.trim().is_empty())
            .ok_or("HTML preview workspace ID is required")?;
        let peer = PeerPreviewReader {
            device_id,
            account_generation: account_context_generation(),
        };
        peer.ensure_supported()
            .await
            .map_err(|error| error.message)?;
        reader = Arc::new(peer);
    } else {
        workspace_id = match request.workspace_id {
            Some(id) => id,
            None => {
                app_state
                    .workspace_service
                    .resolve_legacy_workspace_reference(
                        None,
                        &request.workspace_path,
                        request.remote_connection_id.as_deref(),
                        None,
                    )
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or("HTML preview workspace is unavailable")?
                    .id
            }
        };
        reader = Arc::new(
            resolve_html_preview_source(&workspace_id, &request.file_path)
                .await
                .map_err(|error| error.message)?,
        );
    }
    start_preview(
        reader,
        HtmlPreviewResourceRequest {
            workspace_id,
            file_path: request.file_path,
            resource_path: None,
            metadata_only: true,
            offset: 0,
            expected_source: None,
            expected_revision: None,
        },
    )
    .await
}

/// Runs on the workspace owner. Desktop and CLI use the same assembly/service path.
#[tauri::command]
pub async fn html_preview_read_resource(
    request: HtmlPreviewResourceRequest,
) -> HtmlPreviewResourceReply {
    openbitfun_core::service::filesystem::html_preview::html_preview_read_resource(request).await
}

async fn start_preview(
    reader: Arc<dyn PreviewReader>,
    mut request: HtmlPreviewResourceRequest,
) -> Result<HtmlPreviewCreateResponse, String> {
    let entry = reader.read(&request).await.map_err(|error| error.message)?;
    validate_chunk(&entry, &request).map_err(|error| error.message)?;
    request.expected_source = Some(entry.source);
    let token = Uuid::new_v4().simple().to_string();
    let session_id = Uuid::new_v4().simple().to_string();
    let (shutdown, closed) = watch::channel(false);
    let state = PreviewState {
        token: token.clone(),
        cookie_name: format!("openbitfun_html_preview_{session_id}"),
        entry_path: entry.entry_path,
        request,
        reader,
        closed: closed.clone(),
    };
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("Failed to bind HTML preview server: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let router = Router::new()
        .fallback(any(preview_handler))
        .with_state(state);
    sessions()
        .lock()
        .map_err(|_| "HTML preview registry poisoned")?
        .insert(session_id.clone(), shutdown);
    tokio::spawn(async move {
        let mut closed = closed;
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = closed.wait_for(|closed| *closed).await;
            })
            .await;
    });
    Ok(HtmlPreviewCreateResponse {
        url: format!("http://127.0.0.1:{port}/__openbitfun_preview_bootstrap?previewToken={token}"),
        session_id,
    })
}

#[tauri::command]
pub async fn html_preview_release(request: HtmlPreviewReleaseRequest) -> Result<(), String> {
    if let Some(shutdown) = sessions()
        .lock()
        .map_err(|_| "HTML preview registry poisoned")?
        .remove(&request.session_id)
    {
        let _ = shutdown.send(true);
    }
    Ok(())
}

impl PreviewState {
    async fn read(
        &self,
        request: &HtmlPreviewResourceRequest,
    ) -> Result<HtmlPreviewResource, HtmlPreviewError> {
        let mut closed = self.closed.clone();
        if *closed.borrow() || !self.reader.is_current() {
            return Err(HtmlPreviewError::unavailable(
                "HTML preview is no longer available",
            ));
        }
        tokio::select! {
            _ = closed.wait_for(|closed| *closed) => Err(HtmlPreviewError::unavailable("HTML preview was closed")),
            result = self.reader.read(request) => {
                let resource = result?;
                if *self.closed.borrow() || !self.reader.is_current() { return Err(HtmlPreviewError::unavailable("HTML preview is no longer available")); }
                validate_chunk(&resource, request)?;
                Ok(resource)
            }
        }
    }
}

fn validate_chunk(
    file: &HtmlPreviewResource,
    request: &HtmlPreviewResourceRequest,
) -> Result<(), HtmlPreviewError> {
    if file.size > MAX_PREVIEW_BYTES
        || file.offset != request.offset
        || file.offset > file.size
        || file.source.is_empty()
        || file.revision.is_empty()
        || request
            .expected_source
            .as_ref()
            .is_some_and(|source| source != &file.source)
        || request
            .expected_revision
            .as_ref()
            .is_some_and(|revision| revision != &file.revision)
        || file.content_base64.len() > PREVIEW_CHUNK_BYTES.div_ceil(3) * 4
    {
        return Err(HtmlPreviewError::unavailable(
            "Invalid HTML preview resource chunk",
        ));
    }
    let bytes = BASE64
        .decode(&file.content_base64)
        .map_err(|_| HtmlPreviewError::unavailable("Invalid HTML preview resource encoding"))?;
    let expected = if request.metadata_only {
        0
    } else {
        (file.size - file.offset).min(PREVIEW_CHUNK_BYTES as u64) as usize
    };
    if bytes.len() != expected {
        return Err(HtmlPreviewError::unavailable(
            "Incomplete HTML preview resource chunk",
        ));
    }
    Ok(())
}

async fn preview_handler(
    State(state): State<PreviewState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let query_token = uri.query().and_then(|query| {
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (key == "previewToken").then_some(value)
        })
    });
    let cookie_authorized = headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|cookies| {
            cookies
                .split(';')
                .filter_map(|cookie| cookie.trim().split_once('='))
                .any(|(key, value)| key == state.cookie_name && value == state.token)
        });
    if *state.closed.borrow()
        || !state.reader.is_current()
        || (method != Method::GET && method != Method::HEAD)
    {
        return response(StatusCode::NOT_FOUND, "Not found");
    }
    if uri.path() == "/__openbitfun_preview_bootstrap" && query_token == Some(state.token.as_str())
    {
        return Response::builder()
            .status(StatusCode::FOUND)
            .header(
                header::LOCATION,
                format!("/{}", encode_url_path(&state.entry_path)),
            )
            .header(
                header::SET_COOKIE,
                format!(
                    "{}={}; HttpOnly; SameSite=Strict; Path=/",
                    state.cookie_name, state.token
                ),
            )
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::REFERRER_POLICY, "no-referrer")
            .body(Body::empty())
            .unwrap_or_else(|_| {
                response(StatusCode::INTERNAL_SERVER_ERROR, "Invalid preview entry")
            });
    }
    if !cookie_authorized {
        return response(StatusCode::NOT_FOUND, "Not found");
    }
    let relative = match urlencoding::decode(uri.path().trim_start_matches('/')) {
        Ok(relative) => relative.into_owned(),
        Err(_) => return response(StatusCode::BAD_REQUEST, "Invalid preview path"),
    };
    let mut request = state.request.clone();
    request.resource_path = Some(relative);
    request.metadata_only = method == Method::HEAD;
    let first = match state.read(&request).await {
        Ok(file) => file,
        Err(error) => return preview_error_response(error),
    };
    let size = first.size;
    let content_type = first.mime_type.clone();
    request.expected_revision = Some(first.revision.clone());
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        let stream = futures::stream::try_unfold(
            (state, request, Some(first)),
            move |(state, mut request, first)| async move {
                let file = match first {
                    Some(file) => file,
                    None => state
                        .read(&request)
                        .await
                        .map_err(|error| std::io::Error::other(error.message))?,
                };
                if file.offset == file.size {
                    return Ok::<_, std::io::Error>(None);
                }
                let bytes = BASE64
                    .decode(file.content_base64)
                    .map_err(std::io::Error::other)?;
                request.offset += bytes.len() as u64;
                // An empty sentinel ends the stream without another RPC at EOF.
                let next = (request.offset == size).then(|| HtmlPreviewResource {
                    offset: size,
                    content_base64: String::new(),
                    ..file
                });
                Ok(Some((bytes, (state, request, next))))
            },
        );
        Body::from_stream(stream)
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, size)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(body)
        .unwrap_or_else(|_| {
            response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Invalid preview response",
            )
        })
}

fn preview_error_response(error: HtmlPreviewError) -> Response {
    let status = match error.code {
        Code::InvalidPath => StatusCode::BAD_REQUEST,
        Code::NotFound => StatusCode::NOT_FOUND,
        Code::Forbidden => StatusCode::FORBIDDEN,
        Code::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        Code::Changed => StatusCode::CONFLICT,
        Code::Unavailable => StatusCode::BAD_GATEWAY,
    };
    response(status, &error.message)
}
fn encode_url_path(path: &str) -> String {
    path.split('/')
        .map(|component| urlencoding::encode(component).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}
fn response(status: StatusCode, body: &str) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .body(Body::from(body.to_string()))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

#[cfg(test)]
pub(super) mod tests;
