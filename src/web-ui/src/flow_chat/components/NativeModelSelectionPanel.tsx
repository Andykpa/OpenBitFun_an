import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button, Icon, IconButton, MenuItem, MenuList, MenuPopover, OverflowText, SegmentedControl, StatusPill, Tooltip } from '@openbitfun/ui';
import { Brain, SlidersHorizontal, Sparkles, X, Zap } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import type { AIModelConfig } from '@/infrastructure/config/types';
import { ModelBillingSummary } from '@/infrastructure/config/components/ModelBillingSummary';
import type { ModelSelectionScope } from '../hooks/useModelSelectionScope';
import './NativeModelSelectionPanel.scss';

interface Props {
  primary?: AIModelConfig; fast?: AIModelConfig; selected?: AIModelConfig;
  modelLabel: string; selectedId: string; scope: ModelSelectionScope;
  canRemember: boolean; hasSession: boolean; disabled: boolean;
  onScopeChange: (scope: ModelSelectionScope) => void;
  onSelect: (model: string) => void;
  onBrowse: () => void; onProviders: () => void; onSettings: () => void; onSaved: () => void;
  onClose?: () => void;
  modelRef: RefObject<HTMLButtonElement>; providerRef: RefObject<HTMLButtonElement>;
  children?: ReactNode;
}

