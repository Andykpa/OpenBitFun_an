//! DesktopCard tool: small always-available cards outside the main window.

use crate::agentic::tools::desktop_card_host::{
    desktop_card_host_available, invoke_desktop_card_host, validate_data, validate_data_source,
    validate_icon, validate_size, validate_subtitle, validate_template, validate_title,
    validate_tone, validate_web_url, DesktopCardDataSourceKind, DesktopCardDraft,
    DesktopCardHostRequest, DesktopCardOrigin, DesktopCardPatch, DesktopCardSize,
    DesktopCardTemplateKind, DESKTOP_CARD_ICONS,
};
use crate::agentic::tools::framework::{PermissionIntent, Tool, ToolResult, ToolUseContext};
use crate::service::config::global::GlobalConfigManager;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use chrono::DateTime;
use openbitfun_agent_runtime::remote_file_delivery::TOOL_CONTEXT_REMOTE_FILE_DELIVERY_KEY;
use serde_json::{json, Map, Value};

pub const DESKTOP_CARDS_CONFIG_PATH: &str = "app.ai_experience.enable_desktop_cards";
const MAX_COUNTDOWN_SECONDS: i64 = 366 * 24 * 60 * 60;

pub struct DesktopCardTool;

impl DesktopCardTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for DesktopCardTool {
    fn default() -> Self {
        Self::new()
    }
}

fn is_remote_control_context(context: &ToolUseContext) -> bool {
    context
        .custom_data
        .get(TOOL_CONTEXT_REMOTE_FILE_DELIVERY_KEY)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn object_field<'a>(object: &'a Map<String, Value>, field: &str) -> Option<&'a Value> {
    object.get(field)
}

fn optional_str<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<Option<&'a str>, String> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.as_str())),
        Some(_) => Err(format!("{field} must be a string")),
    }
}

/// Countdown input accepts friendlier forms than an epoch timestamp.
fn normalize_template_input(raw: &Value, now: i64) -> Result<DesktopCardTemplateKind, String> {
    let Some(object) = raw.as_object() else {
        return Err("template must be an object with a kind".to_string());
    };
    let mut object = object.clone();
    if object.get("kind").and_then(Value::as_str) == Some("countdown") {
        let duration = object.remove("durationSeconds");
        let target_at = object.remove("targetAt");
        if !object.contains_key("targetAtMs") {
            let target_ms = if let Some(duration) = duration {
                let seconds = duration
                    .as_f64()
                    .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
                    .ok_or("countdown durationSeconds must be a positive number")?;
                if seconds > MAX_COUNTDOWN_SECONDS as f64 {
                    return Err("countdown durationSeconds must be at most one year".to_string());
                }
                now + (seconds * 1000.0).round() as i64
            } else if let Some(target_at) = target_at {
                let text = target_at
                    .as_str()
                    .ok_or("countdown targetAt must be an ISO-8601 string")?;
                DateTime::parse_from_rfc3339(text)
                    .map_err(|error| {
                        format!(
                            "countdown targetAt must be an ISO-8601 timestamp with offset, for example 2026-03-17T15:30:00+08:00: {error}"
                        )
                    })?
                    .timestamp_millis()
            } else {
                return Err(
                    "countdown requires durationSeconds, targetAt (ISO-8601), or targetAtMs"
                        .to_string(),
                );
            };
            object.insert("targetAtMs".to_string(), json!(target_ms));
        }
        if !object.contains_key("startedAtMs") {
            object.insert("startedAtMs".to_string(), json!(now));
        }
    }
    let template: DesktopCardTemplateKind = serde_json::from_value(Value::Object(object))
        .map_err(|error| format!("invalid template: {error}"))?;
    validate_template(template)
}

fn parse_data_source(raw: &Value) -> Result<DesktopCardDataSourceKind, String> {
    let source: DesktopCardDataSourceKind = serde_json::from_value(raw.clone())
        .map_err(|error| format!("invalid dataSource: {error}"))?;
    validate_data_source(source)
}

