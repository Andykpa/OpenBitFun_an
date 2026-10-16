import { useState, useSyncExternalStore } from 'react';
import { Button, OverflowText } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import type { AIModelConfig } from '../types';
import { COMPARISON_USAGE, compareModelCosts, getModelBilling, isModelBillingCurrent } from '../services/modelBilling';
import { ModelBillingDetails } from './ModelBillingDetails';
import './ModelBilling.scss';

interface Props {
  primary?: AIModelConfig;
  fast?: AIModelConfig;
  selected?: AIModelConfig;
  disabled?: boolean;
  onSaved: () => void;
}

export function ModelBillingSummary({ primary, fast, selected, disabled, onSaved }: Props) {
  const { t, formatNumber } = useI18n('settings/models');
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<{ model: AIModelConfig; epoch: number } | null>(null);
  const comparison = compareModelCosts(primary, fast);
  const models = [...new Map([primary, fast, selected].filter((m): m is AIModelConfig => Boolean(m?.id)).map(m => [m.id, m])).values()];
  const label = (model: AIModelConfig) => {
    const billing = getModelBilling(model);
    if (!billing) return t('billing.unknown');
    if (!isModelBillingCurrent(model, billing)) return t('billing.reviewRequired');
    if (billing.kind === 'subscription') return t('billing.subscription');
    if (billing.kind === 'api') return t('billing.api');
    return t('billing.unknown');
  };
  return <div className="model-billing" data-testid="model-billing-summary" data-openbitfun-component="model-billing" data-openbitfun-part="root">
    <div className="model-billing__heading"><strong>{t('billing.title')}</strong>
      <Button size="xs" variant="text" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t('billing.details')}</Button>
    </div>
    <p className={comparison.status === 'fastHigher' ? 'model-billing__warning' : 'model-billing__hint'} role="status">
      {comparison.status === 'fastHigher' ? t('billing.fastHigher')
        : comparison.status === 'currency' ? t('billing.currencyMismatch')
          : comparison.status === 'comparable' ? t('billing.comparable') : t('billing.incomplete')}
    </p>
    {comparison.status !== 'unknown' && comparison.status !== 'currency' && <p className="model-billing__hint">
      {t('billing.estimate', {
        primary: `${comparison.currency} ${formatNumber(comparison.primaryCost, { maximumFractionDigits: 6 })}`,
        fast: `${comparison.currency} ${formatNumber(comparison.fastCost, { maximumFractionDigits: 6 })}`,
      })}
    </p>}
    {expanded && <div className="model-billing__details">
      <p className="model-billing__hint">{t('billing.workload', { input: formatNumber(COMPARISON_USAGE.input), output: formatNumber(COMPARISON_USAGE.output) })}</p>
      {models.map(model => <div className="model-billing__row" key={model.id}>
        <span className="model-billing__identity"><OverflowText>{model.model_name}</OverflowText><small>{model.name} · {label(model)}</small></span>
        <Button size="xs" variant="outline" disabled={disabled} onClick={() => setEditing({ model, epoch: scope.epoch })}>{t('billing.edit')}</Button>
      </div>)}
      <p className="model-billing__hint">{t('billing.noPolicy')}</p>
    </div>}
    {editing?.epoch === scope.epoch && <ModelBillingDetails key={editing.model.id} model={editing.model} onClose={() => setEditing(null)} onSaved={onSaved} />}
  </div>;
}
