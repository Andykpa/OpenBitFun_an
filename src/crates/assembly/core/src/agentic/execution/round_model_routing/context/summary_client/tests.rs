use super::*;
use crate::util::types::Message as AIMessage;
use openbitfun_core_types::{ReasoningCapabilityStatus, ReasoningConfig};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn projection() -> ReasoningCatalogProjection {
    let configured: ReasoningConfig = serde_json::from_value(json!({
        "catalog": {"source": "auto"}, "default_preset": "high"
    }))
    .unwrap();
    openbitfun_ai_adapters::models_dev::project_reasoning_catalog_with_limit(
        "openai",
        "qwen3.8-flash-next",
        "https://gateway.example.invalid/v1",
        65_536,
        Some(&configured),
        None,
    )
}

fn fixture(endpoint: &str) -> AIClient {
    let client = AIClient::new(
        serde_json::from_value(json!({
            "name": "economy fixture", "model": "qwen3.8-flash-next", "format": "openai",
            "base_url": endpoint, "request_url": endpoint, "api_key": "synthetic-key",
            "context_window": 364_000, "max_tokens": 65_536,
            "temperature": 0.95, "top_p": 1.0, "inline_think_in_text": false,
            "skip_ssl_verify": false, "custom_request_body_mode": "merge",
            "custom_request_body": {"reasoning_effort": "high", "temperature": 0.95,
                "chat_template_kwargs": {"enable_thinking": true, "preserve_thinking": true}}
        }))
        .unwrap(),
    );
    let projection = projection();
    let high = projection
        .presets
        .iter()
        .find(|preset| preset.id == "high")
        .unwrap();
    client.with_model_reasoning_preset(high)
}

#[test]
fn automatic_summary_prefers_effort_over_synthesized_generic_toggles() {
    let projection = projection();
    assert!(projection.presets.iter().any(|preset| preset.id == "off"));
    assert!(projection.presets.iter().any(|preset| preset.id == "on"));
    let preset = automatic_preset(&projection).unwrap();
    assert_eq!(preset.id, "low");
    let shared = fixture("http://127.0.0.1:1/v1/chat/completions");
    let before = serde_json::to_value(&shared.config).unwrap();
    let derived = request_client(&shared, &projection, &RouterContextConfig::default()).unwrap();
    assert_eq!(derived.selected_reasoning_preset().unwrap().id, "low");
    assert_eq!(derived.config.max_tokens, Some(16_384));
    assert!(shared.selected_reasoning_preset().is_none());
    assert_eq!(shared.model_reasoning_preset().unwrap().id, "high");
    assert_eq!(serde_json::to_value(&shared.config).unwrap(), before);
}

#[test]
fn explicit_summary_preset_is_resolved_strictly_in_the_summary_models_catalog() {
    let projection = projection();
    let shared = fixture("http://127.0.0.1:1/v1/chat/completions");
    let mut config = RouterContextConfig {
        summary_reasoning_preset: Some("medium".into()),
        ..Default::default()
    };
    let client = request_client(&shared, &projection, &config).unwrap();
    assert_eq!(client.selected_reasoning_preset().unwrap().id, "medium");
    config.summary_reasoning_preset = Some("missing-preset".into());
    assert!(request_client(&shared, &projection, &config)
        .err()
        .unwrap()
        .to_string()
        .contains("unavailable for the summary model"));
    assert_eq!(shared.model_reasoning_preset().unwrap().id, "high");
}

#[test]
fn declared_model_toggle_is_usable_but_unknown_inherited_reasoning_fails_closed() {
    let mut projection = projection();
    projection.presets.retain(|preset| preset.id == "off");
    let shared = fixture("http://127.0.0.1:1/v1/chat/completions");
    assert!(request_client(&shared, &projection, &RouterContextConfig::default()).is_err());
    projection.presets[0].source = ReasoningPresetSource::ModelConfig;
    assert_eq!(automatic_preset(&projection).unwrap().id, "off");

    let config = RouterContextConfig {
        summary_reasoning_preset: Some("off".into()),
        ..Default::default()
    };
    projection.presets[0].source = ReasoningPresetSource::AdapterFallback;
    assert_eq!(
        request_client(&shared, &projection, &config)
            .unwrap()
            .selected_reasoning_preset()
            .unwrap()
            .id,
        "off"
    );
}

#[test]
fn models_without_reasoning_presets_keep_automatic_requests_unchanged() {
    let shared = AIClient::new(
        serde_json::from_value(json!({
            "name": "text fixture", "model": "text-only", "format": "openai",
            "base_url": "http://127.0.0.1:1/v1", "request_url": "http://127.0.0.1:1/v1/chat/completions",
            "api_key": "synthetic-key", "context_window": 65_536, "max_tokens": 32_768,
            "inline_think_in_text": false, "skip_ssl_verify": false
        }))
        .unwrap(),
    );
    let projection = ReasoningCatalogProjection {
        status: ReasoningCapabilityStatus::Unsupported,
        default_preset: None,
        presets: Vec::new(),
        unavailable_presets: Vec::new(),
    };
    let request = request_client(&shared, &projection, &RouterContextConfig::default()).unwrap();
    assert!(request.selected_reasoning_preset().is_none());
    assert!(request.model_reasoning_preset().is_none());
    assert_eq!(request.config.max_tokens, Some(16_384));
    assert_eq!(shared.config.max_tokens, Some(32_768));
}

