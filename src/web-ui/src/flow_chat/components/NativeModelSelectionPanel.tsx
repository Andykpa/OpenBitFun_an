import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button, MenuItem, MenuList, MenuPopover, OverflowText, SegmentedControl } from '@openbitfun/ui';
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
  modelRef: RefObject<HTMLButtonElement>; providerRef: RefObject<HTMLButtonElement>;
  children?: ReactNode;
}

export function NativeModelSelectionPanel(props: Props) {
  const { t } = useI18n('flow-chat');
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeRef = useRef<HTMLButtonElement>(null);
  const chooseScope = (scope: ModelSelectionScope) => { setScopeOpen(false); props.onScopeChange(scope); };
  return <div className="native-model-selection" data-testid="chat-model-selector-settings" data-openbitfun-component="model-selector" data-openbitfun-part="nativePanel">
    <div className="native-model-selection__header">
      <strong>{t('modelSelector.modelSelection')}</strong>
      {props.canRemember ? <>
        <Button ref={scopeRef} size="xs" variant="text" data-testid="model-selection-scope" aria-haspopup="menu" aria-expanded={scopeOpen}
          disabled={props.disabled} onClick={() => setScopeOpen(!scopeOpen)}>
          {props.scope === 'remember' ? t('modelSelector.scope.remember') : t('modelSelector.scope.session')}
        </Button>
        <MenuPopover open={scopeOpen} onClose={() => setScopeOpen(false)} anchorRef={scopeRef} ownerRef={scopeRef}
          aria-label={t('modelSelector.scope.title')} items={[
            { id: 'remember', label: t('modelSelector.scope.remember'), role: 'menuitemradio', checked: props.scope === 'remember', onSelect: () => chooseScope('remember') },
            { id: 'session', label: t('modelSelector.scope.session'), role: 'menuitemradio', checked: props.scope === 'session', disabled: !props.hasSession, onSelect: () => chooseScope('session') },
          ]} />
      </> : <small>{t('modelSelector.scope.session')}</small>}
    </div>
    <div data-openbitfun-component="model-selector" data-openbitfun-part="modeChoices"><SegmentedControl data-testid="chat-model-selector-mode-choices" aria-label={t('modelSelector.modes.selection')}
      interaction="buttons" distribution="fill" labelBehavior="static" value="manual" options={[
        { value: 'manual', label: t('modelSelector.modes.manual') },
        { value: 'smart', label: t('modelSelector.modes.smart'), disabled: true },
        { value: 'pool', label: t('modelSelector.modes.pool'), disabled: true },
      ]} /></div>
    <p className="native-model-selection__hint">{t('modelSelector.modes.unavailable')}</p>
    <MenuList>
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
    {props.children}
    <ModelBillingSummary primary={props.primary} fast={props.fast} selected={props.selected} disabled={props.disabled} onSaved={props.onSaved} />
    <div className="native-model-selection__footer">
      <small>{props.scope === 'remember' ? t('modelSelector.scope.rememberHint') : t('modelSelector.scope.sessionHint')}</small>
      <Button size="xs" variant="text" onClick={props.onSettings}>{t('modelSelector.openModelSettings')}</Button>
    </div>
  </div>;
}
