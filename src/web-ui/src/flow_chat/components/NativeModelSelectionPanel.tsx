import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button, Icon, IconButton, MenuItem, MenuList, MenuPopover, MenuSection, OverflowText, ScrollArea, SearchField, SegmentedControl, Tooltip } from '@openbitfun/ui';
import { ArrowLeft, Brain, Check, Search, SlidersHorizontal, Sparkles, X, Zap } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import type { AIModelConfig, SubagentModelSelection } from '@/infrastructure/config/types';
import { ModelBillingSummary } from '@/infrastructure/config/components/ModelBillingSummary';
import { filterSelectableTextChatModels } from '@/infrastructure/config/services/modelCategory';
import { getProviderDisplayName, getProviderGroupKey } from '@/infrastructure/config/services/modelConfigs';
import type { ModelSelectionScope } from '../hooks/useModelSelectionScope';
import './NativeModelSelectionPanel.scss';

interface Props {
  models: AIModelConfig[];
  primary?: AIModelConfig; fast?: AIModelConfig; economy?: AIModelConfig; selected?: AIModelConfig;
  routing?: { mode: 'manual' | 'smart'; ready: boolean; supported: boolean; issue?: string | null; summaryEnabled?: boolean; subagentModel?: string };
  onModeChange?: (mode: 'manual' | 'smart') => Promise<boolean>;
  onSubagentModelChange?: (model: 'primary' | 'economy') => Promise<boolean>;
  onRoutingSettings?: () => void;
  modelLabel: string; selectedId: string; scope: ModelSelectionScope;
  canRemember: boolean; hasSession: boolean; disabled: boolean;
  canConfigureDefaults: boolean;
  advancedOpen: boolean;
  onAdvancedOpenChange: (open: boolean) => void;
  fastUsesPrimary: boolean;
  subagentSelection: SubagentModelSelection;
  subagentModel?: AIModelConfig;
  onScopeChange: (scope: ModelSelectionScope) => void;
  onConfigureModel: (role: ModelRole, modelId: string | null) => Promise<boolean>;
  onBrowse: () => void; onSettings: () => void; onSaved: () => void;
  onClose?: () => void;
  modelRef: RefObject<HTMLButtonElement>;
  children?: ReactNode;
}

export type ModelRole = 'primary' | 'fast' | 'economy';
type PickerRole = ModelRole;