fn parse_size(object: &Map<String, Value>) -> Result<Option<DesktopCardSize>, String> {
    let width = object.get("width").filter(|value| !value.is_null());
    let height = object.get("height").filter(|value| !value.is_null());
    if width.is_none() && height.is_none() {
        return Ok(None);
    }
    let read = |field: &str, value: Option<&Value>| -> Result<Option<f64>, String> {
        value
            .map(|value| value.as_f64().ok_or(format!("{field} must be a number")))
            .transpose()
    };
    let width = read("width", width)?;
    let height = read("height", height)?;
    Ok(Some(DesktopCardSize {
        width: width.unwrap_or(f64::NAN),
        height: height.unwrap_or(f64::NAN),
    }))
}

fn parse_draft(raw: &Value, now: i64) -> Result<DesktopCardDraft, String> {
    let Some(card) = raw.as_object() else {
        return Err("card is required for create and must be an object".to_string());
    };
    let title = validate_title(optional_str(card, "title")?.unwrap_or_default())?;
    let template = normalize_template_input(
        object_field(card, "template").ok_or("card.template is required")?,
        now,
    )?;
    let data = card.get("data").cloned().unwrap_or(Value::Null);
    validate_data(&data)?;
    let data_source = match card.get("dataSource") {
        None | Some(Value::Null) => None,
        Some(raw) => Some(parse_data_source(raw)?),
    };
    let size = match parse_size(card)? {
        Some(size) => {
            let default = template.default_size();
            Some(validate_size(DesktopCardSize {
                width: if size.width.is_nan() {
                    default.width
                } else {
                    size.width
                },
                height: if size.height.is_nan() {
                    default.height
                } else {
                    size.height
                },
            })?)
        }
        None => None,
    };
    let always_on_top = match card.get("alwaysOnTop") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err("alwaysOnTop must be a boolean".to_string()),
    };
    Ok(DesktopCardDraft {
        title,
        subtitle: validate_subtitle(optional_str(card, "subtitle")?)?,
        icon: validate_icon(optional_str(card, "icon")?)?,
        accent: validate_tone("accent", optional_str(card, "accent")?)?,
        template,
        data,
        data_source,
        link: optional_str(card, "link")?
            .filter(|link| !link.trim().is_empty())
            .map(|link| validate_web_url("link", link))
            .transpose()?,
        size,
        always_on_top,
    })
}

fn nullable_text<T>(
    patch: &Map<String, Value>,
    field: &str,
    validate: impl Fn(Option<&str>) -> Result<Option<T>, String>,
) -> Result<Option<Option<T>>, String> {
    match patch.get(field) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(value)) => Ok(Some(validate(Some(value))?)),
        Some(_) => Err(format!("{field} must be a string or null")),
    }
}

fn parse_patch(raw: &Value, now: i64) -> Result<DesktopCardPatch, String> {
    let Some(patch) = raw.as_object() else {
        return Err("patch is required for update and must be an object".to_string());
    };
    let mut result = DesktopCardPatch {
        title: optional_str(patch, "title")?
            .map(validate_title)
            .transpose()?,
        subtitle: nullable_text(patch, "subtitle", validate_subtitle)?,
        icon: nullable_text(patch, "icon", validate_icon)?,
        accent: nullable_text(patch, "accent", |tone| validate_tone("accent", tone))?,
        link: nullable_text(patch, "link", |link| {
            link.filter(|link| !link.trim().is_empty())
                .map(|link| validate_web_url("link", link))
                .transpose()
        })?,
        ..Default::default()
    };
    if let Some(template) = patch.get("template").filter(|value| !value.is_null()) {
        result.template = Some(normalize_template_input(template, now)?);
    }
    if let Some(data) = patch.get("data") {
        validate_data(data)?;
        result.data = Some(data.clone());
    }
    match patch.get("dataMerge") {
        None | Some(Value::Null) => {}
        Some(Value::Object(merge)) => {
            validate_data(&Value::Object(merge.clone()))?;
            result.data_merge = Some(merge.clone());
        }
        Some(_) => return Err("dataMerge must be an object".to_string()),
    }
    match patch.get("dataSource") {
        None => {}
        Some(Value::Null) => result.data_source = Some(None),
        Some(raw) => result.data_source = Some(Some(parse_data_source(raw)?)),
    }
    if let Some(size) = parse_size(patch)? {
        if size.width.is_nan() || size.height.is_nan() {
            return Err("update must set width and height together".to_string());
        }
        result.size = Some(validate_size(size)?);
    }
    match patch.get("alwaysOnTop") {
        None | Some(Value::Null) => {}
        Some(Value::Bool(value)) => result.always_on_top = Some(*value),
        Some(_) => return Err("alwaysOnTop must be a boolean".to_string()),
    }
    if result.is_empty() {
        return Err("patch does not change any supported field".to_string());
    }
    Ok(result)
}

