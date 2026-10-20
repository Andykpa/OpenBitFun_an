import { useLayoutEffect, useRef, useState } from 'react';
import { Icon, MenuItem, MenuList, MenuPopover, MenuSection, OverflowText, ScrollArea, SearchField, Tooltip } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import type { AIModelConfig } from '@/infrastructure/config/types';
import { ModelBillingSummary } from '@/infrastructure/config/components/ModelBillingSummary';
import { filterSelectableTextChatModels } from '@/infrastructure/config/services/modelCategory';
import { getProviderDisplayName, getProviderGroupKey } from '@/infrastructure/config/services/modelConfigs';
import type { ModelSelectionScope } from '../hooks/useModelSelectionScope';
import './NativeModelSelectionPanel.scss';

export type ModelRole = 'primary' | 'economy';

interface ScopeProps {
  scope: ModelSelectionScope;
  hasSession: boolean;
  disabled: boolean;
  onScopeChange: (scope: ModelSelectionScope) => void;
}

export function ModelSelectionScopeItem(props: ScopeProps) {
  const { t } = useI18n('flow-chat');
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return <MenuList>
    <MenuItem ref={anchorRef} data-testid="model-selection-scope" aria-haspopup="menu" aria-expanded={open}
      disabled={props.disabled} metadata={<Icon name="chevron-right" size="sm" />}
      onClick={() => setOpen(!open)}>
      {t(props.scope === 'remember' ? 'modelSelector.scope.remember' : 'modelSelector.scope.session')}
    </MenuItem>
    <MenuPopover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} ownerRef={anchorRef}
      aria-label={t('modelSelector.scope.title')} items={(['remember', 'session'] as const).map(scope => ({
        id: scope, label: t(scope === 'remember' ? 'modelSelector.scope.remember' : 'modelSelector.scope.session'),
        role: 'menuitemradio', checked: props.scope === scope, disabled: props.disabled || (scope === 'session' && !props.hasSession),
        onSelect: () => { setOpen(false); props.onScopeChange(scope); },
      }))} />
  </MenuList>;
}

interface Props extends ScopeProps {
  models: AIModelConfig[];
  primary?: AIModelConfig;
  economy?: AIModelConfig;
  routing: { mode: 'manual' | 'smart'; ready: boolean; supported: boolean; issue?: string | null; subagentModel?: string };
  onModeChange: (mode: 'manual' | 'smart') => Promise<boolean>;
  onSubagentModelChange: (model: ModelRole) => Promise<boolean>;
  onRoutingSettings: () => void;
  onConfigureModel: (role: ModelRole, modelId: string) => Promise<boolean>;
  onSettings: () => void;
  onSaved: () => void;
}