export function NativeModelSelectionPanel(props: Props) {
  const { t } = useI18n('flow-chat');
  const [scopeOpen, setScopeOpen] = useState(false);
  const [view, setView] = useState<'manual' | 'smart'>(props.routing?.mode ?? 'manual');
  useEffect(() => { if (props.routing) setView(props.routing.mode); }, [props.routing?.mode]);
  const smartView = view === 'smart';
  const advancedId = useId();
  const scopeRef = useRef<HTMLButtonElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const secondaryRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const returnRole = useRef<PickerRole | null>(null);
  const [pickingRole, setPickingRole] = useState<PickerRole | null>(null);
  const [query, setQuery] = useState('');
  const availableModels = filterSelectableTextChatModels(props.models)
    .filter((model): model is AIModelConfig & { id: string } => Boolean(model.id?.trim()));
  useLayoutEffect(() => {
    if (pickingRole) searchRef.current?.focus({ preventScroll: true });
    else if (returnRole.current) {
      (returnRole.current === 'primary' ? primaryRef : secondaryRef).current?.focus({ preventScroll: true });
      returnRole.current = null;
    }
  }, [pickingRole]);
  const closePicker = () => {
    returnRole.current = pickingRole;
    setPickingRole(null);
    setQuery('');
  };
  const roleLabel = (role: PickerRole) => t(role === 'primary' ? 'modelSelector.primaryModel'
    : role === 'economy' ? 'modelSelector.economyModel' : 'modelSelector.fastModel');
  const chooseScope = (scope: ModelSelectionScope) => { setScopeOpen(false); props.onScopeChange(scope); };
  const chooseMode = async (mode: 'manual' | 'smart') => {
    setScopeOpen(false);
    // Unconfigured smart mode can be inspected. Active strategies follow the
    // host response so a rejected write never looks like a successful switch.
    if (!props.routing?.supported || (mode === 'smart' && !props.routing.ready)) setView(mode);
    else if (await props.onModeChange?.(mode)) setView(mode);
  };
  const chooseRoleModel = async (modelId: string | null) => {
    if (!pickingRole || props.disabled) return;
    if (await props.onConfigureModel(pickingRole, modelId)) closePicker();
  };
  const subagentOverride = props.subagentSelection.kind === 'inherit'
    ? t('modelSelector.roles.inheritMain')
    : props.subagentSelection.model_id === 'primary'
      ? roleLabel('primary')
      : props.subagentModel?.model_name ?? t('modelSelector.modelNotConfigured');
  const subagentsUseFast = props.subagentSelection.kind === 'fixed' && props.subagentSelection.model_id === 'fast';
  const modelRow = (role: PickerRole, model?: AIModelConfig) => (
    <MenuItem ref={role === 'primary' ? primaryRef : secondaryRef} data-testid={`model-selection-${smartView ? 'smart' : 'config'}-${role}`} disabled={props.disabled || !props.canConfigureDefaults}
      onClick={() => { setQuery(''); setPickingRole(role); }}
      labelBehavior="static" leading={<Icon glyph={role === 'primary' ? Brain : Zap} />}
      metadata={<Icon name="chevron-right" size="sm" />}>
      <span className="native-model-selection__model-info" data-openbitfun-component="model-selector" data-openbitfun-part="modelInfo">
        <span className="native-model-selection__model-meta">
          <span className="native-model-selection__role-label">{roleLabel(role)}</span>
          <span>{t(smartView
            ? role === 'primary' ? 'modelSelector.modes.primaryPurpose' : 'modelSelector.modes.economyPurpose'
            : role === 'primary' ? 'modelSelector.roles.primaryPurpose'
              : subagentsUseFast ? 'modelSelector.roles.fastPurpose' : 'modelSelector.roles.fastAvailable')}</span>
        </span>
        <OverflowText className="native-model-selection__model-name">{model?.model_name ?? t('modelSelector.modelNotConfigured')}</OverflowText>
        <span className="native-model-selection__model-meta">
          {model && <OverflowText>{getProviderDisplayName(model)}</OverflowText>}
          {!smartView && role === 'fast' && props.fastUsesPrimary && <span>{t('modelSelector.roles.followPrimary')}</span>}
        </span>
      </span>
    </MenuItem>
  );
  if (pickingRole) {
    const search = query.trim().toLowerCase();
    const roleModel = props[pickingRole];
    const groups = new Map<string, { name: string; models: typeof availableModels }>();
    for (const model of availableModels) {
      const name = getProviderDisplayName(model);
      if (search && !`${model.model_name} ${model.name} ${name}`.toLowerCase().includes(search)) continue;
      const key = getProviderGroupKey(model);
      const group = groups.get(key) ?? { name, models: [] };
      group.models.push(model);
      groups.set(key, group);
    }
    return <div className="native-model-selection" data-testid="model-selection-role-picker"
      data-openbitfun-component="model-selector" data-openbitfun-part="nativePanel"
      onKeyDownCapture={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Escape' || (event.key === 'ArrowLeft' && event.target !== searchRef.current)) {
          event.preventDefault(); event.stopPropagation(); closePicker();
        }
      }}>
      <div className="native-model-selection__header">
        <div className="native-model-selection__title">
          <IconButton size="xs" variant="quiet" icon={<Icon glyph={ArrowLeft} />} aria-label={t('modelSelector.picker.back')} onClick={closePicker} />
          <strong>{t('modelSelector.picker.title', { role: roleLabel(pickingRole) })}</strong>
        </div>
        <small>{t('modelSelector.roles.shared')}</small>
      </div>
      <SearchField ref={searchRef} size="sm" value={query} onValueChange={setQuery} disabled={props.disabled}
        aria-label={t('modelSelector.picker.search')} placeholder={t('modelSelector.picker.search')}
        leadingIcon={<Icon glyph={Search} />} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            pickerRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
          }
        }} />
      <div className="native-model-selection__picker-options" data-openbitfun-component="model-selector" data-openbitfun-part="rolePickerList">
      <ScrollArea orientation="vertical"><MenuList ref={pickerRef} data-testid="model-selection-role-options">
        {!smartView && pickingRole === 'fast' && !query.trim() && <MenuItem role="menuitemradio" checked={props.fastUsesPrimary}
          data-testid="model-selection-role-inherit" disabled={props.disabled} onClick={() => { void chooseRoleModel(null); }}>
          {t('modelSelector.roles.followPrimary')}
        </MenuItem>}
        {[...groups].map(([key, group]) => <MenuSection key={key} title={group.name}>
          {group.models.map(model => <MenuItem key={model.id} role="menuitemradio" checked={roleModel?.id === model.id && (smartView || pickingRole !== 'fast' || !props.fastUsesPrimary)}
            data-testid="model-selection-role-option" data-model-id={model.id} disabled={props.disabled}
            metadata={roleModel?.id === model.id && (smartView || pickingRole !== 'fast' || !props.fastUsesPrimary) ? <Icon glyph={Check} size="sm" /> : undefined}
            onClick={() => { void chooseRoleModel(model.id); }}>
            {model.model_name}
          </MenuItem>)}
        </MenuSection>)}
        {groups.size === 0 && <p className="native-model-selection__hint" role="status">{t('modelSelector.picker.empty')}</p>}
      </MenuList></ScrollArea>
      </div>
      <div className="native-model-selection__footer">
        <small>{t('modelSelector.roles.saveHint')}</small>
        <Button size="sm" variant="text" trailingIcon={<Icon name="chevron-right" size="xs" />} onClick={props.onSettings}>{t('modelSelector.manageModels')}</Button>
      </div>
    </div>;
  }
  const selectionScope = props.canRemember ? <>
        <Button ref={scopeRef} size="sm" variant="text" data-testid="model-selection-scope" aria-haspopup="menu" aria-expanded={scopeOpen}
          trailingIcon={<Icon name="chevron-down" size="xs" />} disabled={props.disabled} onClick={() => setScopeOpen(!scopeOpen)}>
          {props.scope === 'remember' ? t('modelSelector.scope.remember') : t('modelSelector.scope.session')}
        </Button>
        <MenuPopover open={scopeOpen} onClose={() => setScopeOpen(false)} anchorRef={scopeRef} ownerRef={scopeRef}
          aria-label={t('modelSelector.scope.title')} items={[
            { id: 'remember', label: t('modelSelector.scope.remember'), role: 'menuitemradio', checked: props.scope === 'remember', onSelect: () => chooseScope('remember') },
            { id: 'session', label: t('modelSelector.scope.session'), role: 'menuitemradio', checked: props.scope === 'session', disabled: !props.hasSession, onSelect: () => chooseScope('session') },
          ]} />
      </> : <small>{t('modelSelector.scope.session')}</small>;
  return <div className="native-model-selection" data-testid="chat-model-selector-settings" data-openbitfun-component="model-selector" data-openbitfun-part="nativePanel">
    <div className="native-model-selection__header">
      <div className="native-model-selection__title"><strong>{t('modelSelector.modelSelection')}</strong>
      </div>
      <div className="native-model-selection__header-actions">
      {smartView && selectionScope}
      {props.onClose && <IconButton size="xs" variant="quiet" disabled={props.disabled} icon={<Icon glyph={X} />} aria-label={t('modelSelector.close')} onClick={props.onClose} />}
      </div>
    </div>
    <div data-openbitfun-component="model-selector" data-openbitfun-part="modeChoices"><SegmentedControl data-testid="chat-model-selector-mode-choices" aria-label={t('modelSelector.modes.selection')}
      interaction="buttons" distribution="fill" variant="pills" size="md" labelBehavior="static" value={view} disabled={props.disabled}
      onValueChange={value => { if (value === 'manual' || value === 'smart') void chooseMode(value); }} options={[
        { value: 'manual', label: t('modelSelector.modes.manual'), icon: <Icon glyph={SlidersHorizontal} /> },
        { value: 'smart', label: t('modelSelector.modes.smart'), icon: <Icon glyph={Sparkles} /> },
        { value: 'pool', label: t('modelSelector.modes.pool'), disabled: true },
      ]} /></div>
    <p className="native-model-selection__hint">{t(smartView ? 'modelSelector.modes.smartSummary'
      : props.canConfigureDefaults ? 'modelSelector.modes.manualSummary' : 'modelSelector.roles.sessionSummary')}</p>
    {smartView ? <>
      <div className="native-model-selection__section-heading"><span>{t('modelSelector.roles.title')}</span><small>{t('modelSelector.roles.shared')}</small></div>
      <MenuList data-testid="model-selection-smart-preview">
        {modelRow('primary', props.primary)}
        {modelRow('economy', props.economy)}
      </MenuList>
      <div className="native-model-selection__advanced">
        <MenuList><MenuItem data-testid="model-selection-smart-advanced" aria-expanded={props.advancedOpen}
          aria-controls={advancedId} disabled={props.disabled} labelBehavior="static"
          metadata={<Icon name={props.advancedOpen ? 'chevron-down' : 'chevron-right'} size="sm" />}
          onClick={() => props.onAdvancedOpenChange(!props.advancedOpen)}>
          <span className="native-model-selection__advanced-summary">
            <span className="native-model-selection__advanced-label">{t('modelSelector.roles.advanced')}</span>
            <OverflowText className="native-model-selection__support">
              {t(props.routing?.subagentModel === 'primary' ? 'modelSelector.routing.subagents.primarySummary'
                : props.routing?.subagentModel === 'economy' ? 'modelSelector.routing.subagents.economySummary'
                  : 'modelSelector.routing.subagents.title')}
            </OverflowText>
          </span>
        </MenuItem></MenuList>
        {props.advancedOpen && <div id={advancedId} className="native-model-selection__session">
          <div className="native-model-selection__section-heading">
            <span>{t('modelSelector.routing.subagents.title')}</span><small>{t('modelSelector.roles.shared')}</small>
          </div>
          <MenuList aria-label={t('modelSelector.routing.subagents.title')}>
            {(['primary', 'economy'] as const).map(role => <MenuItem key={role} role="menuitemradio"
              data-testid={`model-selection-subagent-${role}`} checked={props.routing?.subagentModel === role}
              disabled={props.disabled || !props.canConfigureDefaults || typeof props.routing?.subagentModel !== 'string' || (role === 'economy' && !props.economy)}
              metadata={props.routing?.subagentModel === role ? <Icon glyph={Check} size="sm" /> : undefined}
              onClick={() => { void props.onSubagentModelChange?.(role); }}>
              {t(role === 'primary' ? 'modelSelector.routing.subagents.primary' : 'modelSelector.routing.subagents.economy')}
            </MenuItem>)}
          </MenuList>
          <p className="native-model-selection__support">{t(typeof props.routing?.subagentModel === 'string'
            ? 'modelSelector.routing.subagents.hint' : 'modelSelector.routing.subagents.unsupported')}</p>
        </div>}
      </div>
    </> : <>
      {props.canConfigureDefaults && <div className="native-model-selection__roles">
        <div className="native-model-selection__section-heading"><span>{t('modelSelector.roles.title')}</span><small>{t('modelSelector.roles.shared')}</small></div>
        <MenuList data-testid="model-selection-role-config">
          {modelRow('primary', props.primary)}
          {modelRow('fast', props.fast)}
        </MenuList>
        <p className="native-model-selection__support" data-testid="model-selection-subagent-policy">
          {subagentsUseFast
            ? t('modelSelector.roles.subagentDefault') : t('modelSelector.roles.subagentOverride', { model: subagentOverride })}
        </p>
      </div>}
      <div className="native-model-selection__advanced">
        {props.canConfigureDefaults && <MenuList><MenuItem data-testid="model-selection-advanced"
          aria-expanded={props.advancedOpen} aria-controls={advancedId} disabled={props.disabled} labelBehavior="static"
          metadata={<Icon name={props.advancedOpen ? 'chevron-down' : 'chevron-right'} size="sm" />}
          onClick={() => { setScopeOpen(false); props.onAdvancedOpenChange(!props.advancedOpen); }}>
          <span className="native-model-selection__advanced-summary">
            <span className="native-model-selection__advanced-label">{t('modelSelector.roles.advanced')}</span>
            {props.selectedId !== 'primary' && <OverflowText className="native-model-selection__support" data-testid="model-selection-override-summary">
              {t('modelSelector.roles.activeOverride', { model: props.modelLabel })}
            </OverflowText>}
          </span>
        </MenuItem></MenuList>}
      {(!props.canConfigureDefaults || props.advancedOpen) && <div id={advancedId} className="native-model-selection__session" data-testid="model-selection-session-override">
        <div className="native-model-selection__section-heading"><span>{t(props.canConfigureDefaults ? 'modelSelector.roles.mainOverride' : 'modelSelector.roles.sessionModel')}</span>{selectionScope}</div>
        <MenuList>
      <MenuItem ref={props.modelRef} data-testid="chat-model-selector-settings-model" disabled={props.disabled} onClick={props.onBrowse}
        labelBehavior="static" metadata={<Icon name="chevron-right" size="sm" />}
        data-model-menu-target="models" onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); props.onBrowse(); } }}>
        <span className="native-model-selection__model-info" data-openbitfun-component="model-selector" data-openbitfun-part="modelInfo">
          <OverflowText className="native-model-selection__model-name">{props.selectedId === 'primary' ? t('modelSelector.roles.followPrimary')
            : props.selectedId === 'fast' ? t('modelSelector.roles.useFast') : props.modelLabel}</OverflowText>
          <OverflowText className="native-model-selection__support">{props.selected && [props.selectedId === 'primary' || props.selectedId === 'fast' ? props.selected.model_name : '', getProviderDisplayName(props.selected)].filter(Boolean).join(' · ')}</OverflowText>
        </span>
      </MenuItem>
        </MenuList>
        <p className="native-model-selection__support">{t(props.scope === 'remember' ? 'modelSelector.roles.rememberMain' : 'modelSelector.roles.sessionMain')}</p>
      </div>}
      </div>
      {props.children && <div className="native-model-selection__controls">{props.children}</div>}
    </>}
    {smartView && <>
      <MenuList><MenuItem data-testid="model-routing-settings" disabled={props.disabled || !props.routing?.supported} onClick={props.onRoutingSettings}
        metadata={<Icon name="chevron-right" size="sm" />} labelBehavior="static">{t('modelSelector.routing.settings')}</MenuItem></MenuList>
      {props.routing?.mode !== 'smart' && <Button size="sm" variant="outline" disabled={props.disabled || !props.routing?.ready}
        onClick={() => { void props.onModeChange?.('smart'); }}>{t('modelSelector.routing.enable')}</Button>}
      <p className="native-model-selection__support">{t('modelSelector.routing.scopeHint')}</p>
    </>}
    <ModelBillingSummary compact secondaryRole={smartView ? 'economy' : 'fast'} primary={props.primary} fast={smartView ? props.economy : props.fast} selected={smartView ? undefined : props.selected} disabled={props.disabled} onSaved={props.onSaved} />
    <div className="native-model-selection__footer">
      {smartView ? <Tooltip content={props.routing?.issue || t('modelSelector.routing.costHint')}>
        <span className="native-model-selection__preview-status" role="status" tabIndex={0}>
          <Icon name="info" size="xs" />{t(props.routing?.ready
            ? props.routing.mode === 'smart' ? 'modelSelector.routing.active' : 'modelSelector.routing.ready'
            : props.routing?.supported ? 'modelSelector.routing.notReady' : 'modelSelector.routing.unsupported')}
        </span>
      </Tooltip> : <small>{t(props.canConfigureDefaults ? 'modelSelector.roles.autosave' : 'modelSelector.scope.sessionHint')}</small>}
      <Button size="sm" variant="text" trailingIcon={<Icon name="chevron-right" size="xs" />} onClick={props.onSettings}>{t('modelSelector.manageModels')}</Button>
    </div>
  </div>;
}
