//! Host-owned routing setup, readiness and immutable per-turn selection.

use super::*;
use crate::service::config::{
    get_global_config_service,
    types::{AIConfig, AuthConfig, ModelCapability},
};
use std::sync::Arc;

const SYSTEM_PROMPT: &str = include_str!("system_prompt.txt");

pub fn legacy_enabled() -> bool {
    std::env::var("OPENBITFUN_ROUND_ROUTER_URL").is_ok_and(|value| !value.trim().is_empty())
}

pub fn routing_enabled(mode: Option<&str>) -> OpenBitFunResult<bool> {
    match mode {
        Some("manual") => Ok(false),
        Some("smart") => Ok(true),
        None => Ok(legacy_enabled()),
        Some(_) => Err(OpenBitFunError::Configuration(
            "Unsupported model routing strategy; select manual or smart mode".into(),
        )),
    }
}

pub fn economy_model_id(config: &AIConfig, legacy: bool) -> OpenBitFunResult<String> {
    // Environment-only installations retain the original fast-to-primary fallback.
    let legacy_reference = legacy
        .then(|| config.resolve_model_selection("fast"))
        .flatten();
    let reference = if legacy {
        legacy_reference.as_deref()
    } else {
        config.default_models.economy.as_deref()
    };
    reference
        .and_then(|id| {
            config.models.iter().find(|model| {
                model.id == id
                    && model.enabled
                    && model.supports_capability(ModelCapability::TextChat)
            })
        })
        .map(|model| model.id.clone())
        .ok_or_else(|| {
            OpenBitFunError::Configuration(
                "Configure an enabled economy model before using smart mode".into(),
            )
        })
}

fn product_config(config: &AIConfig) -> OpenBitFunResult<HttpRoundModelRouterConfig> {
    let setup = &config.model_routing;
    let summary_model_id = setup
        .summary_enabled
        .then(|| economy_model_id(config, false))
        .transpose()?;
    let model = setup
        .router_model_id
        .as_deref()
        .and_then(|id| {
            config
                .models
                .iter()
                .find(|model| model.id == id && model.enabled)
        })
        .ok_or_else(|| {
            OpenBitFunError::Configuration(
                "Configure a Router service model in model settings".into(),
            )
        })?;
    if !matches!(model.auth, AuthConfig::ApiKey) {
        return Err(OpenBitFunError::Configuration(
            "Router requires an API-key service; subscription authentication is unsupported".into(),
        ));
    }
    if setup.tokenizer_path.trim().is_empty() {
        return Err(OpenBitFunError::Configuration(
            "Configure the Router tokenizer.json path on the execution host".into(),
        ));
    }
    if !(0.0..=1.0).contains(&setup.simple_threshold) || setup.timeout_ms == 0 {
        return Err(OpenBitFunError::Configuration(
            "Router threshold must be between 0 and 1 and timeout must be positive".into(),
        ));
    }
    if model
        .custom_request_body
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return Err(OpenBitFunError::Configuration(
            "Router models cannot override the classifier request body".into(),
        ));
    }
    let base = model
        .request_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&model.base_url)
        .trim_end_matches('/');
    let endpoint = if base.ends_with("/chat/completions") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    };
    Ok(HttpRoundModelRouterConfig {
        endpoint,
        model: model.model_name.clone(),
        system_prompt: SYSTEM_PROMPT.into(),
        api_key: (!model.api_key.is_empty()).then(|| model.api_key.clone()),
        timeout: Duration::from_millis(setup.timeout_ms),
        admission: RouterAdmissionLimits::from_env()?,
        recent_rounds: 3,
        simple_threshold: setup.simple_threshold,
        trace_path: None,
        context: RouterContextConfig {
            summary_enabled: setup.summary_enabled,
            summary_model_id,
            ..Default::default()
        },
        tokenizer_path: PathBuf::from(&setup.tokenizer_path),
        proxy: Some(config.proxy.clone()),
        custom_headers: model.custom_headers.clone().unwrap_or_default(),
        skip_ssl_verify: model.skip_ssl_verify,
    })
}

pub struct TurnRouting {
    pub router: Arc<dyn RoundModelRouter>,
    pub economy_model_id: String,
}