fn command_source(input: &Value) -> Option<&str> {
    let action = input.get("action").and_then(Value::as_str)?;
    let container = match action {
        "create" => input.get("card")?,
        "update" => input.get("patch")?,
        _ => return None,
    };
    let source = container.get("dataSource")?;
    if source.get("kind").and_then(Value::as_str) != Some("command") {
        return None;
    }
    Some(
        source
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("<missing>"),
    )
}

fn required_card_id(input: &Value) -> OpenBitFunResult<String> {
    input
        .get("cardId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| OpenBitFunError::validation("cardId is required for this action"))
}

fn presets() -> Value {
    json!([
        {
            "id": "countdown-reminder",
            "useWhen": "The user asks to be reminded after some time, or a wait has a known end (build ETA, meeting, cooldown).",
            "call": {
                "action": "create",
                "card": {
                    "title": "Stand-up meeting",
                    "icon": "alarm",
                    "template": { "kind": "countdown", "durationSeconds": 900, "message": "Join the stand-up" }
                }
            },
            "notes": "When it reaches zero the card highlights and a system notification is sent. Use targetAt with an ISO-8601 offset for wall-clock times."
        },
        {
            "id": "scheduled-job",
            "useWhen": "You created a Cron job and the user benefits from seeing the next run and last result at a glance.",
            "call": {
                "action": "create",
                "card": {
                    "title": "Daily dependency audit",
                    "icon": "calendar",
                    "template": { "kind": "cronJob", "jobId": "<job_id returned by Cron add>" }
                }
            }
        },
        {
            "id": "pull-request-status",
            "useWhen": "The user opened or is waiting on a pull request (review, CI, merge).",
            "call": {
                "action": "create",
                "card": {
                    "title": "PR #123",
                    "subtitle": "owner/repo",
                    "icon": "git-pull-request",
                    "link": "https://github.com/owner/repo/pull/123",
                    "dataSource": {
                        "kind": "command",
                        "command": "gh pr view 123 --repo owner/repo --json state,reviewDecision,mergeable,statusCheckRollup --jq '{state, review: (.reviewDecision // \"PENDING\"), mergeable, failing: ([.statusCheckRollup[]? | select(.conclusion == \"FAILURE\")] | length), pending: ([.statusCheckRollup[]? | select(.status != \"COMPLETED\")] | length)}'",
                        "intervalSeconds": 300,
                        "parse": "json"
                    },
                    "template": {
                        "kind": "metrics",
                        "items": [
                            { "label": "State", "path": "/state", "emphasis": true, "toneMap": { "OPEN": "info", "MERGED": "success", "CLOSED": "danger" } },
                            { "label": "Review", "path": "/review", "toneMap": { "APPROVED": "success", "CHANGES_REQUESTED": "danger", "REVIEW_REQUIRED": "warning", "PENDING": "neutral" } },
                            { "label": "Failing checks", "path": "/failing", "format": "number", "toneMap": { "0": "success" }, "tone": "danger" },
                            { "label": "Running checks", "path": "/pending", "format": "number" }
                        ]
                    }
                }
            },
            "notes": "Command sources run locally through the user's shell with existing CLI auth (gh). They require user approval."
        },
        {
            "id": "weather",
            "useWhen": "The user asks about the weather or plans around it.",
            "call": {
                "action": "create",
                "card": {
                    "title": "Shanghai weather",
                    "icon": "sun",
                    "dataSource": {
                        "kind": "http",
                        "url": "https://api.open-meteo.com/v1/forecast?latitude=31.23&longitude=121.47&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1",
                        "intervalSeconds": 1800
                    },
                    "template": {
                        "kind": "metrics",
                        "layout": "grid",
                        "items": [
                            { "label": "Now", "path": "/current/temperature_2m", "format": "number", "digits": 1, "suffix": " °C", "emphasis": true },
                            { "label": "Feels like", "path": "/current/apparent_temperature", "format": "number", "digits": 1, "suffix": " °C" },
                            { "label": "High", "path": "/daily/temperature_2m_max/0", "format": "number", "digits": 0, "suffix": " °C" },
                            { "label": "Low", "path": "/daily/temperature_2m_min/0", "format": "number", "digits": 0, "suffix": " °C" },
                            { "label": "Rain chance", "path": "/daily/precipitation_probability_max/0", "format": "number", "suffix": "%" },
                            { "label": "Wind", "path": "/current/wind_speed_10m", "format": "number", "digits": 0, "suffix": " km/h" }
                        ]
                    }
                }
            }
        },
        {
            "id": "stock-quote",
            "useWhen": "The user tracks a stock, index, or currency pair.",
            "call": {
                "action": "create",
                "card": {
                    "title": "AAPL",
                    "icon": "trending-up",
                    "link": "https://finance.yahoo.com/quote/AAPL",
                    "dataSource": {
                        "kind": "http",
                        "url": "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d",
                        "headers": { "User-Agent": "Mozilla/5.0" },
                        "intervalSeconds": 120
                    },
                    "template": {
                        "kind": "metrics",
                        "items": [
                            { "label": "Price", "path": "/chart/result/0/meta/regularMarketPrice", "format": "currency", "currency": "USD", "emphasis": true },
                            { "label": "Previous close", "path": "/chart/result/0/meta/chartPreviousClose", "format": "currency", "currency": "USD" },
                            { "label": "Day high", "path": "/chart/result/0/meta/regularMarketDayHigh", "format": "currency", "currency": "USD" },
                            { "label": "Day low", "path": "/chart/result/0/meta/regularMarketDayLow", "format": "currency", "currency": "USD" }
                        ]
                    }
                }
            },
            "notes": "For derived values such as percent change, use a command source that prints the computed JSON, then bind with signTone: true."
        },
        {
            "id": "task-progress",
            "useWhen": "A long task (migration, batch job, multi-step plan) runs while the user works elsewhere.",
            "call": {
                "action": "create",
                "card": {
                    "title": "Migrating 240 files",
                    "icon": "rocket",
                    "template": { "kind": "progress", "valuePath": "/done", "maxPath": "/total", "statusPath": "/status" },
                    "data": { "done": 0, "total": 240, "status": "Starting" }
                }
            },
            "notes": "Advance it with update + patch.dataMerge, for example {\"done\": 120, \"status\": \"Rewriting imports\"}. Delete or hide it when finished."
        },
        {
            "id": "checklist",
            "useWhen": "The user must do several manual steps themselves (release checklist, setup steps).",
            "call": {
                "action": "create",
                "card": {
                    "title": "Release v2.3",
                    "icon": "list",
                    "template": { "kind": "checklist", "items": [
                        { "id": "notes", "text": "Review release notes" },
                        { "id": "tag", "text": "Push the v2.3.0 tag" },
                        { "id": "announce", "text": "Announce in #releases" }
                    ] }
                }
            },
            "notes": "The user can tick items on the card; read the current state with get."
        },
        {
            "id": "note",
            "useWhen": "Short reference info the user will need again soon (credentials location, port, command to run).",
            "call": {
                "action": "create",
                "card": { "title": "Local dev URLs", "icon": "note", "template": { "kind": "note", "text": "Web: http://localhost:5173\nAPI: http://localhost:8080" } }
            }
        },
        {
            "id": "custom-html",
            "useWhen": "No template fits. Write a small self-contained widget.",
            "call": {
                "action": "create",
                "card": {
                    "title": "Build queue",
                    "icon": "server",
                    "dataSource": { "kind": "http", "url": "https://example.com/queue.json", "intervalSeconds": 60 },
                    "template": { "kind": "custom", "html": "<div class=\"openbitfun-card-stack\"><div class=\"openbitfun-card-value\" id=\"count\">-</div><div class=\"openbitfun-card-muted\">jobs waiting</div></div><script>openbitfunCard.onData(function (payload) { document.getElementById('count').textContent = payload.data && payload.data.waiting != null ? payload.data.waiting : '-'; });</script>" }
                }
            },
            "notes": "Runs in an isolated sandbox without access to OpenBitFun. openbitfunCard.onData(cb) receives {data, card, error}; openbitfunCard.openLink(url) opens an http(s) link. Theme classes: openbitfun-card-stack, openbitfun-card-value, openbitfun-card-muted, openbitfun-card-row, openbitfun-card-good, openbitfun-card-bad; CSS variables follow the app theme."
        }
    ])
}

#[async_trait]
impl Tool for DesktopCardTool {
    fn name(&self) -> &str {
        "DesktopCard"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(format!(
            r#"Show small persistent cards on the user's desktop, outside the OpenBitFun window (like OS widgets). Cards survive app restarts, keep their position, and can be dragged, hidden, or deleted by the user.

Use a card whenever the user would otherwise have to come back and check on something: a reminder after some time, a scheduled job, a pull request's review/CI state, a deployment or long task's progress, weather, a stock price, a checklist of manual steps, or reference info needed again soon. Create one when the user asks, and also proactively when a task naturally produces something worth glancing at later. Prefer updating an existing card (list first) over creating near-duplicates, and delete cards that are no longer useful.

Actions:
- presets: return ready-to-use recipes (countdown, scheduled job, PR status, weather, stock, progress, checklist, note, custom HTML). Call it when unsure how to build a card.
- create: requires card. Returns the new cardId and shows the card.
- update: requires cardId and patch. Only provided fields change; null clears optional fields. patch.dataMerge shallow-merges into data (null removes a key).
- list / get: inspect cards, including the latest fetched data or fetch error and checklist state.
- show / hide: hiding keeps the card for later. delete: remove permanently.
- refresh: fetch the data source now.

Card fields: title (required), subtitle, icon ({icons}), accent (neutral|accent|info|success|warning|danger), template (required), data, dataSource, link (http/https opened from the card), width/height (logical px), alwaysOnTop (default true).

Templates (template.kind):
- countdown: durationSeconds | targetAt (ISO-8601 with offset) | targetAtMs, optional message, notify (default true: system notification when due).
- checklist: items [{{id, text, done}}]. The user can tick items.
- note: text (plain text, newlines kept).
- progress: value/max or valuePath/maxPath, optional status/statusPath.
- metrics: items [{{label, value | path, format (text|number|percent|currency|datetime|relativeTime), digits, currency, prefix, suffix, tone, toneMap {{"VALUE": tone}}, signTone, hint | hintPath, emphasis}}], layout list|grid.
- cronJob: jobId of a Cron job; shows next run and last result live.
- custom: html for a sandboxed widget; openbitfunCard.onData(cb) receives {{data, card, error}}.
Paths are JSON Pointers (e.g. /current/temperature_2m) into the card data. With a dataSource, data is the latest fetched value.

Data sources (dataSource.kind):
- http: url, optional headers, intervalSeconds (30-86400), parse json|text. Fetched from this computer.
- command: shell command run locally on this computer (sh -c on macOS/Linux, PowerShell on Windows), intervalSeconds (30-86400), optional cwd (defaults to the local workspace) and timeoutSeconds (max 120), parse json|text. Requires user approval; not allowed for remote workspaces. Prefer CLIs that already hold credentials (gh, kubectl) over putting secrets in http headers.

Cards are shown only on this desktop. They are unavailable for remote mobile or bot control turns because that user cannot see them."#,
            icons = DESKTOP_CARD_ICONS.join(", ")
        ))
    }

    fn short_description(&self) -> String {
        "Show persistent desktop cards (reminders, PR/CI status, progress, weather, prices, checklists) the user can glance at."
            .to_string()
    }

    fn input_schema(&self) -> Value {
        let card_properties = json!({
            "title": { "type": "string" },
            "subtitle": { "type": ["string", "null"] },
            "icon": { "type": ["string", "null"], "enum": DESKTOP_CARD_ICONS.iter().map(|icon| Value::String((*icon).to_string())).chain(std::iter::once(Value::Null)).collect::<Vec<_>>() },
            "accent": { "type": ["string", "null"], "enum": ["neutral", "accent", "info", "success", "warning", "danger", null] },
            "template": {
                "type": "object",
                "description": "Template object with kind: countdown, checklist, note, progress, metrics, cronJob, or custom. See the tool description for fields.",
                "properties": {
                    "kind": { "type": "string", "enum": ["countdown", "checklist", "note", "progress", "metrics", "cronJob", "custom"] }
                },
                "required": ["kind"]
            },
            "data": { "description": "Static data for template paths when there is no dataSource." },
            "dataSource": {
                "type": ["object", "null"],
                "description": "Periodic data source: {kind: http, url, headers?, intervalSeconds, parse?} or {kind: command, command, cwd?, intervalSeconds, timeoutSeconds?, parse?}.",
                "properties": {
                    "kind": { "type": "string", "enum": ["http", "command"] }
                },
                "required": ["kind"]
            },
            "link": { "type": ["string", "null"], "description": "http(s) URL opened from the card." },
            "width": { "type": "number" },
            "height": { "type": "number" },
            "alwaysOnTop": { "type": "boolean" }
        });
        let mut patch_properties = card_properties.clone();
        if let Some(object) = patch_properties.as_object_mut() {
            object.insert(
                "dataMerge".to_string(),
                json!({ "type": "object", "description": "Shallow-merged into data; null removes a key." }),
            );
        }
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["action"],
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["presets", "create", "update", "list", "get", "show", "hide", "delete", "refresh"]
                },
                "cardId": { "type": "string", "description": "Required for update, get, show, hide, delete, and refresh." },
                "card": {
                    "type": "object",
                    "description": "Required for create.",
                    "properties": card_properties,
                    "required": ["title", "template"]
                },
                "patch": {
                    "type": "object",
                    "description": "Required for update.",
                    "properties": patch_properties
                }
            }
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, input: Option<&Value>) -> bool {
        input
            .and_then(|input| input.get("action"))
            .and_then(Value::as_str)
            .is_some_and(|action| matches!(action, "presets" | "list" | "get"))
    }

    async fn is_enabled(&self) -> bool {
        if !desktop_card_host_available() {
            return false;
        }
        let Ok(service) = GlobalConfigManager::get_service().await else {
            return false;
        };
        service
            .get_config::<bool>(Some(DESKTOP_CARDS_CONFIG_PATH))
            .await
            .unwrap_or(true)
    }

    async fn is_available_in_context(&self, context: Option<&ToolUseContext>) -> bool {
        if context.is_some_and(is_remote_control_context) {
            return false;
        }
        self.is_enabled().await
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let Some(command) = command_source(input) else {
            return Ok(Vec::new());
        };
        let mut intent = PermissionIntent::new(
            "desktop_card_command",
            vec![format!("desktop-card:command:{command}")],
        );
        intent.save_resources.clear();
        intent
            .display_metadata
            .insert("requiresFreshApproval".to_string(), Value::Bool(true));
        intent.display_metadata.insert(
            "description".to_string(),
            Value::String(
                "Run this shell command periodically on this computer to refresh a desktop card"
                    .to_string(),
            ),
        );
        Ok(vec![intent])
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        if is_remote_control_context(context) {
            return Err(OpenBitFunError::tool(
                "DesktopCard cannot run from a remote mobile or bot controller because cards appear only on the host desktop, which that user cannot see. Tell the user in the reply instead, or schedule a Cron job for reminders."
                    .to_string(),
            ));
        }
        let action = input
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| OpenBitFunError::validation("Missing required field: action"))?;

        if action == "presets" {
            return Ok(vec![ToolResult::Result {
                data: json!({ "presets": presets() }),
                result_for_assistant: Some(format!(
                    "Desktop card presets (adapt titles, ids, URLs, and commands to the user's situation; replace placeholders):\n{}",
                    serde_json::to_string_pretty(&presets()).unwrap_or_default()
                )),
                image_attachments: None,
            }]);
        }

        let now = now_ms();
        let request = match action {
            "create" => {
                let mut draft = parse_draft(input.get("card").unwrap_or(&Value::Null), now)
                    .map_err(OpenBitFunError::validation)?;
                self.prepare_command_source(&mut draft.data_source, context)?;
                DesktopCardHostRequest::Create {
                    draft,
                    origin: DesktopCardOrigin {
                        session_id: context.session_id.clone(),
                        agent_type: context.agent_type.clone(),
                        workspace_path: context
                            .workspace
                            .as_ref()
                            .map(|workspace| workspace.root_path_string()),
                    },
                }
            }
            "update" => {
                let card_id = required_card_id(input)?;
                let mut patch = parse_patch(input.get("patch").unwrap_or(&Value::Null), now)
                    .map_err(OpenBitFunError::validation)?;
                if let Some(source) = patch.data_source.as_mut() {
                    self.prepare_command_source(source, context)?;
                }
                DesktopCardHostRequest::Update { card_id, patch }
            }
            "list" => DesktopCardHostRequest::List,
            "get" => DesktopCardHostRequest::Get {
                card_id: required_card_id(input)?,
            },
            "show" => DesktopCardHostRequest::Show {
                card_id: required_card_id(input)?,
            },
            "hide" => DesktopCardHostRequest::Hide {
                card_id: required_card_id(input)?,
            },
            "delete" => DesktopCardHostRequest::Delete {
                card_id: required_card_id(input)?,
            },
            "refresh" => DesktopCardHostRequest::Refresh {
                card_id: required_card_id(input)?,
            },
            other => {
                return Err(OpenBitFunError::validation(format!(
                    "Unsupported DesktopCard action: {other}"
                )))
            }
        };

        let result = invoke_desktop_card_host(request)
            .await
            .map_err(OpenBitFunError::tool)?;
        let assistant = render_result_for_assistant(action, &result);
        Ok(vec![ToolResult::Result {
            data: result,
            result_for_assistant: Some(assistant),
            image_attachments: None,
        }])
    }
}