export function NativeModelSelectionPanel(props: Props) {
  const { t } = useI18n('flow-chat');
  const [scopeOpen, setScopeOpen] = useState(false);
  const [view, setView] = useState<'manual' | 'smart'>('manual');
  const smartPreview = view === 'smart';
  const scopeRef = useRef<HTMLButtonElement>(null);
  const chooseScope = (scope: ModelSelectionScope) => { setScopeOpen(false); props.onScopeChange(scope); };
  const modelRow = (role: 'primary' | 'fast', model?: AIModelConfig) => (
    <MenuItem data-testid={`model-selection-smart-${role}`} disabled={props.disabled} onClick={props.onSettings}
      labelBehavior="static" leading={<Icon glyph={role === 'primary' ? Brain : Zap} />}
      metadata={<Icon name="chevron-right" size="sm" />}>
      <span className="native-model-selection__model-info" data-openbitfun-component="model-selector" data-openbitfun-part="modelInfo">
        <span className="native-model-selection__model-meta">
          <span>{t(role === 'primary' ? 'modelSelector.primaryModel' : 'modelSelector.fastModel')}</span>
          {model && <OverflowText className="native-model-selection__channel">{model.name}</OverflowText>}
        </span>
        <OverflowText className="native-model-selection__model-name">{model?.model_name ?? t('modelSelector.modelNotConfigured')}</OverflowText>
      </span>
    </MenuItem>
  );
  return <div className="native-model-selection" data-testid="chat-model-selector-settings" data-openbitfun-component="model-selector" data-openbitfun-part="nativePanel">
    <div className="native-model-selection__header">
      <div className="native-model-selection__title"><strong>{t('modelSelector.modelSelection')}</strong>
        {smartPreview && <StatusPill tone="neutral">{t('modelSelector.modes.previewBadge')}</StatusPill>}
      </div>
      <div className="native-model-selection__header-actions">
      {!smartPreview && (props.canRemember ? <>
        <Button ref={scopeRef} size="xs" variant="text" data-testid="model-selection-scope" aria-haspopup="menu" aria-expanded={scopeOpen}
          trailingIcon={<Icon name="chevron-down" size="xs" />} disabled={props.disabled} onClick={() => setScopeOpen(!scopeOpen)}>
          {props.scope === 'remember' ? t('modelSelector.scope.remember') : t('modelSelector.scope.session')}
        </Button>
        <MenuPopover open={scopeOpen} onClose={() => setScopeOpen(false)} anchorRef={scopeRef} ownerRef={scopeRef}
          aria-label={t('modelSelector.scope.title')} items={[
            { id: 'remember', label: t('modelSelector.scope.remember'), role: 'menuitemradio', checked: props.scope === 'remember', onSelect: () => chooseScope('remember') },
            { id: 'session', label: t('modelSelector.scope.session'), role: 'menuitemradio', checked: props.scope === 'session', disabled: !props.hasSession, onSelect: () => chooseScope('session') },
          ]} />
      </> : <small>{t('modelSelector.scope.session')}</small>)}
      {props.onClose && <IconButton size="xs" variant="quiet" icon={<Icon glyph={X} />} aria-label={t('modelSelector.close')} onClick={props.onClose} />}
      </div>
    </div>
    <div data-openbitfun-component="model-selector" data-openbitfun-part="modeChoices"><SegmentedControl data-testid="chat-model-selector-mode-choices" aria-label={t('modelSelector.modes.selection')}
      interaction="buttons" distribution="fill" variant="pills" size="md" labelBehavior="static" value={view} disabled={props.disabled}
      onValueChange={value => { if (value === 'manual' || value === 'smart') { setScopeOpen(false); setView(value); } }} options={[
        { value: 'manual', label: t('modelSelector.modes.manual'), icon: <Icon glyph={SlidersHorizontal} /> },
        { value: 'smart', label: t('modelSelector.modes.smart'), icon: <Icon glyph={Sparkles} /> },
        { value: 'pool', label: t('modelSelector.modes.pool'), disabled: true },
      ]} /></div>
    <p className="native-model-selection__hint">{t(smartPreview ? 'modelSelector.modes.smartSummary' : 'modelSelector.modes.manualSummary')}</p>
    {smartPreview ? <>
      <MenuList data-testid="model-selection-smart-preview">
        {modelRow('primary', props.primary)}
        {modelRow('fast', props.fast)}
      </MenuList>
    </> : <><MenuList>
      <MenuItem ref={props.modelRef} data-testid="chat-model-selector-settings-model" disabled={props.disabled} onClick={props.onBrowse}
        data-model-menu-target="models" onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); props.onBrowse(); } }}>
        <OverflowText className="openbitfun-model-selector__model-name">{props.modelLabel}</OverflowText>
      </MenuItem>
      <MenuItem ref={props.providerRef} data-testid="chat-model-selector-settings-provider" disabled={props.disabled} onClick={props.onProviders}
        data-model-menu-target="providers">
        <OverflowText className="openbitfun-model-selector__model-provider">{props.selected?.name ?? t('modelSelector.modelSelection')}</OverflowText>
      </MenuItem>
      <MenuItem role="menuitemradio" checked={props.selectedId === 'primary'} disabled={props.disabled || !props.primary}
        data-testid="model-selection-primary" onClick={() => props.onSelect('primary')} metadata={props.primary?.model_name ?? t('modelSelector.modelNotConfigured')}>
        {t('modelSelector.primaryModel')}
      </MenuItem>
      <MenuItem role="menuitemradio" checked={props.selectedId === 'fast'} disabled={props.disabled || !props.fast}
        data-testid="model-selection-fast" onClick={() => props.onSelect('fast')} metadata={props.fast?.model_name ?? t('modelSelector.modelNotConfigured')}>
        {t('modelSelector.fastModel')}
      </MenuItem>
    </MenuList>
    {props.children}</>}
    <ModelBillingSummary compact primary={props.primary} fast={props.fast} selected={smartPreview ? undefined : props.selected} disabled={props.disabled} onSaved={props.onSaved} />
    <div className="native-model-selection__footer">
      {smartPreview ? <Tooltip content={t('modelSelector.modes.previewNotice', { model: props.modelLabel })}>
        <span className="native-model-selection__preview-status" role="status" tabIndex={0}>
          <Icon name="info" size="xs" />{t('modelSelector.modes.previewStatus')}
        </span>
      </Tooltip> : <small>{props.scope === 'remember' ? t('modelSelector.scope.rememberHint') : t('modelSelector.scope.sessionHint')}</small>}
      <Button size="xs" variant="text" trailingIcon={<Icon name="chevron-right" size="xs" />} onClick={props.onSettings}>{t('modelSelector.manageModels')}</Button>
    </div>
  </div>;
}