/// Cache only the transport/tokenizer, never a session context or a routing decision.
async fn configured_router(config: &AIConfig) -> OpenBitFunResult<Arc<HttpRoundModelRouter>> {
    static CACHE: OnceLock<tokio::sync::Mutex<Option<(String, Arc<HttpRoundModelRouter>)>>> =
        OnceLock::new();
    let router_config = if config.model_routing.router_model_id.is_some() {
        product_config(config)?
    } else {
        HttpRoundModelRouterConfig::from_env()?.ok_or_else(|| {
            OpenBitFunError::Configuration("Configure a Router service in model settings".into())
        })?
    };
    // This private in-memory identity includes credential/proxy revisions. Never log it.
    let key = format!("{router_config:?}");
    let cache = CACHE.get_or_init(|| tokio::sync::Mutex::new(None));
    if let Some((saved, router)) = cache.lock().await.as_ref() {
        if *saved == key {
            return Ok(router.clone());
        }
    }
    let router = Arc::new(
        tokio::task::spawn_blocking(move || HttpRoundModelRouter::new(router_config))
            .await
            .map_err(|error| {
                OpenBitFunError::Configuration(format!("Failed to initialize Router: {error}"))
            })??,
    );
    *cache.lock().await = Some((key, router.clone()));
    Ok(router)
}

