import { useEffect, useState } from 'react';
import { Button, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogHeading, DialogTitle, Field, Input, Select } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { configManager } from '../services/ConfigManager';
import type { AIModelConfig, ModelRoutingConfig } from '../types';
import './ModelRouterSettings.scss';

const DEFAULTS: ModelRoutingConfig = { default_mode: null, router_model_id: null, tokenizer_path: '', simple_threshold: 0.75, timeout_ms: 10000, summary_enabled: false };

/** All paths and credentials belong to the selected execution host. */
export function ModelRouterSettings({ models, onClose, onSaved, onManageModels }: {
  models: AIModelConfig[]; onClose: () => void; onSaved: () => void; onManageModels?: () => void;
}) {
  const { t } = useI18n('settings/models');
  const [surface] = useState(getActiveSurfaceScope);
  const [draft, setDraft] = useState<ModelRoutingConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void configManager.getConfig<ModelRoutingConfig>('ai.model_routing').then(value => {
      if (active && surface.isCurrent()) setDraft({ ...DEFAULTS, ...value });
    }).catch(() => { if (active && surface.isCurrent()) setMessage(t('router.loadFailed')); });
    return () => { active = false; };
  }, [surface, t]);
  const save = async (probe: boolean) => {
    if (!draft || busy || !surface.isCurrent()) return;
    setBusy(true); setMessage('');
    try {
      // Feature negotiation precedes any write, including on older peer hosts.
      const support = await agentAPI.getModelRoutingStatus();
      if (!surface.isCurrent()) return;
      if (support.apiVersion !== 1) throw new Error(t('router.unsupported'));
      await configManager.updateConfig<ModelRoutingConfig>('ai.model_routing', current => ({
        ...DEFAULTS, ...current, router_model_id: draft.router_model_id || null,
        tokenizer_path: draft.tokenizer_path.trim(), simple_threshold: draft.simple_threshold,
        timeout_ms: draft.timeout_ms, summary_enabled: draft.summary_enabled,
      }));
      if (!surface.isCurrent()) return;
      onSaved();
      if (probe) {
        const status = await agentAPI.getModelRoutingStatus({ probe: true });
        if (surface.isCurrent()) setMessage(status.connected ? t('router.connected') : status.issue ?? t('router.notReady'));
      } else onClose();
    } catch (error) {
      if (surface.isCurrent()) setMessage(error instanceof Error ? error.message : t('router.saveFailed'));
    } finally { if (surface.isCurrent()) setBusy(false); }
  };
  const valid = draft && Number.isFinite(draft.simple_threshold) && draft.simple_threshold >= 0
    && draft.simple_threshold <= 1 && Number.isSafeInteger(draft.timeout_ms) && draft.timeout_ms > 0;
  return <Dialog open size="md" closeOnEscape={!busy} closeOnPointerOutside={false} onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogHeader><DialogHeading><DialogTitle>{t('router.title')}</DialogTitle></DialogHeading><DialogClose disabled={busy} /></DialogHeader>
    <DialogBody>
      <div className="model-router-settings" data-openbitfun-component="model-router-settings" data-openbitfun-part="root">
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
        <Field label={t('router.threshold')} description={t('router.thresholdHint')} controlWidth="fill">
          <Input size="sm" type="number" min="0" max="1" step="0.05" aria-label={t('router.threshold')}
            value={draft?.simple_threshold ?? ''} disabled={busy || !draft} onValueChange={value => setDraft(current => current && { ...current, simple_threshold: Number(value) })} />
        </Field>
        <Field label={t('router.timeout')} controlWidth="fill">
          <Input size="sm" type="number" min="1" step="1000" aria-label={t('router.timeout')} value={draft?.timeout_ms ?? ''}
            disabled={busy || !draft} onValueChange={value => setDraft(current => current && { ...current, timeout_ms: Number(value) })} />
        </Field>
        <Field label={t('router.summary')} description={t('router.summaryHint')} controlWidth="fill">
          <Select size="sm" aria-label={t('router.summary')} value={draft?.summary_enabled ? 'on' : 'off'} disabled={busy || !draft}
            onValueChange={value => setDraft(current => current && { ...current, summary_enabled: value === 'on' })}
            options={[{ value: 'off', label: t('router.off') }, { value: 'on', label: t('router.on') }]} />
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
      <Button size="sm" variant="outline" disabled={busy || !valid} onClick={() => void save(true)}>{t('router.test')}</Button>
      <Button size="sm" variant="primary" loading={busy} disabled={!valid} onClick={() => void save(false)}>{t('router.save')}</Button>
    </DialogFooter>
  </Dialog>;
}
