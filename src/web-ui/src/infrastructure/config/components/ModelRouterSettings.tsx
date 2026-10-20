import { useEffect, useState } from 'react';
import { Button, Combobox, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogHeading, DialogTitle, Field, Input, Select, Switch } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';
import { configManager } from '../services/ConfigManager';
import type { AIModelConfig, DefaultModelsConfig, ModelRoutingConfig } from '../types';
import { filterSelectableTextChatModels } from '../services/modelCategory';
import { useModelSelectPresentation } from './ModelSelectPresentation';
import './ModelRouterSettings.scss';

const DEFAULTS: ModelRoutingConfig = { default_mode: null, router_model_id: null, tokenizer_path: '', simple_threshold: 0.75, timeout_ms: 10000, summary_enabled: false };
const log = createLogger('ModelRouterSettings');

/** All paths and credentials belong to the selected execution host. */
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
  const save = async (probe: boolean) => {
    if (!draft || !roleDraft || !initialRoles || busy || !surface.isCurrent()) return;
    setBusy(true); setMessage('');
    let failureMessage = t('router.loadFailed');
    try {
      // Feature negotiation precedes any write, including on older peer hosts.
      const support = await agentAPI.getModelRoutingStatus();
      if (!surface.isCurrent()) return;
      if (support.apiVersion !== 1) { setMessage(t('router.unsupported')); return; }
      failureMessage = t('router.saveFailed');
      const changedRoles = Object.fromEntries((['primary', 'economy'] as const)
        .filter(role => (roleDraft[role] || null) !== (initialRoles[role] || null))
        .map(role => [role, roleDraft[role] || null]));
      if (Object.keys(changedRoles).length) {
        await configManager.updateConfig<DefaultModelsConfig>('ai.default_models', current => ({ ...current, ...changedRoles }));
        if (!surface.isCurrent()) return;
        setInitialRoles({ ...roleDraft });
        onSaved();
      }
      await configManager.updateConfig<ModelRoutingConfig>('ai.model_routing', current => ({
        ...DEFAULTS, ...current, router_model_id: draft.router_model_id || null,
        tokenizer_path: draft.tokenizer_path.trim(),
        summary_enabled: draft.summary_enabled,
      }));
      if (!surface.isCurrent()) return;
      onSaved();
      if (probe) {
        failureMessage = t('router.checkFailed');
        const status = await agentAPI.getModelRoutingStatus({ probe: true });
        if (surface.isCurrent()) {
          setMessage(status.connected ? t('router.connected') : t('router.checkFailed'));
          if (!status.connected) log.warn('Smart-mode protocol check failed', { issue: status.issue });
        }
      } else onClose();
    } catch (error) {
      if (surface.isCurrent()) {
        log.warn('Failed to save or check smart-mode configuration', { error });
        setMessage(failureMessage);
      }
    } finally { if (surface.isCurrent()) setBusy(false); }
  };
  return <Dialog open size="md" closeOnEscape={!busy} closeOnPointerOutside={false} onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogHeader><DialogHeading><DialogTitle>{t('router.title')}</DialogTitle></DialogHeading><DialogClose disabled={busy} /></DialogHeader>
    <DialogBody>
      <div className="model-router-settings" data-openbitfun-component="model-router-settings" data-openbitfun-part="root">
        <div className="model-router-settings__models">
          {(['primary', 'economy'] as const).map(role => <Field key={role} label={tModels(`core.${role}.label`)} controlWidth="fill">
            <Combobox size="sm" aria-label={tModels(`core.${role}.label`)} value={roleDraft?.[role] ?? ''}
              disabled={busy || !roleDraft} placeholder={tModels(`core.${role}.placeholder`)}
              options={filterSelectableTextChatModels(models).map(buildModelOption)}
              onValueChange={value => setRoleDraft(current => current && { ...current, [role]: String(Array.isArray(value) ? value[0] ?? '' : value) || null })} />
          </Field>)}
        </div>
        <Field label={t('router.service')} description={t('router.serviceHint')} controlWidth="fill">
          <Select size="sm" aria-label={t('router.service')} value={draft?.router_model_id ?? ''} disabled={busy || !draft}
            onValueChange={value => setDraft(current => current && { ...current, router_model_id: String(value) || null })}
            options={[{ value: '', label: t('router.unconfigured') }, ...models.filter((model): model is AIModelConfig & { id: string } => Boolean(model.id) && model.enabled && (!model.auth || model.auth.type === 'api_key'))
              .map(model => ({ value: model.id, label: `${model.model_name} · ${model.name}` }))]} />
        </Field>
        <Field label={t('router.tokenizer')} description={t('router.tokenizerHint')} controlWidth="fill">
          <Input size="sm" aria-label={t('router.tokenizer')} value={draft?.tokenizer_path ?? ''} disabled={busy || !draft}
            onValueChange={value => setDraft(current => current && { ...current, tokenizer_path: value })} />
        </Field>
        <Field orientation="horizontal" label={t('router.summary')} description={t('router.summaryHint')}>
          <Switch aria-label={t('router.summary')} checked={draft?.summary_enabled ?? false} disabled={busy || !draft}
            onCheckedChange={checked => setDraft(current => current && { ...current, summary_enabled: checked })} />
        </Field>
        {message && <div className="model-router-settings__status" role="status" aria-label={t('router.status')}
          data-openbitfun-component="model-router-settings" data-openbitfun-part="status">
          <span className="model-router-settings__status-label" data-openbitfun-component="model-router-settings" data-openbitfun-part="statusLabel">{t('router.status')}</span>
          <span>{message}</span>
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
