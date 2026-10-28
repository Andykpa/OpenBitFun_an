use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

struct Reader {
    bytes: Vec<u8>,
    requests: Mutex<Vec<HtmlPreviewResourceRequest>>,
    unavailable: AtomicBool,
    blocked: AtomicBool,
    reading: tokio::sync::Notify,
    unblock: tokio::sync::Notify,
}

#[async_trait::async_trait]
impl PreviewReader for Reader {
    async fn read(
        &self,
        request: &HtmlPreviewResourceRequest,
    ) -> Result<HtmlPreviewResource, HtmlPreviewError> {
        self.requests.lock().unwrap().push(request.clone());
        if self.blocked.load(Ordering::SeqCst) {
            self.reading.notify_one();
            self.unblock.notified().await;
        }
        if self.unavailable.load(Ordering::SeqCst) {
            return Err(HtmlPreviewError::unavailable("Peer is offline"));
        }
        if request.resource_path.as_deref() == Some("missing.js") {
            return Err(HtmlPreviewError::new(Code::NotFound, "Missing resource"));
        }
        let count = if request.metadata_only {
            0
        } else {
            (self.bytes.len() - request.offset as usize).min(PREVIEW_CHUNK_BYTES)
        };
        Ok(HtmlPreviewResource {
            entry_path: "site/dist/index #1.html".into(),
            resource_path: request
                .resource_path
                .clone()
                .unwrap_or_else(|| "site/dist/index #1.html".into()),
            source: "workspace-provider".into(),
            revision: "revision-1".into(),
            mime_type: "text/html; charset=utf-8".into(),
            size: self.bytes.len() as u64,
            offset: request.offset,
            content_base64: BASE64
                .encode(&self.bytes[request.offset as usize..request.offset as usize + count]),
        })
    }
}

fn resource_request() -> HtmlPreviewResourceRequest {
    HtmlPreviewResourceRequest {
        workspace_id: "workspace".into(),
        file_path: "/repo/site/dist/index #1.html".into(),
        resource_path: None,
        metadata_only: true,
        offset: 0,
        expected_source: None,
        expected_revision: None,
    }
}

async fn fixture(bytes: Vec<u8>) -> (HtmlPreviewCreateResponse, Arc<Reader>, reqwest::Client) {
    crate::ensure_rustls_crypto_provider();
    let reader = Arc::new(Reader {
        bytes,
        requests: Mutex::new(vec![]),
        unavailable: AtomicBool::new(false),
        blocked: AtomicBool::new(false),
        reading: Default::default(),
        unblock: Default::default(),
    });
    let preview = start_preview(reader.clone(), resource_request())
        .await
        .unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    (preview, reader, client)
}

async fn bootstrap(
    client: &reqwest::Client,
    preview: &HtmlPreviewCreateResponse,
) -> (String, String) {
    let reply = client.get(&preview.url).send().await.unwrap();
    assert_eq!(reply.status(), StatusCode::FOUND);
    let cookie = reply.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let location = reply.headers()[header::LOCATION].to_str().unwrap();
    assert_eq!(location, "/site/dist/index%20%231.html");
    let entry = reqwest::Url::parse(&preview.url)
        .unwrap()
        .join(location)
        .unwrap()
        .to_string();
    (cookie, entry)
}

