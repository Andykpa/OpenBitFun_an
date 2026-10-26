import { useEffect, useRef, useState } from 'react';
import { Button, Combobox, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogHeading, DialogTitle, Field, Select } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { aiApi, type ConnectionTestResult } from '@/infrastructure/api/service-api/AIApi';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';
import { translateConnectionTestMessage } from '@/shared/utils/aiConnectionTestMessages';
import { configManager } from '../services/ConfigManager';
import type { AIModelConfig, DefaultModelsConfig, ModelRoutingConfig } from '../types';
import { filterSelectableTextChatModels } from '../services/modelCategory';
import { useModelSelectPresentation } from './ModelSelectPresentation';
import './ModelRouterSettings.scss';

const DEFAULTS: ModelRoutingConfig = { default_mode: null, router_model_id: null, simple_threshold: 0.75, timeout_ms: 10000, summary_enabled: true };
const log = createLogger('ModelRouterSettings');
const CHECK_ROLES = ['primary', 'economy', 'router'] as const;
type CheckRole = typeof CHECK_ROLES[number];
type ConnectionCheck = {
  state: 'checking' | 'connected' | 'failed' | 'unconfigured';
  detail?: string;
};
type ConnectionChecks = Record<CheckRole, ConnectionCheck>;

/** Router configuration belongs to the selected execution host. */
export function ModelRouterSettings({ models, onClose, onSaved, onManageModels }: {
  models: AIModelConfig[]; onClose: () => void; onSaved: () => void; onManageModels?: () => void;
}) {
  const { t } = useI18n('settings/models');
  const { t: tModels } = useI18n('settings/default-model');
  const { buildModelOption } = useModelSelectPresentation();
  const [surface] = useState(getActiveSurfaceScope);
  const [draft, setDraft] = useState<ModelRoutingConfig | null>(null);
  const [roleDraft, setRoleDraft] = useState<DefaultModelsConfig | null>(null);
  const [initialRoles, setInitialRoles] = useState<DefaultModelsConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [checks, setChecks] = useState<ConnectionChecks | null>(null);
  const checkRun = useRef(0);
  useEffect(() => () => { checkRun.current += 1; }, []);
  const clearChecks = () => { checkRun.current += 1; setChecks(null); setMessage(''); };
  useEffect(() => {
    let active = true;
    void configManager.getConfigs(['ai.model_routing', 'ai.default_models']).then(values => {
      if (active && surface.isCurrent()) {
        if (!values['ai.model_routing'] || !values['ai.default_models']) throw new Error('Incomplete smart-mode configuration');
        setDraft({ ...DEFAULTS, ...values['ai.model_routing'] as ModelRoutingConfig });
        const roles = values['ai.default_models'] as DefaultModelsConfig;
        setRoleDraft({ ...roles }); setInitialRoles({ ...roles });
      }
    }).catch(error => {
      if (active && surface.isCurrent()) {
        log.warn('Failed to load smart-mode configuration', { error });
        setMessage(t('router.loadFailed'));
      }
    });
    return () => { active = false; };
  }, [surface, t]);
  const checkConnections = async (roles: DefaultModelsConfig, isCurrent: () => boolean) => {
    const update = (role: CheckRole, check: ConnectionCheck) => {
      if (isCurrent()) setChecks(current => current && { ...current, [role]: check });
    };
    setChecks({ primary: { state: 'checking' }, economy: { state: 'checking' }, router: { state: 'checking' } });
    // The same concrete model may fill both roles; test it once on this host.
    const requests = new Map<string, Promise<ConnectionTestResult>>();
    const selectableModels = filterSelectableTextChatModels(models);
    const modelChecks = (['primary', 'economy'] as const).map(async role => {
      const model = selectableModels.find(item => item.id === roles[role] && item.enabled);
      if (!model?.id) { update(role, { state: 'unconfigured' }); return; }
      try {
        let request = requests.get(model.id);
        if (!request) { request = aiApi.testAIConfigConnection(model); requests.set(model.id, request); }
        const result = await request;
        update(role, {
          state: result.success ? 'connected' : 'failed',
          detail: result.success ? undefined : translateConnectionTestMessage(result.message_code, t),
        });
      } catch {
        // Provider responses and wrapped errors can contain credentials/configuration.
        update(role, { state: 'failed' });
        log.warn('Smart-mode model connection check failed', { role });
      }
    });
    const routerCheck = async () => {
      try {
        const status = await agentAPI.getModelRoutingStatus({ probe: true });
        update('router', { state: status.connected ? 'connected' : 'failed' });
      } catch {
        update('router', { state: 'failed' });
        log.warn('Smart-mode Router connection check failed');
      }
    };
    await Promise.allSettled([...modelChecks, routerCheck()]);
  };
  const save = async (probe: boolean) => {
    if (!draft || !roleDraft || !initialRoles || busy || !surface.isCurrent()) return;
    const run = ++checkRun.current;
    const isCurrent = () => run === checkRun.current && surface.isCurrent();
    setBusy(true); setMessage(''); setChecks(null);
    let failureMessage = t('router.loadFailed');
    try {
      // Feature negotiation precedes any write, including on older peer hosts.
      const support = await agentAPI.getModelRoutingStatus();
      if (!isCurrent()) return;
      if (support.apiVersion !== 1) { setMessage(t('router.unsupported')); return; }
      const requireTokenBudgetSupport = (current: ModelRoutingConfig) => {
        if (support.estimatedTokenBudgetSupported !== true
          && (typeof current.tokenizer_path !== 'string' || !current.tokenizer_path.trim())) {
          failureMessage = t('router.tokenBudgetUnsupported');
          throw new Error('Execution host requires a Router tokenizer file');
        }
      };
      if (support.estimatedTokenBudgetSupported !== true) {
        // Bypass the editor/cache snapshot before writing either model roles or routing.
        const current: unknown = await configAPI.getConfig('ai.model_routing');
        if (!isCurrent()) return;
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
          throw new Error('Router configuration is unavailable on the execution host');
        }
        requireTokenBudgetSupport(current as ModelRoutingConfig);
      }
      failureMessage = t('router.saveFailed');
      const changedRoles = Object.fromEntries((['primary', 'economy'] as const)
        .filter(role => (roleDraft[role] || null) !== (initialRoles[role] || null))
        .map(role => [role, roleDraft[role] || null]));
      let savedRoles = roleDraft;
      if (Object.keys(changedRoles).length) {
        savedRoles = await configManager.updateConfig<DefaultModelsConfig>('ai.default_models', current => ({ ...current, ...changedRoles }));
        if (!isCurrent()) return;
        setInitialRoles({ ...roleDraft });
        onSaved();
      }
      await configManager.updateConfig<ModelRoutingConfig>('ai.model_routing', current => {
        // Recheck the fresh mutation value in case a legacy path changed after validation.
        requireTokenBudgetSupport(current);
        return {
          ...DEFAULTS, ...current, router_model_id: draft.router_model_id || null,
          // Keep automatic history preparation enabled on older execution hosts too.
          summary_enabled: true,
        };
      });
      if (!isCurrent()) return;
      onSaved();
      if (probe) {
        failureMessage = t('router.checkFailed');
        await checkConnections(savedRoles, isCurrent);
      } else onClose();
    } catch (error) {
      if (isCurrent()) {
        log.warn('Failed to save or check smart-mode configuration', { error });
        setMessage(failureMessage);
      }
    } finally { if (isCurrent()) setBusy(false); }
  };
  const saving = busy && !checks;
  return <Dialog open size="md" closeOnEscape={!saving} closeOnPointerOutside={false} onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <DialogHeader><DialogHeading><DialogTitle>{t('router.title')}</DialogTitle></DialogHeading><DialogClose disabled={saving} /></DialogHeader>
    <DialogBody>
      <div className="model-router-settings" data-openbitfun-component="model-router-settings" data-openbitfun-part="root">
        <div className="model-router-settings__models">
          {(['primary', 'economy'] as const).map(role => <Field key={role} label={tModels(`core.${role}.label`)} controlWidth="fill">
            <Combobox size="sm" aria-label={tModels(`core.${role}.label`)} value={roleDraft?.[role] ?? ''}
              disabled={busy || !roleDraft} placeholder={tModels(`core.${role}.placeholder`)}
              options={filterSelectableTextChatModels(models).map(buildModelOption)}
              onValueChange={value => { clearChecks(); setRoleDraft(current => current && { ...current, [role]: String(Array.isArray(value) ? value[0] ?? '' : value) || null }); }} />
          </Field>)}
        </div>
        <Field label={t('router.service')} description={t('router.serviceHint')} controlWidth="fill">
          <Select size="sm" aria-label={t('router.service')} value={draft?.router_model_id ?? ''} disabled={busy || !draft}
            onValueChange={value => { clearChecks(); setDraft(current => current && { ...current, router_model_id: String(value) || null }); }}
            options={[{ value: '', label: t('router.unconfigured') }, ...models.filter((model): model is AIModelConfig & { id: string } => Boolean(model.id) && model.enabled && (!model.auth || model.auth.type === 'api_key'))
              .map(model => ({ value: model.id, label: `${model.model_name} · ${model.name}` }))]} />
        </Field>
        {(message || checks) && <div className="model-router-settings__status" role="status" aria-label={t('router.status')}
          data-openbitfun-component="model-router-settings" data-openbitfun-part="status">
          <span className="model-router-settings__status-label" data-openbitfun-component="model-router-settings" data-openbitfun-part="statusLabel">{t('router.status')}</span>
          {message && <span>{message}</span>}
          {checks && CHECK_ROLES.map(role => <div className="model-router-settings__check" key={role} data-model-routing-check={role}>
            <span>{role === 'router' ? t('router.connectionChecks.router') : tModels(`core.${role}.label`)}</span>
            <span className="model-router-settings__check-result">
              <span aria-hidden="true">{checks[role].state === 'connected' ? '✓ ' : checks[role].state === 'checking' ? '' : '× '}</span>
              {t(`router.connectionChecks.${checks[role].state}`)}
            </span>
            {checks[role].detail && <span className="model-router-settings__check-detail">{checks[role].detail}</span>}
          </div>)}
        </div>}
        {onManageModels && <Button size="sm" variant="text" disabled={busy} onClick={onManageModels}>{t('router.manageModels')}</Button>}
      </div>
    </DialogBody>
    <DialogFooter separator>
      <Button size="sm" variant="outline" disabled={busy || !draft || !roleDraft} onClick={() => void save(true)}>{t('router.test')}</Button>
      <Button size="sm" variant="primary" loading={busy} disabled={!draft || !roleDraft} onClick={() => void save(false)}>{t('router.save')}</Button>
    </DialogFooter>
  </Dialog>;
}