#[test]
fn send_time_validation_rejects_history_prepared_for_a_larger_model_window() {
    let config = RouterContextConfig::default();
    let shared = fixture("http://127.0.0.1:1/v1/chat/completions");
    let large = request_client(&shared, &projection(), &config).unwrap();
    let prompt = "x".repeat(100_000);
    assert!(validate_input(&large, &config, &prompt).is_ok());
    let mut smaller = large.clone();
    smaller.config.context_window = 32_768;
    let error = validate_input(&smaller, &config, &prompt).unwrap_err();
    assert!(error
        .to_string()
        .contains("exceeds the current summary model budget"));
    assert!(input_budget(&smaller, &config).unwrap() < input_budget(&large, &config).unwrap());

    let budget = input_budget(&smaller, &config).unwrap();
    // Estimated ASCII count is ceil(bytes / 3); exercise the exact boundary.
    assert!(validate_input(&smaller, &config, &"x".repeat(budget * 3)).is_ok());
    assert!(validate_input(&smaller, &config, &"x".repeat(budget * 3 + 1)).is_err());
}

#[test]
fn summary_budget_reserves_actual_output_system_framing_and_window_margin() {
    let config = RouterContextConfig::default();
    let shared = fixture("http://127.0.0.1:1/v1/chat/completions");
    let mut client = request_client(&shared, &projection(), &config).unwrap();
    let system = EstimatedRouterTokens.count(&summary_system_prompt(&config));
    assert_eq!(
        input_budget(&client, &config).unwrap(),
        364_000 - 36_400 - 16_384 - system - 256
    );
    client.config.max_tokens = Some(8_192);
    assert_eq!(
        input_budget(&client, &config).unwrap(),
        364_000 - 36_400 - 8_192 - system - 256
    );
    client.config.context_window = 16_384;
    client.config.max_tokens = Some(16_384);
    assert!(input_budget(&client, &config).is_err());
    assert!(validate_input(&client, &config, "small history").is_err());
}

fn wire_server(request_count: usize) -> (String, std::thread::JoinHandle<Vec<Value>>) {
    use std::io::{BufRead, BufReader, Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for _ in 0..request_count {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            Instant::now() < deadline,
                            "Expected summary request did not arrive"
                        );
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("Summary fixture could not accept request: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut length = 0;
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            requests.push(serde_json::from_slice::<Value>(&body).unwrap());
            let response = format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({
                    "id":"summary-fixture", "object":"chat.completion.chunk", "created":0,
                    "model":"qwen3.8-flash-next", "choices":[{"index":0,
                        "delta":{"content":"Confirmed parser history; verification pending."},
                        "finish_reason":"stop"}]
                })
            );
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
        }
        requests
    });
    (endpoint, server)
}

#[tokio::test]
async fn auxiliary_wire_overrides_high_without_mutating_the_shared_client_or_chat_settings() {
    let (endpoint, server) = wire_server(4);
    let shared = fixture(&endpoint);
    let projection = projection();
    let config = RouterContextConfig::default();
    let automatic = request_client(&shared, &projection, &config).unwrap();
    let explicit = request_client(
        &shared,
        &projection,
        &RouterContextConfig {
            summary_reasoning_preset: Some("medium".into()),
            ..config.clone()
        },
    )
    .unwrap();
    let messages = || vec![AIMessage::user("Synthetic parser fixture".into())];
    shared.send_message(messages(), None).await.unwrap();
    automatic.send_message(messages(), None).await.unwrap();
    explicit.send_message(messages(), None).await.unwrap();
    shared.send_message(messages(), None).await.unwrap();
    let requests = server.join().unwrap();
    assert_eq!(requests[0], requests[3]);
    assert_eq!(requests[0]["reasoning_effort"], "high");
    assert_eq!(requests[0]["max_tokens"], 65_536);
    assert_eq!(requests[1]["reasoning_effort"], "low");
    assert_eq!(requests[1]["max_tokens"], 16_384);
    assert_eq!(requests[2]["reasoning_effort"], "medium");
    assert_eq!(requests[2]["max_tokens"], 16_384);
    assert!(requests[1].get("tools").is_none());
    assert_eq!(requests[1]["temperature"], requests[0]["temperature"]);
    assert_eq!(
        requests[1]["chat_template_kwargs"],
        requests[0]["chat_template_kwargs"]
    );
    assert!(shared.selected_reasoning_preset().is_none());
    assert_eq!(shared.model_reasoning_preset().unwrap().id, "high");
}