async fn release(preview: HtmlPreviewCreateResponse) {
    html_preview_release(HtmlPreviewReleaseRequest {
        session_id: preview.session_id,
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn http_bootstrap_streams_bounded_chunks_and_preserves_head() {
    let bytes = vec![71; PREVIEW_CHUNK_BYTES * 2 + 11];
    let (preview, reader, client) = fixture(bytes.clone()).await;
    let (cookie, entry) = bootstrap(&client, &preview).await;
    assert_eq!(
        client.get(&entry).send().await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    let reply = client
        .get(&entry)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), StatusCode::OK);
    assert_eq!(
        reply.headers()[header::CONTENT_LENGTH],
        bytes.len().to_string()
    );
    assert_eq!(reply.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(reply.bytes().await.unwrap().as_ref(), &bytes);
    let requests = reader.requests.lock().unwrap().clone();
    assert_eq!(
        requests.len(),
        4,
        "bootstrap metadata plus three bounded content reads"
    );
    assert_eq!(
        requests[1].resource_path.as_deref(),
        Some("site/dist/index #1.html")
    );
    assert_eq!(requests[2].offset, PREVIEW_CHUNK_BYTES as u64);
    assert_eq!(requests[3].expected_revision.as_deref(), Some("revision-1"));
    assert_eq!(
        requests[3].expected_source.as_deref(),
        Some("workspace-provider")
    );
    let reply = client
        .head(&entry)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(
        reply.headers()[header::CONTENT_LENGTH],
        bytes.len().to_string()
    );
    assert!(reply.bytes().await.unwrap().is_empty());
    assert!(
        reader
            .requests
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .metadata_only
    );
    assert_eq!(
        client
            .post(&entry)
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    release(preview).await;
}

#[tokio::test]
async fn concurrent_preview_cookies_do_not_overwrite_or_authorize_each_other() {
    let (first, _, client) = fixture(b"first".to_vec()).await;
    let (second, _, _) = fixture(b"second".to_vec()).await;
    let (first_cookie, first_url) = bootstrap(&client, &first).await;
    let (second_cookie, second_url) = bootstrap(&client, &second).await;
    assert_ne!(
        first_cookie.split('=').next(),
        second_cookie.split('=').next()
    );
    assert_eq!(
        client
            .get(&first_url)
            .header(header::COOKIE, &second_cookie)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    // Browsers share cookies across ports on 127.0.0.1; both cookies will be sent.
    let cookies = format!("{first_cookie}; {second_cookie}");
    assert_eq!(
        client
            .get(&first_url)
            .header(header::COOKIE, &cookies)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "first"
    );
    assert_eq!(
        client
            .get(&second_url)
            .header(header::COOKIE, &cookies)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "second"
    );
    release(first).await;
    release(second).await;
}

#[tokio::test]
async fn gateway_reports_missing_and_offline_resources_and_recovers_on_reload() {
    let (preview, reader, client) = fixture(b"remote-content".to_vec()).await;
    let (cookie, entry) = bootstrap(&client, &preview).await;
    let missing = reqwest::Url::parse(&entry)
        .unwrap()
        .join("/missing.js")
        .unwrap();
    assert_eq!(
        client
            .get(missing)
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    reader.unavailable.store(true, Ordering::SeqCst);
    let reply = client
        .get(&entry)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), StatusCode::BAD_GATEWAY);
    assert!(reply.text().await.unwrap().contains("Peer is offline"));
    reader.unavailable.store(false, Ordering::SeqCst);
    assert_eq!(
        client
            .get(&entry)
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "remote-content"
    );
    release(preview).await;
}

#[tokio::test]
async fn closing_preview_cancels_in_flight_resource_read() {
    let (preview, reader, client) = fixture(b"remote-content".to_vec()).await;
    let (cookie, entry) = bootstrap(&client, &preview).await;
    reader.blocked.store(true, Ordering::SeqCst);
    let request = tokio::spawn(async move {
        client
            .get(entry)
            .header(header::COOKIE, cookie)
            .send()
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), reader.reading.notified())
        .await
        .unwrap();
    release(preview).await;
    let reply = tokio::time::timeout(std::time::Duration::from_secs(2), request)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(reply.status(), StatusCode::BAD_GATEWAY);
}

#[test]
fn current_and_legacy_preview_requests_round_trip_without_guessing_peer_identity() {
    for payload in [
        serde_json::json!({"workspaceId":"remote-id", "filePath":"/repo/index.html"}),
        serde_json::json!({"workspacePath":"/repo", "filePath":"/repo/index.html", "remoteConnectionId":"ssh-1"}),
        serde_json::json!({"workspaceId":"remote-id", "filePath":"/repo/index.html", "peerDeviceMode":true}),
    ] {
        let request: HtmlPreviewCreateRequest = serde_json::from_value(payload.clone()).unwrap();
        assert!(request.peer_device_id.is_none());
        let encoded = serde_json::to_value(request).unwrap();
        for (key, value) in payload.as_object().unwrap() {
            assert_eq!(&encoded[key], value);
        }
        let decoded: HtmlPreviewCreateRequest = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded.file_path, "/repo/index.html");
    }
}

#[test]
fn peer_capability_is_required_even_for_desktop_and_wire_failures_are_explicit() {
    for ping in [
        serde_json::json!({}),
        serde_json::json!({"host_type":"desktop","capabilities":{}}),
        serde_json::json!({"capabilities":{"workspace_html_preview_v1":false}}),
    ] {
        assert!(require_preview_capability(&ping)
            .unwrap_err()
            .message
            .contains("update OpenBitFun"));
    }
    for host in ["desktop", "cli"] {
        assert!(require_preview_capability(
            &serde_json::json!({"host_type":host,"capabilities":{"workspace_html_preview_v1":true}})
        )
        .is_ok());
    }
    assert!(
        decode_peer_result(r#"{"resp":"host_invoke_result","ok":false,"error":"offline"}"#)
            .is_err()
    );
    assert!(decode_peer_result(r#"{"resp":"error","message":"unsupported"}"#).is_err());
    assert!(decode_peer_result(r#"{"resp":"host_invoke_result","ok":true}"#).is_err());
    assert!(decode_peer_result("invalid").is_err());
}

// Called from the relay fixture while it owns the isolated account context.
pub(crate) async fn verify_encrypted_peer_gateway(
    device_id: &str,
    request: HtmlPreviewResourceRequest,
    expected: &[u8],
) {
    let reader = Arc::new(PeerPreviewReader {
        device_id: device_id.into(),
        account_generation: account_context_generation(),
    });
    reader.ensure_supported().await.unwrap();
    let preview = start_preview(reader, request).await.unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let reply = client.get(&preview.url).send().await.unwrap();
    assert_eq!(reply.status(), StatusCode::FOUND);
    let cookie = reply.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let asset = reqwest::Url::parse(&preview.url)
        .unwrap()
        .join("/assets/large.js")
        .unwrap();
    let reply = client
        .get(asset)
        .header(header::COOKIE, cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), StatusCode::OK);
    assert_eq!(
        reply.headers()[header::CONTENT_TYPE],
        "text/javascript; charset=utf-8"
    );
    assert_eq!(reply.bytes().await.unwrap().as_ref(), expected);
    release(preview).await;
}
