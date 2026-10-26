//! MiniAppBrowser tool — drive a MiniApp the way BrowserUse drives a Web page.
//!
//! A MiniApp is a Web page hosted by the product window, so the Agent controls
//! it with inspect / locate / input / wait semantics instead of editing source
//! or touching host paths. Layering:
//!
//! - [`crate::agentic::tools::miniapp_surface`] owns the host
//!   port, sessions, target handles, capability facts, and the method whitelist.
//! - [`actions`] owns what each Agent action means and forwards it.
//! - [`result`] owns the model-facing envelopes and node rendering.
//! - this module owns only the `Tool` contract surface.

mod actions;
mod result;

use crate::agentic::tools::framework::{
    Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::agentic::tools::miniapp_surface::miniapp_web_host_available;
use crate::util::errors::OpenBitFunResult;
use actions::{action_from_input, dispatch, Action, ACTIONS};
use async_trait::async_trait;
use openbitfun_product_domains::miniapp::web_surface::{
    MINIAPP_WEB_DEFAULT_CAPTURE_EDGE, MINIAPP_WEB_DEFAULT_WAIT_MS, MINIAPP_WEB_MAX_CAPTURE_EDGE,
    MINIAPP_WEB_MAX_DEPTH, MINIAPP_WEB_MAX_NODES, MINIAPP_WEB_MAX_WAIT_MS,
    MINIAPP_WEB_MAX_WATCH_MS,
};
use serde_json::{json, Value};

const TOOL_NAME: &str = "MiniAppBrowser";

pub struct MiniAppBrowserTool;

impl MiniAppBrowserTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MiniAppBrowserTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for MiniAppBrowserTool {
    fn name(&self) -> &str {
        TOOL_NAME
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(format!(
            r#"Operate an installed MiniApp like a Web page: open it, read its structure, locate elements, then click, type, send keys, or scroll. This is the primary way to use a MiniApp; do not modify its source unless the user asks.

`open` drives the same copy the user sees, and picks where that copy lives in this order: the app's own window if it is already open, the tab already showing it, the desktop app the user published from this MiniApp (launched as a normal app), and only then a new tab. Never launch a copy of the app in a separate or headless browser: that runs something the user cannot see, and its state never matches the app on their screen.

Addressing an app: call `apps` when you do not know the id. It lists installed MiniApps with the id that addresses each one. `open` accepts `appId` or the app's `name`, resolves an exact id or name first, accepts a unique partial name, and reports candidates instead of guessing when several apps match. If the app is already open in one of its own windows or in a tab, `open` attaches to that presentation instead of starting a second copy, so you drive the instance the user has on screen.

Typical loop: open(appId) -> inspect -> find (or reuse targetIds from inspect) -> click/type/read -> wait -> inspect.
For any MiniApp task, first check whether the user has provided or authorized access to the app source through the available workspace/context. When source is available, inspect the relevant UI, data, state transitions, and action handlers; derive the shortest reliable sequence that fulfills the request and execute it directly. Do not spend turns repeatedly probing behavior that source inspection can settle. Use the live MiniApp to enter the workflow and confirm completion or meaningful checkpoints. If source is unavailable, use DOM or declared bridge actions to identify a direct path; use observe-act cycles only for genuinely dynamic or uncertain steps. Prefer structured state over pixels; screenshot is a fallback only when the available state cannot confirm progress.

Following something that keeps changing: `watch_state` samples the app's own state inside one call (window up to {MINIAPP_WEB_MAX_WATCH_MS}ms, deduplicated by state) and returns the timeline. Use it instead of calling `observe_bridge` in a loop, and instead of writing a harness script. Do not load the app's HTML in a separate browser, Chrome, CDP, or headless run to "verify" it: that renders a copy the user cannot see, on a different clock, with no bridge and no host state, so its result is not evidence about the app they have open. If you need a long observation window, ask `watch_state` for it.

Semantics:
- One sessionId is bound to one appId. Later calls only act on that app; reopening the app replaces the older session.
- inspect returns a bounded role/name/testId tree with a short-lived targetId per node. Defaults: at most {MINIAPP_WEB_MAX_NODES} nodes and depth {MINIAPP_WEB_MAX_DEPTH}.
- find locator priority: testId, then accessibility role+name, then name/text, then a CSS selector as a compatibility fallback.
- targetIds expire (10 minutes), die on reload or re-render, and never cross MiniApps. On STALE_TARGET or UNKNOWN_TARGET, call inspect again.
- wait gives animations, network calls, and game loops an observation interval ({MINIAPP_WEB_DEFAULT_WAIT_MS}ms default, {MINIAPP_WEB_MAX_WAIT_MS}ms max); re-observe afterwards.
- screenshot captures the largest canvas in the frame now (longest side {MINIAPP_WEB_DEFAULT_CAPTURE_EDGE}px by default, {MINIAPP_WEB_MAX_CAPTURE_EDGE}px max) and returns it as an image you can look at. Use it only when DOM and bridge observations cannot answer the next decision; screenshots are slower, turn-paced samples rather than a live game feed.
- close releases only this control session. The app stays open for the user; dismiss it from the UI when the user asks.

Capability honesty:
- A readable MiniApp reports dom/accessibility/input and supports the full loop with no source change.
- A canvas-backed MiniApp has no readable structure: `inspect` sees only the canvas element. Start with `observe_bridge` for declared state and animation activity, and use `watch_state` when a bounded timeline helps. Use `act_bridge` for app-declared semantic actions or `key`/`click` for ordinary controls. If those observations do not show enough state to choose an action, use `screenshot` as a fallback; sampling pixels is turn-paced, not continuous.
- A MiniApp running in the strict (opaque-origin) profile reports no DOM and its pixels cannot be read. It is still observable through `observe_bridge` (automatic observation, plus `state` when the app declares it) and actionable through `act_bridge` when the app declares actions. If the app declares nothing, automatic observation still reports animation activity and input echo, but cannot report Canvas text or application state; say what is missing instead of guessing.
- A MiniApp presented in its own window (`surface.kind` is `window`) answers the bridge and host-routed key input, but not the document: `observe_bridge`, `watch_state`, `act_bridge`, and `key` work there, while `inspect`, `find`, `click`, `type`, `scroll`, and `screenshot` are refused with CAPABILITY_MISSING because a separate window cannot take synthetic DOM input or hand out pixels. That is a transport limit, not a broken app: use the app's bridge state plus `key`, or ask the user to move it to a tab when DOM/pixels are required.

Scope: this tool cannot read host paths, credentials, or other MiniApps, and it has no `evaluate` action, so it cannot run arbitrary JavaScript. `screenshot` returns pixels only: it never exposes the app's variables, scores, or timers unless the app declares them through its bridge.

Live state and auto-play:
- Observation works on an unchanged MiniApp. Every frame already reports automatic observations through `observe_bridge`: whether animation callbacks are running (`frames`, `frameAgeMs`), whether dispatched input actually reached it (`input`, `inputCount`), plus viewport and canvas sizes for mapping coordinates onto a screenshot. `state` is null in that mode and `canvasTextUnavailable` is true: activity is not evidence of scores, lives, game phase, or current Canvas text. No app edit or manifest permission is required for activity observations.
- An app that wants labeled, authoritative state announces it from inside itself: `window.app.agent.expose({{ observe: () => ({{ score, lives, wave }}), act: (action) => ... }})`. The `window.app` runtime is injected into every MiniApp frame, including the strict runtime. Once the app calls `expose`, `observe_bridge` returns that JSON under `state` and `act_bridge` runs the actions the app itself accepts. The same call may list `actions: ['restart', 'autoplay']`, the action types it answers, which then arrive as `declaredActions`. That is what makes a fast-moving app playable at full speed: read real state instead of sampling frames, and let the app resolve timing inside one call.
- When the user authorizes source changes, add `expose` through the MiniApp authoring owner (update its source, then finalize the file edit) to observe application state: expose bounded state such as player position, score, lives, and game phase, plus semantic actions such as jump/restart when the game can apply them itself. This is faster and more reliable than pixel sampling. Do not try to inject scripts from this tool; there is no `evaluate`.
- The action vocabulary belongs to the app. `observe_bridge` returns `declaredActions`, the action types the app said its `act` accepts, so read them there first and use those names; an empty list means the app declared nothing, not that it accepts nothing. Do not assume installed-app source is present in the workspace or bypass host boundaries to find it. When source has been explicitly provided or authorized and is available through the normal file/context tools, use it to plan instead of guessing. Keep source-derived actions bounded and execute them against the user's live instance; use bridge observations to confirm the outcome, not as a mandatory round trip after every input.
- A fresh `open` on the app's own window may report `bridgeAnnounced: false` and empty capabilities: the window answers the bridge, the document just has not declared anything yet in this session. `observe_bridge` is the authoritative answer, so call it before concluding the surface is inert.
- Without useful bridge state the limit is turn-paced: one small input, then observe again; use a screenshot only when pixels are needed. Say so plainly instead of claiming you can follow continuous motion."#
        ))
    }

    fn short_description(&self) -> String {
        "Open, read, and interact with a MiniApp in the user's own window, as a Web page."
            .to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["action"],
            "properties": {
                "action": { "type": "string", "enum": ACTIONS },
                "appId": { "type": "string", "description": "open: installed MiniApp id. Call apps when the id is unknown." },
                "name": { "type": "string", "description": "open: installed MiniApp display name, used when the id is unknown. An exact name wins; a partial name must match exactly one app." },
                "sessionId": { "type": "string", "description": "Session returned by open. Required by every action except open, sessions, and apps." },
                "targetId": { "type": "string", "description": "Short-lived target returned by inspect or find." },
                "locator": {
                    "type": "object",
                    "description": "find: highest-priority axis first. Provide testId, or role with name, or text, or a selector fallback.",
                    "properties": {
                        "testId": { "type": "string" },
                        "role": { "type": "string" },
                        "name": { "type": "string" },
                        "text": { "type": "string" },
                        "selector": { "type": "string", "description": "Compatibility fallback only." },
                        "exact": { "type": "boolean", "description": "Require exact name/text matches instead of substrings." }
                    },
                    "additionalProperties": false
                },
                "attribute": { "type": "string", "description": "read: optional attribute name to return alongside text and value." },
                "text": { "type": "string", "description": "type: text to enter into the target." },
                "clear": { "type": "boolean", "description": "type: replace the existing value (default true)." },
                "key": { "type": "string", "description": "key: DOM key name such as Enter, Escape, ArrowLeft, Space, or a single character." },
                "modifiers": {
                    "type": "array",
                    "items": { "type": "string", "enum": ["Alt", "Control", "Meta", "Shift"] },
                    "description": "key: modifiers held while the key is sent."
                },
                "holdMs": { "type": "number", "description": "key: keep the key down this long (0-2000ms) before releasing it. Game loops read held input, so a movement key usually needs a hold." },
                "maxEdge": { "type": "number", "description": "screenshot: longest side of the returned image in pixels (320-1024, default 900)." },
                "deltaX": { "type": "number", "description": "scroll: horizontal delta in pixels." },
                "deltaY": { "type": "number", "description": "scroll: vertical delta in pixels." },
                "durationMs": { "type": "number", "description": "wait: observation interval in milliseconds. watch_state: length of the sampling window (250-120000ms, default 20000)." },
                "pollMs": { "type": "number", "description": "watch_state: sampling interval inside the window (250ms-120000ms, default 1000). Samples are deduplicated by state, so a quiet app returns few." },
                "bridgeAction": {
                    "type": "object",
                    "description": "act_bridge: MiniApp-declared semantic action, for example {\"type\":\"restart\"}.",
                    "properties": { "type": { "type": "string" } },
                    "required": ["type"],
                    "additionalProperties": true
                }
            }
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        false
    }

    async fn is_enabled(&self) -> bool {
        miniapp_web_host_available()
    }

    async fn description_with_context(
        &self,
        context: Option<&ToolUseContext>,
    ) -> OpenBitFunResult<String> {
        let mut description = self.description().await?;
        if !miniapp_web_host_available() {
            description.push_str(
                "\n\nNo MiniApp Web surface host is installed in this runtime. Controlling a MiniApp requires an active Desktop product surface; do not attempt it from this session.",
            );
        } else if context.map(ToolUseContext::is_remote).unwrap_or(false) {
            description.push_str(
                "\n\n**Remote workspace:** the MiniApp surface belongs to the controller window. This tool drives that controller-local surface and never proxies a remote app.",
            );
        }
        Ok(description)
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        if action_from_input(input).is_some() {
            return ValidationResult::default();
        }
        ValidationResult {
            result: false,
            message: Some(format!(
                "Missing or unsupported action. Supported actions: {}.",
                ACTIONS.join(", ")
            )),
            error_code: None,
            meta: None,
        }
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        match action_from_input(input) {
            Some(action) => format!("{TOOL_NAME}: {}", action.as_str()),
            None => TOOL_NAME.to_string(),
        }
    }

    fn render_result_for_assistant(&self, output: &Value) -> String {
        if output.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            return output
                .get("data")
                .map(Value::to_string)
                .unwrap_or_else(|| output.to_string());
        }
        let error = &output["error"];
        let mut summary = format!(
            "{}: {}",
            error["code"].as_str().unwrap_or("HOST_ERROR"),
            error["message"].as_str().unwrap_or_default()
        );
        if let Some(hints) = error["hints"].as_array() {
            for hint in hints.iter().filter_map(Value::as_str) {
                summary.push_str("\n- ");
                summary.push_str(hint);
            }
        }
        summary
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let Some(action) = action_from_input(input) else {
            return Ok(result::err_response(
                "?",
                openbitfun_product_domains::miniapp::web_surface::MiniAppWebErrorCode::InvalidParams,
                "Missing or unsupported action.",
                &[ACTIONS.join(", ").as_str()],
            ));
        };
        // Same gate the browser-use loop applies to page screenshots: a capture
        // the model cannot see is not an observation, so refuse it up front
        // instead of spending a round trip on pixels that get dropped.
        if action == Action::Screenshot {
            if let Some(reason) = context.image_observation_unavailable_reason() {
                return Ok(result::ok_response(
                    action.as_str(),
                    json!({
                        "sessionId": input.get("sessionId").cloned().unwrap_or(Value::Null),
                        "screenshotUnavailable": true,
                        "reason": reason,
                    }),
                    format!(
                        "Screenshots cannot reach this session's model ({reason}). Observe a readable MiniApp with inspect and read, or ask the app for bridge state via observe_bridge. Do not retry screenshot."
                    ),
                ));
            }
        }
        Ok(dispatch(action, input).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::tools::implementations::miniapp_browser::actions::Action;

    #[test]
    fn schema_and_dispatcher_agree_on_the_action_set() {
        let schema = MiniAppBrowserTool::new().input_schema();
        let published = schema["properties"]["action"]["enum"]
            .as_array()
            .expect("action enum")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        assert_eq!(
            published,
            ACTIONS
                .iter()
                .map(|name| name.to_string())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn document_actions_are_behind_the_readable_surface_gate_but_key_is_not() {
        for action in [
            Action::Inspect,
            Action::Find,
            Action::Read,
            Action::Click,
            Action::Type,
            Action::Scroll,
            // Pixels can only be read from a frame this window may inspect, so a
            // strict-runtime MiniApp cannot be screenshotted either.
            Action::Screenshot,
        ] {
            assert!(
                action.requires_dom(),
                "{action:?} must require a readable DOM"
            );
        }
        for action in [
            Action::Key,
            Action::Wait,
            Action::ObserveBridge,
            Action::ActBridge,
        ] {
            assert!(!action.requires_dom(), "{action:?} must not require a DOM");
        }
    }

    #[tokio::test]
    async fn unknown_actions_are_rejected_during_validation() {
        let tool = MiniAppBrowserTool::new();
        let validation = tool.validate_input(&json!({}), None).await;
        assert!(!validation.result);
        assert!(validation
            .message
            .unwrap_or_default()
            .contains("observe_bridge"));

        let accepted = tool
            .validate_input(&json!({ "action": "inspect" }), None)
            .await;
        assert!(accepted.result);
    }

    #[tokio::test]
    async fn description_prefers_source_derived_workflows_when_authorized() {
        let description = MiniAppBrowserTool::new()
            .description()
            .await
            .expect("tool description");
        assert!(description.contains("For any MiniApp task"));
        assert!(description.contains("derive the shortest reliable sequence"));
        assert!(description.contains("genuinely dynamic or uncertain steps"));
        assert!(description.contains("Do not assume installed-app source is present"));
    }
}