impl DesktopCardTool {
    fn prepare_command_source(
        &self,
        source: &mut Option<DesktopCardDataSourceKind>,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<()> {
        let Some(DesktopCardDataSourceKind::Command { cwd, .. }) = source.as_mut() else {
            return Ok(());
        };
        if context.is_remote() {
            return Err(OpenBitFunError::tool(
                "Command data sources run on this computer, not on the remote workspace host, so they are not allowed for remote workspaces. Use an http data source, static data updated by you, or a Cron job instead."
                    .to_string(),
            ));
        }
        if cwd.is_none() {
            *cwd = context
                .workspace
                .as_ref()
                .map(|workspace| workspace.root_path_string());
        }
        Ok(())
    }
}

fn card_line(card: &Value) -> String {
    let id = card.get("id").and_then(Value::as_str).unwrap_or("?");
    let title = card.get("title").and_then(Value::as_str).unwrap_or("");
    let kind = card
        .pointer("/template/kind")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let visible = card
        .get("visible")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut line = format!(
        "- {id}: \"{title}\" ({kind}, {})",
        if visible { "shown" } else { "hidden" }
    );
    if let Some(error) = card.pointer("/lastData/error").and_then(Value::as_str) {
        line.push_str(&format!(", last fetch failed: {error}"));
    }
    line
}

fn render_result_for_assistant(action: &str, result: &Value) -> String {
    let card = result.get("card");
    let card_id = card
        .and_then(|card| card.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("?");
    match action {
        "create" => format!(
            "Created desktop card {card_id} and showed it on the user's desktop. Use this cardId for later update, hide, or delete."
        ),
        "update" => format!("Updated desktop card {card_id}."),
        "show" => format!("Desktop card {card_id} is now shown."),
        "hide" => format!("Desktop card {card_id} is hidden; it is kept and can be shown again."),
        "delete" => format!("Deleted desktop card {card_id}."),
        "refresh" => format!(
            "Refreshed desktop card {card_id}.\n{}",
            card.map(card_line).unwrap_or_default()
        ),
        "list" => {
            let cards = result
                .get("cards")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let enabled = result
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            if cards.is_empty() {
                "No desktop cards exist.".to_string()
            } else {
                let mut text = format!(
                    "{} desktop card(s){}:\n",
                    cards.len(),
                    if enabled {
                        ""
                    } else {
                        " (desktop cards are turned off in settings, so none are displayed)"
                    }
                );
                text.push_str(
                    &cards
                        .iter()
                        .map(card_line)
                        .collect::<Vec<_>>()
                        .join("\n"),
                );
                text
            }
        }
        _ => serde_json::to_string_pretty(result).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn context() -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: Some("Standard".to_string()),
            session_id: Some("session-1".to_string()),
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: Default::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: Default::default(),
            runtime_handles: Default::default(),
        }
    }

    fn remote_context() -> ToolUseContext {
        let mut remote = context();
        remote.workspace = Some(crate::agentic::WorkspaceBinding::new_remote(
            None,
            std::path::PathBuf::from("/srv/project"),
            "connection-1".to_string(),
            "Remote".to_string(),
            crate::service::remote_ssh::workspace_state::WorkspaceSessionIdentity {
                workspace_kind: openbitfun_core_types::WorkspaceKind::Remote,
                hostname: "remote.example".to_string(),
                logical_workspace_path: "/srv/project".to_string(),
                remote_connection_id: Some("connection-1".to_string()),
            },
        ));
        remote
    }

    #[test]
    fn countdown_accepts_duration_and_iso_targets() {
        let template =
            normalize_template_input(&json!({"kind": "countdown", "durationSeconds": 60}), 1_000)
                .unwrap();
        assert!(matches!(
            template,
            DesktopCardTemplateKind::Countdown {
                target_at_ms: 61_000,
                started_at_ms: Some(1_000),
                ..
            }
        ));
        let template = normalize_template_input(
            &json!({"kind": "countdown", "targetAt": "2030-01-01T00:00:00+00:00"}),
            1_000,
        )
        .unwrap();
        assert!(matches!(
            template,
            DesktopCardTemplateKind::Countdown {
                target_at_ms: 1_893_456_000_000,
                ..
            }
        ));
        assert!(normalize_template_input(&json!({"kind": "countdown"}), 1_000).is_err());
    }

    #[test]
    fn every_preset_call_is_a_valid_card() {
        for preset in presets().as_array().unwrap() {
            let card = preset.pointer("/call/card").unwrap();
            parse_draft(card, 1_000)
                .unwrap_or_else(|error| panic!("preset {} is invalid: {error}", preset["id"]));
        }
    }

    #[test]
    fn patch_requires_a_change_and_supports_clearing() {
        assert!(parse_patch(&json!({}), 0).is_err());
        let patch = parse_patch(&json!({"subtitle": null, "dataSource": null}), 0).unwrap();
        assert_eq!(patch.subtitle, Some(None));
        assert_eq!(patch.data_source, Some(None));
        assert!(parse_patch(&json!({"width": 300}), 0).is_err());
    }

    #[test]
    fn command_sources_always_require_fresh_approval() {
        let input = json!({
            "action": "create",
            "card": {
                "title": "PR",
                "template": {"kind": "note", "text": "x"},
                "dataSource": {"kind": "command", "command": "gh pr view 1", "intervalSeconds": 60}
            }
        });
        let intents = DesktopCardTool::new()
            .permission_intents(&input, &context())
            .unwrap();
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].resources, ["desktop-card:command:gh pr view 1"]);
        assert!(intents[0].save_resources.is_empty());
        assert_eq!(intents[0].display_metadata["requiresFreshApproval"], true);