pub async fn prepare_turn(
    mode: Option<&str>,
    eligible: bool,
) -> OpenBitFunResult<Option<TurnRouting>> {
    if !eligible || !routing_enabled(mode)? {
        return Ok(None);
    }
    let config = get_global_config_service()
        .await?
        .get_effective_ai_config()
        .await?;
    let economy_model_id = economy_model_id(&config, mode.is_none())?;
    let router = configured_router(&config).await?;
    Ok(Some(TurnRouting {
        router,
        economy_model_id,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoutingStatus {
    pub api_version: u32,
    pub mode: String,
    pub default_mode: String,
    pub ready: bool,
    pub issue: Option<String>,
    /// Only an explicit protocol probe establishes a connection, not a config read.
    pub connected: Option<bool>,
    pub summary_enabled: bool,
    /// Presence advertises support for the smart-session subagent default setting.
    pub subagent_model: String,
}

pub async fn session_status(
    session: Option<&crate::agentic::core::Session>,
    probe: bool,
) -> OpenBitFunResult<ModelRoutingStatus> {
    let eligible = session.is_none_or(session_eligible);
    status(
        session.and_then(|session| session.config.model_routing.as_deref()),
        eligible,
        probe,
    )
    .await
}

pub fn session_eligible(session: &crate::agentic::core::Session) -> bool {
    session.kind != crate::agentic::core::SessionKind::Subagent
        && session.config.model_binding_policy
            != crate::agentic::core::SessionModelBindingPolicy::ApprovedImmutable
        && matches!(
            session.config.agent_route_owner,
            crate::agentic::core::SessionAgentRouteOwner::Local
        )
}

pub async fn status(
    mode: Option<&str>,
    eligible: bool,
    probe: bool,
) -> OpenBitFunResult<ModelRoutingStatus> {
    let config = get_global_config_service()
        .await?
        .get_effective_ai_config()
        .await?;
    let default_mode = config
        .model_routing
        .default_mode
        .clone()
        .unwrap_or_else(|| {
            if legacy_enabled() {
                "smart".into()
            } else {
                "manual".into()
            }
        });
    let mut result = ModelRoutingStatus {
        api_version: 1,
        mode: mode
            .unwrap_or(if legacy_enabled() { "smart" } else { "manual" })
            .into(),
        default_mode,
        ready: false,
        issue: None,
        connected: None,
        summary_enabled: config.model_routing.summary_enabled,
        subagent_model: config.model_routing.subagent_model.clone(),
    };
    let check = async {
        if !eligible { return Err(OpenBitFunError::Configuration("Smart mode is unavailable for external agents, subagents and immutable dispatched sessions".into())); }
        economy_model_id(&config, mode.is_none() && legacy_enabled())?;
        if config.resolve_model_selection("primary").is_none() {
            return Err(OpenBitFunError::Configuration("Configure an enabled primary model before using smart mode".into()));
        }
        let router = configured_router(&config).await?;
        if probe {
            let prediction = router.predict("Task: inspect a file and explain its purpose", None).await?;
            if prediction.simple_probability.is_none() {
                return Err(OpenBitFunError::Configuration("Router protocol mismatch: classifier token IDs and logprobs are required".into()));
            }
            result.connected = Some(true);
        }
        Ok::<(), OpenBitFunError>(())
    }.await;
    match check {
        Ok(()) => result.ready = true,
        Err(error) => {
            result.issue = Some(error.to_string());
            if probe {
                result.connected = Some(false);
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::config::types::AIModelConfig;

    #[test]
    fn restored_subagents_and_immutable_jobs_never_enter_smart_routing() {
        use crate::agentic::core::{
            Session, SessionConfig, SessionKind, SessionModelBindingPolicy,
        };
        let mut session = Session::new("test".into(), "Standard".into(), SessionConfig::default());
        assert!(session_eligible(&session));
        session.kind = SessionKind::Subagent;
        assert!(!session_eligible(&session));
        session.kind = SessionKind::Standard;
        session.config.model_binding_policy = SessionModelBindingPolicy::ApprovedImmutable;
        assert!(!session_eligible(&session));
    }

    #[test]
    fn product_router_uses_host_model_credentials_and_validates_auxiliary_configuration() {
        let mut config = AIConfig::default();
        config.models.push(AIModelConfig {
            id: "router-service".into(),
            enabled: true,
            base_url: "https://router.example.invalid/v1/".into(),
            model_name: "router-fixture".into(),
            api_key: "fixture-token".into(),
            ..Default::default()
        });
        config.model_routing.router_model_id = Some("router-service".into());
        config.model_routing.tokenizer_path = "/execution-host/tokenizer.json".into();
        let router = product_config(&config).unwrap();
        assert_eq!(
            router.endpoint,
            "https://router.example.invalid/v1/chat/completions"
        );
        assert_eq!(router.api_key.as_deref(), Some("fixture-token"));
        assert_eq!(router.model, "router-fixture");
        assert!(!router.context.summary_enabled);
        config.model_routing.summary_enabled = true;
        assert!(product_config(&config)
            .unwrap_err()
            .to_string()
            .contains("economy model"));
        config.models.push(AIModelConfig {
            id: "economy-fixture".into(),
            enabled: true,
            ..Default::default()
        });
        config.default_models.economy = Some("economy-fixture".into());
        let router = product_config(&config).unwrap();
        assert_eq!(
            router.context.summary_model_id.as_deref(),
            Some("economy-fixture")
        );
        assert!(config.default_models.fast.is_none());
        config.model_routing.summary_enabled = false;
        config.models[0].custom_request_body = Some("{}".into());
        assert!(product_config(&config).is_err());
        config.models[0].custom_request_body = None;
        config.model_routing.simple_threshold = f64::NAN;
        assert!(product_config(&config).is_err());
    }

    #[test]
    fn manual_never_uses_environment_and_unknown_modes_are_explicit() {
        assert!(!routing_enabled(Some("manual")).unwrap());
        assert!(routing_enabled(Some("smart")).unwrap());
        assert!(routing_enabled(Some("future-mode")).is_err());
    }

    #[test]
    fn economy_is_independent_of_fast_and_never_silently_falls_back() {
        let mut config = AIConfig::default();
        for id in ["primary", "worker", "economical"] {
            config.models.push(AIModelConfig {
                id: id.into(),
                enabled: true,
                ..Default::default()
            });
        }
        config.default_models.primary = Some("primary".into());
        config.default_models.fast = Some("worker".into());
        assert!(economy_model_id(&config, false).is_err());
        assert_eq!(economy_model_id(&config, true).unwrap(), "worker");
        config.default_models.fast = None;
        assert_eq!(economy_model_id(&config, true).unwrap(), "primary");
        config.default_models.economy = Some("economical".into());
        assert_eq!(economy_model_id(&config, false).unwrap(), "economical");
        config.models[2].enabled = false;
        assert!(economy_model_id(&config, false).is_err());
    }
}