/** Smart-specific items share the original model selector's compact menu. */
export function NativeModelSelectionPanel(props: Props) {
  const { t } = useI18n('flow-chat');
  const [pickingRole, setPickingRole] = useState<ModelRole | null>(null);
  const [query, setQuery] = useState('');
  const [subagentOpen, setSubagentOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const economyRef = useRef<HTMLButtonElement>(null);
  const subagentRef = useRef<HTMLButtonElement>(null);
  const returnRole = useRef<ModelRole | null>(null);
  const roleLabel = (role: ModelRole) => t(role === 'primary' ? 'modelSelector.primaryModel' : 'modelSelector.economyModel');
  useLayoutEffect(() => {
    if (pickingRole) searchRef.current?.focus({ preventScroll: true });
    else if (returnRole.current) {
      (returnRole.current === 'primary' ? primaryRef : economyRef).current?.focus({ preventScroll: true });
      returnRole.current = null;
    }
  }, [pickingRole]);
  const closePicker = () => { returnRole.current = pickingRole; setPickingRole(null); setQuery(''); };
  if (pickingRole) {
    const search = query.trim().toLowerCase();
    const groups = new Map<string, { name: string; models: AIModelConfig[] }>();
    for (const model of filterSelectableTextChatModels(props.models)) {
      if (!model.id?.trim()) continue;
      const name = getProviderDisplayName(model);
      if (search && !`${model.model_name} ${model.name} ${name}`.toLowerCase().includes(search)) continue;
      const key = getProviderGroupKey(model);
      const group = groups.get(key) ?? { name, models: [] };
      group.models.push(model); groups.set(key, group);
    }
    return <div className="native-model-selection" data-testid="model-selection-role-picker"
      data-openbitfun-component="model-selector" data-openbitfun-part="nativePanel"
      onKeyDownCapture={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Escape' || (event.key === 'ArrowLeft' && event.target !== searchRef.current)) {
          event.preventDefault(); event.stopPropagation(); closePicker();
        }
      }}>
      <MenuList><MenuItem leading={<Icon name="chevron-left" size="xs" />} onClick={closePicker}
        aria-label={t('modelSelector.picker.back')}>{roleLabel(pickingRole)}</MenuItem></MenuList>
      <SearchField ref={searchRef} size="sm" value={query} onValueChange={setQuery} disabled={props.disabled}
        aria-label={t('modelSelector.picker.search')} placeholder={t('modelSelector.picker.search')}
        leadingIcon={<Icon name="search" size="sm" />} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            pickerRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
          }
        }} />
      <div className="native-model-selection__picker-options" data-openbitfun-component="model-selector" data-openbitfun-part="rolePickerList">
        <ScrollArea orientation="vertical"><MenuList ref={pickerRef} data-testid="model-selection-role-options">
          {[...groups].map(([key, group]) => <MenuSection key={key} title={group.name}>
            {group.models.map(model => <MenuItem key={model.id} role="menuitemradio" checked={props[pickingRole]?.id === model.id}
              data-testid="model-selection-role-option" data-model-id={model.id} disabled={props.disabled}
              metadata={props[pickingRole]?.id === model.id ? <Icon name="check-line" size="sm" /> : undefined}
              onClick={() => { void props.onConfigureModel(pickingRole, model.id!).then(saved => { if (saved) closePicker(); }); }}>
              {model.model_name}
            </MenuItem>)}
          </MenuSection>)}
          {groups.size === 0 && <MenuItem disabled>{t('modelSelector.picker.empty')}</MenuItem>}
        </MenuList></ScrollArea>
      </div>
      <MenuList><MenuItem onClick={props.onSettings} metadata={<Icon name="chevron-right" size="sm" />}>{t('modelSelector.manageModels')}</MenuItem></MenuList>
    </div>;
  }
  const supportedSubagents = typeof props.routing.subagentModel === 'string';
  const subagentLabel = t(props.routing.subagentModel === 'primary' ? 'modelSelector.routing.subagents.primary'
    : props.routing.subagentModel === 'economy' ? 'modelSelector.routing.subagents.economy' : 'modelSelector.modelNotConfigured');
  const statusLabel = t(!props.routing.supported ? 'modelSelector.routing.unsupported' : !props.routing.ready
    ? 'modelSelector.routing.notReady' : props.routing.mode === 'smart' ? 'modelSelector.routing.active' : 'modelSelector.routing.ready');
  return <div className="native-model-selection" data-openbitfun-component="model-selector" data-openbitfun-part="nativePanel">
    <MenuList data-testid="model-selection-smart-preview">
      {(['primary', 'economy'] as const).map(role => <Tooltip key={role} content={props[role]
        ? `${props[role]!.model_name} · ${getProviderDisplayName(props[role]!)}` : t('modelSelector.modelNotConfigured')}>
        <MenuItem ref={role === 'primary' ? primaryRef : economyRef} data-testid={`model-selection-smart-${role}`}
          className="openbitfun-model-selector__settings-row" disabled={props.disabled}
          metadata={<OverflowText data-openbitfun-component="model-selector" data-openbitfun-part="modelInfo">{props[role]?.model_name ?? t('modelSelector.modelNotConfigured')}</OverflowText>}
          shortcut={<Icon name="chevron-right" size="sm" />} onClick={() => { setQuery(''); setPickingRole(role); }}>
          {roleLabel(role)}
        </MenuItem>
      </Tooltip>)}
      <Tooltip content={t(supportedSubagents ? 'modelSelector.routing.subagents.hint' : 'modelSelector.routing.subagents.unsupported')}>
        <MenuItem ref={subagentRef} data-testid="model-selection-subagent-field"
          className="openbitfun-model-selector__settings-row" disabled={props.disabled || !supportedSubagents}
          aria-haspopup="menu" aria-expanded={subagentOpen}
          metadata={<OverflowText>{subagentLabel}</OverflowText>} shortcut={<Icon name="chevron-right" size="sm" />}
          onClick={() => setSubagentOpen(!subagentOpen)}>{t('modelSelector.routing.subagents.title')}</MenuItem>
      </Tooltip>
      <MenuPopover open={subagentOpen && !props.disabled} onClose={() => setSubagentOpen(false)} anchorRef={subagentRef} ownerRef={subagentRef}
        aria-label={t('modelSelector.routing.subagents.title')} items={(['primary', 'economy'] as const).map(role => ({
          id: role, testId: `model-selection-subagent-${role}`, label: t(`modelSelector.routing.subagents.${role}`),
          role: 'menuitemradio', checked: props.routing.subagentModel === role,
          disabled: props.disabled || (role === 'economy' && !props.economy),
          onSelect: () => { setSubagentOpen(false); void props.onSubagentModelChange(role); },
        }))} />
    </MenuList>
    <MenuList data-testid="model-routing-section">
      <Tooltip content={props.routing.issue || t('modelSelector.routing.costHint')}>
        <MenuItem data-testid="model-routing-settings" className="openbitfun-model-selector__settings-row"
          disabled={props.disabled || !props.routing.supported} onClick={props.onRoutingSettings}
          metadata={<OverflowText role="status">{statusLabel}</OverflowText>}
          shortcut={<Icon name="chevron-right" size="sm" />}>{t('modelSelector.routing.settings')}</MenuItem>
      </Tooltip>
      {props.routing.supported && props.routing.ready && props.routing.mode !== 'smart' && <MenuItem
        data-testid="model-routing-enable" disabled={props.disabled} onClick={() => { void props.onModeChange('smart'); }}>
        {t('modelSelector.routing.enable')}
      </MenuItem>}
    </MenuList>
    <ModelSelectionScopeItem scope={props.scope} hasSession={props.hasSession} disabled={props.disabled} onScopeChange={props.onScopeChange} />
    <ModelBillingSummary compact secondaryRole="economy" primary={props.primary} fast={props.economy} disabled={props.disabled} onSaved={props.onSaved} />
  </div>;
}
