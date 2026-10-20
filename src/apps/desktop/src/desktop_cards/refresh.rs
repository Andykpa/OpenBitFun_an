//! Data source fetching for desktop cards.

use std::path::Path;
use std::time::Duration;

use openbitfun_core::agentic::tools::desktop_card_host::{
    DesktopCardDataParse, DesktopCardDataSourceKind, DESKTOP_CARD_DEFAULT_COMMAND_TIMEOUT_SECONDS,
};
use serde_json::Value;

const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_TEXT_CHARS: usize = 8_000;
const MAX_ERROR_CHARS: usize = 400;

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let mut truncated = value.chars().take(max).collect::<String>();
    truncated.push_str("...");
    truncated
}

fn parse_output(raw: &str, parse: DesktopCardDataParse) -> Result<Value, String> {
    let trimmed = raw.trim();
    match parse {
        DesktopCardDataParse::Json => serde_json::from_str(trimmed).map_err(|error| {
            format!(
                "Output is not valid JSON ({error}): {}",
                truncate_chars(trimmed, 120)
            )
        }),
        DesktopCardDataParse::Text => Ok(Value::String(truncate_chars(trimmed, MAX_TEXT_CHARS))),
    }
}

pub(crate) async fn fetch(source: &DesktopCardDataSourceKind) -> Result<Value, String> {
    match source {
        DesktopCardDataSourceKind::Http {
            url,
            headers,
            parse,
            ..
        } => fetch_http(url, headers, *parse).await,
        DesktopCardDataSourceKind::Command {
            command,
            cwd,
            timeout_seconds,
            parse,
            ..
        } => {
            fetch_command(
                command,
                cwd.as_deref(),
                timeout_seconds.unwrap_or(DESKTOP_CARD_DEFAULT_COMMAND_TIMEOUT_SECONDS),
                *parse,
            )
            .await
        }
    }
}

async fn fetch_http(
    url: &str,
    headers: &std::collections::BTreeMap<String, String>,
    parse: DesktopCardDataParse,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|error| format!("Failed to create HTTP client: {error}"))?;
    let mut request = client.get(url);
    let has_user_agent = headers
        .keys()
        .any(|name| name.eq_ignore_ascii_case("user-agent"));
    if !has_user_agent {
        request = request.header("User-Agent", "OpenBitFun-DesktopCard");
    }
    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| format!("Request failed: {error}"))?;
    let status = response.status();
    // Read in chunks so an oversized body is rejected before it is buffered.
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Failed to read response: {error}"))?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(format!(
                "Response is larger than {} KiB",
                MAX_RESPONSE_BYTES / 1024
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8_lossy(&bytes);
    if !status.is_success() {
        return Err(format!(
            "HTTP {}: {}",
            status.as_u16(),
            truncate_chars(body.trim(), 160)
        ));
    }
    parse_output(&body, parse)
}

fn shell_command(command: &str) -> tokio::process::Command {
    #[cfg(windows)]
    {
        let mut process =
            openbitfun_core::util::process_manager::create_tokio_command("powershell.exe");
        process.args(["-NoProfile", "-NonInteractive", "-Command", command]);
        process
    }
    #[cfg(not(windows))]
    {
        let mut process = openbitfun_core::util::process_manager::create_tokio_command("/bin/sh");
        process.args(["-c", command]);
        process
    }
}

async fn fetch_command(
    command: &str,
    cwd: Option<&str>,
    timeout_seconds: u64,
    parse: DesktopCardDataParse,
) -> Result<Value, String> {
    let mut process = shell_command(command);
    if let Some(cwd) = cwd {
        if !Path::new(cwd).is_dir() {
            return Err(format!("Working directory does not exist: {cwd}"));
        }
        process.current_dir(cwd);
    }
    process
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let child = process
        .spawn()
        .map_err(|error| format!("Failed to start command: {error}"))?;
    let output = tokio::time::timeout(
        Duration::from_secs(timeout_seconds),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("Command timed out after {timeout_seconds}s"))?
    .map_err(|error| format!("Command failed: {error}"))?;
    if output.stdout.len() > MAX_RESPONSE_BYTES {
        return Err(format!(
            "Command output is larger than {} KiB",
            MAX_RESPONSE_BYTES / 1024
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = if stderr.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        };
        return Err(format!(
            "Command exited with {}: {}",
            output
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "a signal".to_string()),
            truncate_chars(&detail, MAX_ERROR_CHARS)
        ));
    }
    parse_output(&stdout, parse)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_output_handles_json_and_text() {
        assert_eq!(
            parse_output(" {\"a\": 1}\n", DesktopCardDataParse::Json).unwrap(),
            json!({"a": 1})
        );
        assert!(parse_output("nope", DesktopCardDataParse::Json)
            .unwrap_err()
            .contains("not valid JSON"));
        assert_eq!(
            parse_output("  hi \n", DesktopCardDataParse::Text).unwrap(),
            json!("hi")
        );
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn command_sources_capture_json_errors_and_timeouts() {
        assert_eq!(
            fetch_command("printf '{\"n\": 3}'", None, 5, DesktopCardDataParse::Json)
                .await
                .unwrap(),
            json!({"n": 3})
        );
        let error = fetch_command("echo boom >&2; exit 3", None, 5, DesktopCardDataParse::Text)
            .await
            .unwrap_err();
        assert!(error.contains("exited with 3"));
        assert!(error.contains("boom"));
        let error = fetch_command("sleep 5", None, 1, DesktopCardDataParse::Text)
            .await
            .unwrap_err();
        assert!(error.contains("timed out"));
        let error = fetch_command(
            "true",
            Some("/definitely/missing"),
            5,
            DesktopCardDataParse::Text,
        )
        .await
        .unwrap_err();
        assert!(error.contains("does not exist"));
    }
}