        let static_card = json!({
            "action": "create",
            "card": {"title": "Note", "template": {"kind": "note", "text": "x"}}
        });
        assert!(DesktopCardTool::new()
            .permission_intents(&static_card, &context())
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn remote_control_turns_are_refused() {
        let mut remote_control = context();
        remote_control.custom_data.insert(
            TOOL_CONTEXT_REMOTE_FILE_DELIVERY_KEY.to_string(),
            Value::Bool(true),
        );
        assert!(
            !DesktopCardTool::new()
                .is_available_in_context(Some(&remote_control))
                .await
        );
        let error = DesktopCardTool::new()
            .call_impl(&json!({"action": "list"}), &remote_control)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("remote mobile or bot"));
    }

    #[tokio::test]
    async fn command_sources_are_refused_for_remote_workspaces() {
        let input = json!({
            "action": "create",
            "card": {
                "title": "Disk",
                "template": {"kind": "note", "text": "x"},
                "dataSource": {"kind": "command", "command": "df -h", "intervalSeconds": 60}
            }
        });
        let error = DesktopCardTool::new()
            .call_impl(&input, &remote_context())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("remote workspace"));
    }

    #[tokio::test]
    async fn presets_do_not_need_a_host() {
        let results = DesktopCardTool::new()
            .call_impl(&json!({"action": "presets"}), &context())
            .await
            .unwrap();
        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("result expected");
        };
        assert!(data["presets"].as_array().unwrap().len() >= 8);
    }
}
