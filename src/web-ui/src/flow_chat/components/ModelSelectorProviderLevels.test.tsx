/**
 * @vitest-environment jsdom
 */

import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { act, cloneElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from './ModelSelector';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { getRecentReasoningPreset } from '../utils/reasoningPresets';
import { getActiveSurfaceScope, surfaceScopedKey } from '@/infrastructure/peer-device/deviceSurface';
import { useConfirmDialogStore } from '@/infrastructure/confirm-dialog';
import { notificationStore } from '@/shared/notification-system';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { quickActions } from '@/shared/services/ide-control';
import type { AIModelCatalog } from '@/infrastructure/api/service-api/AIApi';
import type { AIModelConfig, DefaultModelsConfig } from '@/infrastructure/config/types';
import { modelBillingBinding, withModelBilling } from '@/infrastructure/config/services/modelBilling';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const aiApiMocks = vi.hoisted(() => ({
  getModelCatalog: vi.fn(),
  onModelCatalogUpdated: vi.fn(),
}));

const flowChatStoreMocks = vi.hoisted(() => {
  type TestSession = {
    config: { agentType?: string; modelName?: string; reasoningPreset?: string };
    draft?: { workspaceId: string; phase: 'editing'; turnId: string; modelRouting?: 'manual' | 'smart' };
  };
  const sessions = new Map<string, TestSession>();
  const subscribers = new Set<() => void>();
  const configChangeListeners = new Set<(path: string) => void>();
  const store = {
    getState: () => ({ sessions }),
    setState: vi.fn((update: (state: { sessions: typeof sessions }) => { sessions: typeof sessions }) => {
      const next = new Map(update({ sessions }).sessions);
      sessions.clear();
      next.forEach((session, id) => sessions.set(id, session));
      subscribers.forEach(callback => callback());
    }),
    subscribe: vi.fn((callback: () => void) => {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    }),
    updateSessionModelName: vi.fn(),
    updateSessionReasoningPreset: vi.fn(),
    updateSessionMaxContextTokens: vi.fn(),
    updateAcpContextUsage: vi.fn(),
  };
  return { sessions, subscribers, configChangeListeners, store };
});

vi.mock('@/infrastructure/api/service-api/AIApi', () => ({
  aiApi: aiApiMocks,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Tooltip: ({ children, content, disabled }: {
    children: React.ReactElement<{ 'data-tooltip'?: string }>;
    content?: React.ReactNode;
    disabled?: boolean;
  }) => cloneElement(children, {
    'data-tooltip': !disabled && typeof content === 'string' ? content : undefined,
  }),
}));

vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: {
    getConfigs: vi.fn(),
    onConfigChange: vi.fn((listener: (path: string) => void) => {
      flowChatStoreMocks.configChangeListeners.add(listener);
      return () => flowChatStoreMocks.configChangeListeners.delete(listener);
    }),
    setConfig: vi.fn(async () => undefined),
    updateConfig: vi.fn(),
  },
}));

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: { updateSessionModel: vi.fn(async () => undefined), getModelRoutingStatus: vi.fn() },
}));

vi.mock('@/infrastructure/api/service-api/ACPClientAPI', () => ({
  ACPClientAPI: {
    getSessionOptions: vi.fn(),
    onSessionOptionsChanged: vi.fn(() => () => undefined),
  },
}));

vi.mock('../services/flow-chat-manager/SessionModule', () => ({
  getModelMaxTokens: vi.fn(async () => 128_000),
}));

vi.mock('@/infrastructure/event-bus', () => ({
  globalEventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

vi.mock('../store/FlowChatStore', () => ({
  FlowChatStore: { getInstance: () => flowChatStoreMocks.store },
}));

const model = (
  id: string,
  providerName: string,
  providerInstanceId: string | undefined,
  baseUrl: string,
) => ({
  id,
  name: providerName,
  model_name: `${id}-native`,
  provider: 'openai',
  base_url: baseUrl,
  enabled: true,
  category: 'text',
  capabilities: ['text_chat'],
  ...(providerInstanceId
    ? { metadata: { provider_instance_id: providerInstanceId } }
    : {}),
});

const CATALOG_MODELS = [
  model('acme-fast', 'Acme', 'provider-acme', 'https://acme.test/v1'),
  model('acme-deep', 'Acme', 'provider-acme', 'https://acme.test/v1'),
  model('umbra-main', 'Umbra', 'provider-umbra', 'https://umbra.test/v1'),
];

const providerRows = () => Array.from(
  document.body.querySelectorAll<HTMLButtonElement>(
    '[data-testid="chat-model-selector-provider"]',
  ),
);

const modelOption = (modelId: string) => document.body.querySelector<HTMLButtonElement>(
  `[data-testid="chat-model-selector-option"][data-model-id="${modelId}"]`,
) ?? document.body.querySelector<HTMLButtonElement>(`[data-testid="chat-model-selector-${modelId}-action"]`);

describe('ModelSelector provider levels', () => {
  let container: HTMLDivElement;
  let root: Root;

  const openSettingsMenu = async () => {
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-model-selector-btn"]',
      )?.click();
    });
  };

  const openMenu = async () => openModelList();

  const openAdvanced = async () => {
    const toggle = document.body.querySelector<HTMLButtonElement>('[data-testid="model-selection-advanced"]');
    if (toggle?.getAttribute('aria-expanded') === 'false') await act(async () => toggle.click());
  };

  const openModelList = async () => {
    if (container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded') !== 'true') {
      await openSettingsMenu();
    }
    await openAdvanced();
    const entry = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    );
    if (entry) await act(async () => entry.click());
  };

  const reopenModelList = async () => {
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')!;
    if (trigger.getAttribute('aria-expanded') === 'true') await act(async () => trigger.click());
    await openModelList();
  };

  const modeChoices = () => document.body.querySelector<HTMLElement>('[data-testid="chat-model-selector-mode-choices"]');
  const modeOption = (mode: 'manual' | 'smart' | 'pool') => modeChoices()?.querySelector<HTMLButtonElement>(
    `[data-openbitfun-value="${mode}"]`,
  ) ?? null;

  const searchTrigger = () => document.body.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-search-toggle"]')!;
  const searchInput = () => document.body.querySelector<HTMLInputElement>('[data-testid="chat-model-selector-search-input"]')!;
  const searchFor = async (query: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(searchInput(), query);
      searchInput().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const openProvider = async (providerKey: string) => {
    const provider = document.body.querySelector<HTMLButtonElement>(`[data-testid="chat-model-selector-provider"][data-provider-key="${providerKey}"]`);
    if (provider) {
      await act(async () => provider.click());
      return;
    }
    const search = document.body.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-search-toggle"]');
    if (search) await act(async () => search.click());
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-provider-filter"]')!.click());
    await act(async () => document.body.querySelector<HTMLButtonElement>(`[data-testid="chat-model-selector-provider-filter-menu"] [data-menu-id="${providerKey}"]`)!.click());
  };

  const optionsPanel = () => document.body.querySelector<HTMLElement>(
    '[data-testid="chat-model-selector-options"]',
  );

  const sharedPanelItems = () => optionsPanel()?.querySelector<HTMLElement>(
    '[data-openbitfun-part="section-items"]',
  ) ?? null;

  const renderSelector = async (
    models: unknown[] = CATALOG_MODELS,
    modeModel = 'primary',
    sessionId?: string,
    defaultModels: DefaultModelsConfig = { primary: 'acme-fast', fast: 'umbra-main', economy: 'umbra-main' },
  ) => {
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': models,
      'ai.default_models': defaultModels,
      'ai.agent_model_defaults': { mode: modeModel },
    });

    await act(async () => {
      root.render(
        <ModelSelector
          currentMode='Standard'
          sessionId={sessionId}
          reasoningTriggerPresentation="label"
        />,
      );
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    activateSurface('local');
    vi.mocked(configManager.getConfigs).mockReset();
    vi.mocked(configManager.setConfig).mockReset().mockResolvedValue(undefined);
    vi.mocked(configManager.updateConfig).mockReset().mockImplementation(async (path, update) => {
      const config = await configManager.getConfigs([path]);
      const changed = update(config[path]);
      vi.mocked(configManager.getConfigs).mockResolvedValue({ ...config, [path]: changed });
      return changed;
    });
    vi.mocked(agentAPI.getModelRoutingStatus).mockReset().mockResolvedValue({ apiVersion: 1, mode: 'manual', defaultMode: 'manual', ready: false, connected: null, issue: 'Configure Router', summaryEnabled: false, subagentModel: 'primary' });
    aiApiMocks.getModelCatalog.mockReset();
    vi.mocked(agentAPI.updateSessionModel).mockReset().mockResolvedValue(undefined);
    notificationStore.clearActiveNotifications();
    notificationStore.clearHistory();
    flowChatStoreMocks.sessions.clear();
    flowChatStoreMocks.subscribers.clear();
    flowChatStoreMocks.configChangeListeners.clear();
    flowChatStoreMocks.store.updateSessionModelName.mockImplementation((sessionId: string, modelName: string) => {
      const session = flowChatStoreMocks.sessions.get(sessionId);
      if (session) session.config.modelName = modelName;
      flowChatStoreMocks.subscribers.forEach(callback => callback());
    });
    flowChatStoreMocks.store.updateSessionReasoningPreset.mockImplementation((sessionId: string, preset?: string) => {
      const session = flowChatStoreMocks.sessions.get(sessionId);
      if (session) session.config.reasoningPreset = preset;
      flowChatStoreMocks.subscribers.forEach(callback => callback());
    });
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, String(value)),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() { return storage.size; },
    });
    aiApiMocks.getModelCatalog.mockResolvedValue({
      version: 1,
      default_models: { primary: 'acme-fast' },
      models: [],
    });
    aiApiMocks.onModelCatalogUpdated.mockImplementation(() => () => undefined);
    class TestResizeObserver {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    useConfirmDialogStore.getState().cancel();
    notificationStore.clearActiveNotifications();
    notificationStore.clearHistory();
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('searches selectable models across providers without changing the selection while typing', async () => {
    await renderSelector([
      ...CATALOG_MODELS,
      { ...model('disabled-model', 'Hidden', 'disabled-provider', 'https://hidden.test'), enabled: false },
      { ...model('image-model', 'Images', 'image-provider', 'https://images.test'), category: 'multimodal', capabilities: ['image_understanding'] },
    ]);
    await openModelList();
    expect(document.body.querySelector('[data-testid="chat-model-selector-override-back"]')?.textContent).toBe('modelSelector.roles.mainOverride');
    await act(async () => searchTrigger().click());
    expect(document.activeElement).toBe(searchInput());
    expect(document.body.querySelectorAll('[data-testid="chat-model-selector-option"]')).toHaveLength(3);
    expect(modelOption('disabled-model')).toBeNull();
    expect(modelOption('image-model')).toBeNull();
    expect(modelOption('acme-fast')?.getAttribute('aria-checked')).toBe('true');
    expect(modelOption('acme-fast')?.querySelector('[data-openbitfun-part="metadata"]')).toBeNull();

    await searchFor('  ACME deep  ');
    expect(document.activeElement).toBe(searchInput());
    expect(modelOption('acme-deep')?.textContent).toContain('acme-deep-native');
    expect(modelOption('acme-deep')?.querySelector('[data-openbitfun-part="label"]')?.textContent).toBe('acme-deep-native Acme');
    expect(modelOption('acme-deep')?.querySelector('[data-openbitfun-part="metadata"]')).toBeNull();
    expect(modelOption('acme-fast')).toBeNull();
    expect(modelOption('umbra-main')).toBeNull();
    await searchFor('deep');
    expect(modelOption('acme-deep')?.textContent).toBe('acme-deep-native');
    expect(modelOption('acme-deep')?.querySelector('[data-openbitfun-part="metadata"]')).toBeNull();
    await searchFor('Umbra');
    expect(modelOption('umbra-main')).not.toBeNull();
    expect(modelOption('umbra-main')?.querySelector('[data-openbitfun-part="label"]')?.textContent).toBe('umbra-main-native Umbra');
    expect(modelOption('umbra-main')?.querySelector('[data-openbitfun-part="metadata"]')).toBeNull();
    expect(modelOption('acme-deep')).toBeNull();
    await searchFor('  ');
    expect(modelOption('umbra-main')?.querySelector('[data-openbitfun-part="metadata"]')).toBeNull();
    expect(configManager.setConfig).not.toHaveBeenCalled();
  });

  it('keeps text editing inside search and supports keyboard selection and return focus', async () => {
    await renderSelector();
    await openModelList();
    await act(async () => searchTrigger().click());
    await searchFor('deep');
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      await act(async () => searchInput().dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(searchInput());
    }
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(modelOption('acme-deep'));
    await act(async () => modelOption('acme-deep')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(searchInput());
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(configManager.setConfig).toHaveBeenCalledExactlyOnceWith('ai.agent_model_defaults.mode', 'acme-deep');
    expect(document.body.querySelector('[data-testid="chat-model-selector-search-input"]')).toBeNull();
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]'));
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('focuses and scrolls the selected model when opening a long list', async () => {
    const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    try {
      const models = Array.from({ length: 24 }, (_, index) => model(`model-${index}`, 'Acme', 'provider-acme', 'https://acme.test/v1'));
      await renderSelector(models, 'model-23');
      await openModelList();
      const selected = modelOption('model-23');
      expect(document.activeElement).toBe(selected);
      expect(selected?.getAttribute('aria-checked')).toBe('true');
      expect(scrollIntoView.mock.contexts).toContain(selected);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    } finally {
      if (previousScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousScroll);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('keeps model rows above the actions and combines provider filtering with search', async () => {
    await renderSelector();
    await openModelList();
    const results = document.body.querySelector('[data-testid="chat-model-selector-results"]')!;
    const actions = document.body.querySelector('[data-testid="chat-model-selector-actions"]')!;
    expect(results.nextElementSibling).toBe(actions);
    expect(results.querySelectorAll('[data-testid="chat-model-selector-option"]')).toHaveLength(3);
    expect(actions.contains(modelOption('primary'))).toBe(true);
    expect(actions.contains(modelOption('fast'))).toBe(true);
    expect(actions.querySelector('[data-model-mode]')).toBeNull();
    expect(document.activeElement).toBe(modelOption('acme-fast'));
    expect(searchInput()).toBeNull();
    expect(actions.querySelector('[data-testid="chat-model-selector-summary-back"]')).toBeNull();
    const divider = actions.querySelector('[data-testid="chat-model-selector-actions-divider"]')!;
    expect(searchTrigger().parentElement?.previousElementSibling).toBe(divider);
    const quickActions = actions.querySelector('[data-testid="chat-model-selector-quick-actions"]')!;
    expect(divider.previousElementSibling?.contains(quickActions)).toBe(true);
    expect(quickActions.firstElementChild).toBe(modelOption('primary'));
    expect(modelOption('primary')?.textContent).toBe('modelSelector.primaryModel');
    expect(modelOption('fast')?.textContent).toBe('');

    await act(async () => searchTrigger().click());
    expect(document.activeElement).toBe(searchInput());
    expect(actions.querySelector('[data-testid="chat-model-selector-actions-divider"]')).not.toBeNull();
    const showActions = actions.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-show-actions"]')!;
    expect(showActions.querySelector('.lucide-layout-grid')).not.toBeNull();
    expect(showActions.parentElement?.nextElementSibling).toBe(actions.querySelector('[data-testid="chat-model-selector-actions-divider"]'));
    expect(actions.querySelector('[data-testid="chat-model-selector-search-collapse"]')).toBeNull();
    for (const action of [modelOption('primary'), modelOption('fast')]) expect(action).toBeNull();

    const filter = actions.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-provider-filter"]')!;
    const searchCapsule = searchInput().closest('[data-openbitfun-component="input"]')!;
    expect(searchCapsule.getAttribute('data-shape')).toBe('pill');
    expect(searchCapsule.contains(filter)).toBe(true);
    const filterMenu = () => document.body.querySelector<HTMLElement>(
      '[data-testid="chat-model-selector-provider-filter-menu"]:not([aria-hidden="true"])',
    );
    expect(actions.querySelector('[role="combobox"]')).toBeNull();
    expect(filter.textContent).toBe('');
    expect(filter.getAttribute('aria-expanded')).toBe('false');
    expect(filterMenu()).toBeNull();
    const selectProvider = async (providerKey: string) => {
      await act(async () => filter.click());
      expect(filter.getAttribute('aria-expanded')).toBe('true');
      const option = filterMenu()!.querySelector<HTMLButtonElement>(`[data-menu-id="${providerKey}"]`)!;
      await act(async () => {
        option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        option.click();
      });
      expect(filter.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(filter);
      expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    };
    await selectProvider('provider-acme');
    expect(filter.getAttribute('aria-pressed')).toBe('true');
    expect(modelOption('acme-fast')).not.toBeNull();
    expect(modelOption('umbra-main')).toBeNull();
    expect(modelOption('acme-fast')?.querySelector('[data-openbitfun-part="metadata"]')).toBeNull();
    expect(searchInput().closest('.openbitfun-model-selector__picker-actions')).toBe(actions.firstElementChild);
    expect(actions.childElementCount).toBe(1);
    await searchFor('deep');
    expect(modelOption('acme-deep')).not.toBeNull();
    expect(modelOption('acme-fast')).toBeNull();
    await selectProvider('provider-umbra');
    expect(document.body.querySelector('[data-testid="chat-model-selector-search-empty"]')).not.toBeNull();
    await searchFor('main');
    expect(modelOption('umbra-main')).not.toBeNull();
    expect(configManager.setConfig).not.toHaveBeenCalled();

    await act(async () => filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
    const popup = filterMenu()!;
    await act(async () => popup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(filterMenu()).toBeNull();
    expect(document.activeElement).toBe(filter);
    expect(document.body.querySelector('[data-testid="chat-model-selector-actions"]')).toBe(actions);
    await searchFor('');
    await selectProvider('all-providers');
    expect(filter.getAttribute('aria-pressed')).toBe('false');
    expect(results.querySelectorAll('[data-testid="chat-model-selector-option"]')).toHaveLength(3);
    await act(async () => showActions.click());
    expect(document.activeElement).toBe(searchTrigger());
    expect(actions.querySelector('[data-testid="chat-model-selector-actions-divider"]')).not.toBeNull();
    expect(modelOption('primary')?.textContent).toBe('modelSelector.primaryModel');
    expect(modelOption('primary')).not.toBeNull();
  });

  it('shows empty results, ignores IME confirmation and resets the query after leaving search', async () => {
    await renderSelector();
    await openModelList();
    await act(async () => searchTrigger().click());
    await searchFor('does-not-exist');
    expect(document.body.querySelector('[data-testid="chat-model-selector-search-empty"]')?.textContent).toBe('modelSelector.noSearchResults');
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(configManager.setConfig).not.toHaveBeenCalled();
    await searchFor('deep');
    for (const key of ['Enter', 'Escape', 'ArrowDown']) {
      await act(async () => searchInput().dispatchEvent(new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true })));
      expect(document.activeElement).toBe(searchInput());
    }
    expect(configManager.setConfig).not.toHaveBeenCalled();
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(searchTrigger());
    await act(async () => searchTrigger().click());
    expect(searchInput().value).toBe('');
    expect(document.body.querySelectorAll('[data-testid="chat-model-selector-option"]')).toHaveLength(3);
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await act(async () => searchTrigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]'));
  });

  it('keeps loading feedback through configuration and catalog loading, then focuses the ready card', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    let resolveConfig!: (config: Record<string, unknown>) => void;
    let resolveCatalog!: (catalog: AIModelCatalog) => void;
    vi.mocked(configManager.getConfigs).mockReturnValueOnce(new Promise(resolve => {
      resolveConfig = resolve;
    }));
    aiApiMocks.getModelCatalog.mockReturnValueOnce(new Promise<AIModelCatalog>(resolve => {
      resolveCatalog = resolve;
    }));
    await renderSelector();

    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')!;
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      vi.advanceTimersToNextFrame();
    });
    const menu = document.body.querySelector('[data-testid="chat-model-selector-menu"]')!;
    const loadingState = () => menu.querySelector('[data-testid="chat-model-selector-loading"]');
    expect(loadingState()?.getAttribute('role')).toBe('status');
    expect(loadingState()?.textContent).toContain('modelSelector.status.loading');
    expect(loadingState()?.querySelector('[data-openbitfun-component="spinner"]')).not.toBeNull();
    expect(menu.querySelector('[data-testid="chat-model-selector-settings-model"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => resolveConfig({
      'ai.models': CATALOG_MODELS,
      'ai.default_models': { primary: 'acme-fast' },
      'ai.agent_model_defaults': { mode: 'primary' },
    }));
    expect(aiApiMocks.getModelCatalog).toHaveBeenCalledTimes(1);
    expect(loadingState()).not.toBeNull();
    expect(menu.getAttribute('aria-busy')).toBe('true');

    await act(async () => resolveCatalog({ version: 1, models: [] }));
    await act(async () => { vi.advanceTimersToNextFrame(); });
    const modelField = menu.querySelector('[data-testid="model-selection-config-primary"]');
    expect(loadingState()).toBeNull();
    expect(modelField?.textContent).toContain('acme-fast-native');
    expect(trigger.hasAttribute('aria-busy')).toBe(false);
    expect(menu.hasAttribute('aria-busy')).toBe(false);
    expect(document.activeElement).toBe(modelField);
  });

  it.each(['configuration', 'catalog'])('leaves loading when the %s request fails', async source => {
    let rejectLoad!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => { rejectLoad = reject; });
    if (source === 'configuration') {
      vi.mocked(configManager.getConfigs).mockReturnValueOnce(pending);
    } else {
      aiApiMocks.getModelCatalog.mockReturnValueOnce(pending);
    }
    await renderSelector();
    await openSettingsMenu();
    expect(document.body.querySelector('[data-testid="chat-model-selector-loading"]')).not.toBeNull();

    await act(async () => rejectLoad(new Error('Host offline')));
    expect(document.body.querySelector('[data-testid="chat-model-selector-loading"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.hasAttribute('aria-busy')).toBe(false);
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.textContent).toContain(source === 'configuration'
      ? 'modelSelector.status.loadError' : 'acme-fast-native');
  });

  it('preserves model information during a catalog refresh', async () => {
    await renderSelector();
    await openSettingsMenu();
    await openAdvanced();
    const modelField = document.body.querySelector('[data-testid="chat-model-selector-settings-model"]');
    let resolveCatalog!: (catalog: AIModelCatalog) => void;
    aiApiMocks.getModelCatalog.mockReturnValueOnce(new Promise<AIModelCatalog>(resolve => {
      resolveCatalog = resolve;
    }));
    await act(async () => { aiApiMocks.onModelCatalogUpdated.mock.calls[0][0](); });

    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.hasAttribute('aria-busy')).toBe(false);
    expect(document.body.querySelector('[data-testid="chat-model-selector-loading"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]')).toBe(modelField);
    expect(modelField?.textContent).toContain('acme-fast-native');

    await act(async () => resolveCatalog({ version: 2, models: [] }));
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.hasAttribute('aria-busy')).toBe(false);
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]')).toBe(modelField);
  });

  it('keeps context and effort visible while hiding the main override in advanced options', async () => {
    flowChatStoreMocks.sessions.set('session-a', {
      config: {
        agentType: 'Standard',
        modelName: 'umbra-main',
        reasoningPreset: 'high',
      },
    });
    aiApiMocks.getModelCatalog.mockResolvedValue({
      version: 1,
      default_models: { primary: 'acme-fast' },
      models: [{
        id: 'umbra-main',
        reasoning: {
          status: 'known',
          default_preset: 'medium',
          presets: [
            { id: 'medium', label: 'Medium', order: 10, source: 'models_dev', actions: [{ type: 'effort', value: 'medium' }] },
            { id: 'high', label: 'High', order: 20, source: 'models_dev', actions: [{ type: 'effort', value: 'high' }] },
          ],
        },
      }],
    });

    await renderSelector(CATALOG_MODELS, 'primary', 'session-a');
    await openSettingsMenu();

    const settings = document.body.querySelector(
      '[data-testid="chat-model-selector-settings"]',
    );
    expect(settings).not.toBeNull();
    expect(Array.from(settings!.querySelectorAll('[data-testid]'))
      .map(element => element.getAttribute('data-testid'))
      .filter(id => ['chat-model-selector-settings-fast', 'chat-model-selector-settings-context', 'chat-model-selector-settings-reasoning', 'chat-model-selector-settings-model'].includes(id!)))
      .toEqual(['chat-model-selector-settings-context', 'chat-model-selector-settings-reasoning']);
    expect(settings?.querySelector('[data-testid="model-selection-scope"]')).toBeNull();
    expect(settings?.querySelector('[data-testid="model-selection-override-summary"]')?.textContent).toBe('modelSelector.roles.activeOverride');
    await openAdvanced();
    expect(settings?.querySelector('[data-testid="model-selection-scope"]')).not.toBeNull();
    expect(settings?.querySelector(
      '[data-testid="chat-model-selector-settings-model"]',
    )?.textContent).toContain('umbra-main-native');
    expect(settings?.querySelector('[data-testid="chat-model-selector-settings-provider"]')).toBeNull();
    expect(settings?.querySelector('[data-testid="model-selection-role-config"]')).not.toBeNull();
    expect(settings?.querySelector('[data-testid="chat-model-selector-settings-mode"]')).toBeNull();
    expect(optionsPanel()).toBeNull();
    expect(settings?.querySelector(
      '[data-testid="chat-model-selector-settings-reasoning"]',
    )?.textContent).toContain('reasoningSelector.levels.high');
    expect(modeOption('manual')?.getAttribute('aria-pressed')).toBe('true');
    expect(settings?.querySelector('.openbitfun-reasoning-control__title')).toBeNull();
    expect(settings?.querySelector('[role="menuitemcheckbox"]')).toBeNull();
    expect(settings?.querySelector(
      '[data-testid="chat-model-selector-settings-reset"]',
    )).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-btn"]',
    );
    const reasoningSummary = trigger?.querySelector(
      '[data-testid="chat-model-selector-trigger-reasoning"]',
    );
    const dropdownIndicator = trigger?.querySelector(
      '[data-testid="chat-model-selector-dropdown-indicator"]',
    );
    expect(reasoningSummary?.textContent).toContain('reasoningSelector.levels.high');
    expect(reasoningSummary?.nextElementSibling).toBe(dropdownIndicator);
    expect(
      container.querySelector('[data-testid="chat-reasoning-preset-selector-btn"]'),
    ).toBeNull();

  });

  it.each([
    ['primary', 'modelSelector.primaryModel', 'acme-fast-native'],
    ['fast', 'modelSelector.fastModel', 'umbra-main-native'],
  ])('shows the %s main-session choice separately from the two role configurations', async (selection, label, modelName) => {
    await renderSelector(CATALOG_MODELS, selection);
    await openSettingsMenu();
    await openAdvanced();
    const row = document.body.querySelector('[data-testid="chat-model-selector-settings-model"]')!;
    expect(row.textContent).toContain(modelName);
    expect(row.textContent).toContain(selection === 'primary' ? 'modelSelector.roles.followPrimary' : 'modelSelector.roles.useFast');
    const role = document.body.querySelector(`[data-testid="model-selection-config-${selection}"]`)!;
    expect(role.hasAttribute('aria-checked')).toBe(false);
    expect(role.textContent).toContain(label);
    expect(role.textContent).toContain(modelName);
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-fast-row"]')).toBeNull();
    expect(document.body.querySelector('input[type="checkbox"]')).toBeNull();
  });

  const contextInput = () => document.body.querySelector<HTMLInputElement>('[data-testid="chat-model-selector-context-input"]')!;
  const editContext = async (value: string) => {
    if (!contextInput()) await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-settings-context"]')!.click());
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(contextInput(), value);
      contextInput().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const saveContext = async () => {
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-context-save"]')!.click());
  };

  it('edits the resolved model context inline and preserves other configuration fields', async () => {
    const openSettings = vi.spyOn(quickActions, 'openSettings').mockImplementation(() => undefined);
    try {
      const models = CATALOG_MODELS.map(model => ({ ...model, context_window: 300_000, api_key: 'preserved-key', future_option: { enabled: true } }));
      flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'primary' } });
      await renderSelector(models, 'primary', 'session-a');
      await openSettingsMenu();
      expect(document.body.querySelector('[data-testid="chat-model-selector-settings-context"]')?.textContent).toContain('300K');
      await editContext('512000');
      expect(document.activeElement).toBe(contextInput());
      await saveContext();
      expect(configManager.updateConfig).toHaveBeenCalledExactlyOnceWith('ai.models', expect.any(Function));
      expect(await vi.mocked(configManager.updateConfig).mock.results[0].value).toEqual([
        { ...models[0], context_window: 512_000 }, models[1], models[2],
      ]);
      expect(document.body.querySelector('[data-testid="chat-model-selector-settings-context"]')?.textContent).toContain('512K');
      expect(flowChatStoreMocks.store.updateSessionMaxContextTokens).toHaveBeenCalledExactlyOnceWith('session-a', 512_000);
      expect(openSettings).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(document.body.querySelector('[data-testid="chat-model-selector-settings-context"]'));
      expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    } finally {
      openSettings.mockRestore();
    }
  });

  it('validates context limits and respects composition and cancellation before saving', async () => {
    await renderSelector(CATALOG_MODELS.map(model => ({ ...model, context_window: 300_000 })));
    await openSettingsMenu();
    for (const invalid of ['', '31000', '2000001', '64000.5', 'tokens']) {
      await editContext(invalid);
      await saveContext();
      expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('modelSelector.home.contextInvalid');
      expect(configManager.updateConfig).not.toHaveBeenCalled();
    }
    await editContext('512000');
    await act(async () => contextInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    expect(configManager.updateConfig).not.toHaveBeenCalled();
    await act(async () => contextInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(contextInput()).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-context"]')?.textContent).toContain('300K');
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    await editContext('512000');
    await act(async () => contextInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-context"]')?.textContent).toContain('512K');
  });

  it('retains the context draft and committed limit after failure, then allows retry', async () => {
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'primary' } });
    await renderSelector(CATALOG_MODELS.map(model => ({ ...model, context_window: 300_000 })), 'primary', 'session-a');
    await openSettingsMenu();
    await editContext('512000');
    vi.mocked(configManager.updateConfig).mockRejectedValueOnce(new Error('Host offline'));
    await saveContext();
    expect(contextInput().value).toBe('512000');
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('modelSelector.home.contextSaveFailed');
    expect(flowChatStoreMocks.store.updateSessionMaxContextTokens).not.toHaveBeenCalled();
    await saveContext();
    expect(contextInput()).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-context"]')?.textContent).toContain('512K');
    expect(flowChatStoreMocks.store.updateSessionMaxContextTokens).toHaveBeenCalledExactlyOnceWith('session-a', 512_000);
  });

  it('does not apply an old context save to the newly activated device', async () => {
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'primary' } });
    await renderSelector(CATALOG_MODELS.map(model => ({ ...model, context_window: 300_000 })), 'primary', 'session-a');
    await openSettingsMenu();
    let finish!: (models: AIModelConfig[]) => void;
    vi.mocked(configManager.updateConfig).mockImplementationOnce(async (_path, update) => {
      const current = (await configManager.getConfigs(['ai.models']))['ai.models'];
      const updated = update(current) as AIModelConfig[];
      return new Promise(resolve => { finish = resolve; }).then(() => updated);
    });
    await editContext('512000');
    await saveContext();
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': CATALOG_MODELS.map(model => ({ ...model, context_window: 128_000 })),
      'ai.default_models': { primary: 'acme-fast' },
      'ai.agent_model_defaults': { mode: 'primary' },
    });
    await act(async () => { activateSurface('peer-context-host'); });
    await act(async () => finish([]));
    expect(flowChatStoreMocks.store.updateSessionMaxContextTokens).not.toHaveBeenCalled();
    await openSettingsMenu();
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-context"]')?.textContent).toContain('128K');
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(['primary', 'fast', 'acme-deep'])('shows concrete models above the default shortcut actions for %s', async modelId => {
    await renderSelector(CATALOG_MODELS, modelId);
    await openSettingsMenu();
    await openAdvanced();

    const modelControl = () => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    )!;
    await act(async () => modelControl().click());

    expect(document.body.querySelector('[data-testid="chat-model-selector-menu"]')
      ?.getAttribute('data-menu-level')).toBe('models');
    expect(providerRows()).toHaveLength(0);
    const choices = Array.from(sharedPanelItems()!.querySelectorAll<HTMLButtonElement>(
      '[data-testid="chat-model-selector-option"]',
    ));
    expect(choices.map(row => row.dataset.modelId)).toEqual(['acme-fast', 'acme-deep', 'umbra-main']);
    expect(modelOption('primary')?.getAttribute('aria-pressed')).toBe(String(modelId === 'primary'));
    expect(modelOption('fast')?.getAttribute('aria-pressed')).toBe(String(modelId === 'fast'));
    expect(modelOption('primary')?.getAttribute('aria-label')).toBe('modelSelector.primaryModel');
    expect(modelOption('primary')?.dataset.modelName).toBe('acme-fast-native');
    expect(modelOption('primary')?.dataset.tooltip).toBe('modelSelector.primaryModel · acme-fast-native');
    expect(modelOption('fast')?.getAttribute('aria-label')).toBe('modelSelector.fastModel');
    expect(modelOption('fast')?.dataset.modelName).toBe('umbra-main-native');
    expect(modelOption('fast')?.dataset.tooltip).toBe('modelSelector.fastModel · umbra-main-native');
    expect(modelOption('primary')?.textContent).toBe(modelId === 'primary' ? 'modelSelector.primaryModel' : '');
    expect(modelOption('fast')?.textContent).toBe(modelId === 'fast' ? 'modelSelector.fastModel' : '');
    for (const role of ['primary', 'fast']) {
      const action = modelOption(role)!;
      expect(Boolean(action.querySelector('.lucide-check'))).toBe(modelId === role);
      expect(Boolean(action.querySelector(role === 'primary' ? '.lucide-gem' : '.lucide-rocket'))).toBe(modelId !== role);
    }
    expect(document.activeElement).toBe(modelOption(modelId === 'primary' ? 'acme-fast' : modelId === 'fast' ? 'umbra-main' : modelId));

    expect(document.body.querySelector('[data-testid="chat-model-selector-summary-back"]')).toBeNull();
    await act(async () => optionsPanel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(optionsPanel()).toBeNull();
    expect(document.activeElement).toBe(modelControl());

    await act(async () => modelControl().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    ));
    expect(modelOption('primary')).not.toBeNull();
    await act(async () => optionsPanel()!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ));
    expect(optionsPanel()).toBeNull();
    expect(document.activeElement).toBe(modelControl());
    expect(configManager.setConfig).not.toHaveBeenCalled();
  });

  it.each(['primary', 'fast'])('persists the %s shortcut as a symbolic session selection', async modelId => {
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'acme-deep' } });
    await renderSelector(CATALOG_MODELS, 'acme-deep', 'session-a');
    await openModelList();
    await act(async () => modelOption(modelId)!.click());

    expect(agentAPI.updateSessionModel).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-a', modelName: modelId,
    }));
    expect(configManager.setConfig).toHaveBeenCalledWith('ai.agent_model_defaults.mode', modelId);
    expect(flowChatStoreMocks.sessions.get('session-a')?.config.modelName).toBe(modelId);
    expect(optionsPanel()).toBeNull();
    const defaultIcon = container.querySelector('[data-testid="chat-model-selector-default-icon"]');
    expect(defaultIcon?.getAttribute('data-model-role')).toBe(modelId);
    expect(defaultIcon?.querySelector(modelId === 'primary' ? '.lucide-gem' : '.lucide-rocket')).not.toBeNull();
    const triggerLabel = container.querySelector('[data-testid="chat-model-selector-btn"] .openbitfun-model-selector__name');
    expect(triggerLabel?.textContent).toBe(modelId === 'primary' ? 'acme-fast-native' : 'umbra-main-native');
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    )!.click());
    expect(modelOption(modelId)?.getAttribute('aria-pressed')).toBe('true');
  });

  it.each([undefined, 'removed-model', 'disabled-fast'])('resolves the fast shortcut through primary when fast is %s', async fast => {
    await renderSelector([
      ...CATALOG_MODELS,
      { ...CATALOG_MODELS[2], id: 'disabled-fast', enabled: false },
    ], 'acme-deep', undefined, { primary: 'acme-fast', fast });
    await openModelList();
    expect(modelOption('fast')?.disabled).toBe(false);
    expect(modelOption('fast')?.dataset.modelName).toBe('acme-fast-native');
    await act(async () => modelOption('fast')!.click());
    expect(configManager.setConfig).toHaveBeenCalledWith('ai.agent_model_defaults.mode', 'fast');
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]')?.textContent)
      .toContain('acme-fast-native');
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    )!.click());
    expect(modelOption('fast')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('disables unresolved default shortcuts while keeping concrete models selectable', async () => {
    await renderSelector(CATALOG_MODELS, 'acme-deep', undefined, {});
    await openModelList();
    for (const modelId of ['primary', 'fast']) {
      expect(modelOption(modelId)?.disabled).toBe(true);
      expect(modelOption(modelId)?.dataset.tooltip).toBe(`${modelId === 'primary' ? 'modelSelector.primaryModel' : 'modelSelector.fastModel'} · modelSelector.modelNotConfigured`);
      await act(async () => modelOption(modelId)!.click());
    }
    expect(document.body.querySelector('[data-testid="chat-model-selector-quick-actions"] [data-model-mode]')).toBeNull();
    expect(configManager.setConfig).not.toHaveBeenCalled();
    await act(async () => modelOption('acme-fast')!.click());
    expect(configManager.setConfig).toHaveBeenCalledWith('ai.agent_model_defaults.mode', 'acme-fast');
  });

  it('resolves shortcuts from the selected peer surface without retaining local model labels', async () => {
    await renderSelector();
    await openModelList();
    expect(modelOption('primary')?.dataset.modelName).toBe('acme-fast-native');

    let finishPeerConfig!: (config: Record<string, unknown>) => void;
    vi.mocked(configManager.getConfigs).mockReturnValueOnce(new Promise(resolve => { finishPeerConfig = resolve; }));
    await act(async () => { activateSurface('peer-model-host'); });
    expect(document.body.textContent).not.toContain('acme-fast-native');
    expect(modelOption('primary')).toBeNull();

    await act(async () => finishPeerConfig({
      'ai.models': [model('peer-model', 'Peer', 'provider-peer', 'https://peer.test/v1')],
      'ai.default_models': { primary: 'peer-model' },
      'ai.agent_model_defaults': { mode: 'primary' },
    }));
    await openModelList();
    expect(modelOption('primary')?.dataset.modelName).toBe('peer-model-native');
    expect(modelOption('fast')?.dataset.modelName).toBe('peer-model-native');
    expect(document.body.textContent).not.toContain('acme-fast-native');
    await act(async () => modelOption('fast')!.click());
    expect(configManager.setConfig).toHaveBeenCalledWith('ai.agent_model_defaults.mode', 'fast');
  });

  it('presents an existing enabled override as Auto without rewriting it', async () => {
    flowChatStoreMocks.sessions.set('session-a', {
      config: { agentType: 'Standard', modelName: 'umbra-main', reasoningPreset: 'on' },
    });
    aiApiMocks.getModelCatalog.mockResolvedValue({
      version: 1,
      default_models: { primary: 'acme-fast' },
      models: [{
        id: 'umbra-main',
        reasoning: {
          status: 'known',
          default_preset: 'medium',
          presets: [
            { id: 'off', label: 'Off', order: 0, source: 'adapter_fallback', actions: [{ type: 'toggle', enabled: false }] },
            { id: 'on', label: 'On', order: 1, source: 'adapter_fallback', actions: [{ type: 'toggle', enabled: true }] },
            { id: 'low', label: 'Low', order: 10, source: 'adapter_fallback', actions: [{ type: 'effort', value: 'low' }] },
            { id: 'medium', label: 'Medium', order: 11, source: 'adapter_fallback', actions: [{ type: 'effort', value: 'medium' }] },
            { id: 'high', label: 'High', order: 12, source: 'adapter_fallback', actions: [{ type: 'effort', value: 'high' }] },
          ],
        },
      }],
    });

    await renderSelector(CATALOG_MODELS, 'primary', 'session-a');
    await openSettingsMenu();
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(
        '[data-testid="chat-model-selector-settings-reasoning"]',
      )?.click();
    });

    expect(document.body.querySelector(
      '[data-testid="chat-model-selector-settings"]',
    )).not.toBeNull();
    expect(optionsPanel()).toBeNull();
    const options = Array.from(document.body.querySelectorAll<HTMLButtonElement>(
      '[data-testid="chat-model-selector-reasoning-options"] button',
    ));
    expect(options.every(option => option.closest('[data-testid="chat-model-selector-settings"]'))).toBe(true);
    expect(options.map(option => option.dataset.openbitfunValue))
      .toEqual(['auto', 'preset:off', 'preset:low', 'preset:medium', 'preset:high']);
    expect(options.find(option => option.dataset.openbitfunValue === 'unavailable:xhigh')).toBeUndefined();
    expect(options.every(option => (
      option.querySelector('.openbitfun-model-selector__option-desc') === null
    ))).toBe(true);
    expect(options.every(option => option.querySelector('svg') === null)).toBe(true);
    expect(options.find(option => option.dataset.openbitfunValue === 'auto')?.getAttribute('aria-pressed'))
      .toBe('true');
    expect(flowChatStoreMocks.store.updateSessionReasoningPreset).not.toHaveBeenCalled();
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
  });

  it('offers and remembers reasoning presets before a session is created', async () => {
    aiApiMocks.getModelCatalog.mockResolvedValue({
      version: 1,
      default_models: { primary: 'acme-fast' },
      models: [{
        id: 'acme-fast',
        reasoning: {
          status: 'known',
          default_preset: 'medium',
          presets: [
            { id: 'medium', label: 'Medium', order: 10, source: 'models_dev', actions: [{ type: 'effort', value: 'medium' }] },
            { id: 'high', label: 'High', order: 20, source: 'models_dev', actions: [{ type: 'effort', value: 'high' }] },
          ],
        },
      }],
    });

    await renderSelector();
    await openSettingsMenu();

    const reasoningRow = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-reasoning"]',
    );
    expect(reasoningRow?.textContent).toBe('reasoningSelector.thinking · reasoningSelector.auto');

    await act(async () => reasoningRow?.click());
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(
        '[data-openbitfun-value="preset:high"]',
      )?.click();
    });

    expect(getRecentReasoningPreset('acme-fast')).toBe('high');
    expect(flowChatStoreMocks.store.updateSessionReasoningPreset).not.toHaveBeenCalled();
    expect(container.querySelector(
      '[data-testid="chat-model-selector-trigger-reasoning"]',
    )?.textContent).toContain('reasoningSelector.levels.high');
  });

  it('keeps unsupported battery routing disabled without changing the session or defaults', async () => {
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'umbra-main', reasoningPreset: 'high' } });
    await renderSelector(CATALOG_MODELS, 'umbra-main', 'session-a');
    await openSettingsMenu();
    expect(modeChoices()?.querySelectorAll('button')).toHaveLength(3);
    expect(modeOption('pool')?.disabled).toBe(true);
    await act(async () => modeOption('pool')!.click());
    expect(configManager.setConfig).not.toHaveBeenCalled();
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
    expect(flowChatStoreMocks.sessions.get('session-a')?.config.reasoningPreset).toBe('high');
    expect(useConfirmDialogStore.getState().isOpen).toBe(false);
    expect(notificationStore.getState().notificationHistory).toHaveLength(0);
  });

  it('selects smart mode in a new conversation draft before a runtime session exists', async () => {
    vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValue({
      apiVersion: 1, mode: 'manual', defaultMode: 'manual', ready: true,
      connected: null, issue: null, summaryEnabled: false,
    });
    flowChatStoreMocks.sessions.set('reserved', { config: { modelName: 'primary' },
      draft: { workspaceId: 'workspace-a', phase: 'editing', turnId: 'first' } });
    await renderSelector(CATALOG_MODELS, 'primary', 'reserved');
    await openSettingsMenu();
    await act(async () => modeOption('smart')!.click());
    expect(modeOption('smart')?.getAttribute('aria-pressed')).toBe('true');
    expect(flowChatStoreMocks.sessions.get('reserved')?.draft?.modelRouting).toBe('smart');
    expect(agentAPI.getModelRoutingStatus).toHaveBeenCalledWith({});
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
    expect(configManager.setConfig).toHaveBeenCalledWith('ai.model_routing.default_mode', 'smart');
  });

  it('keeps the active smart strategy visible when switching to manual is rejected', async () => {
    vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValue({
      apiVersion: 1, mode: 'smart', defaultMode: 'smart', ready: true,
      connected: null, issue: null, summaryEnabled: false,
    });
    vi.mocked(agentAPI.updateSessionModel).mockRejectedValue(new Error('Session is busy'));
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'primary' } });
    await renderSelector(CATALOG_MODELS, 'primary', 'session-a');
    await openSettingsMenu();
    await act(async () => modeOption('manual')!.click());
    expect(modeOption('smart')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.body.querySelector('[data-testid="model-selection-smart-economy"]')).not.toBeNull();
    expect(configManager.setConfig).not.toHaveBeenCalled();
    expect(agentAPI.updateSessionModel).toHaveBeenCalledWith(expect.objectContaining({ routingMode: 'manual' }));
  });

  it('configures smart subagent defaults under advanced options without changing manual roles', async () => {
    const host = { apiVersion: 1, mode: 'manual', defaultMode: 'manual', ready: false, connected: null, issue: 'Configure Router', summaryEnabled: false, subagentModel: 'primary' };
    vi.mocked(agentAPI.getModelRoutingStatus).mockImplementation(async () => ({ ...host }));
    vi.mocked(configManager.setConfig).mockImplementation(async (path, value) => {
      if (path === 'ai.model_routing.subagent_model') host.subagentModel = value as string;
    });
    await renderSelector(); await openSettingsMenu();
    await act(async () => modeOption('smart')!.click());
    expect(document.body.querySelector('[data-testid="model-selection-subagent-primary"]')).toBeNull();
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="model-selection-smart-advanced"]')!.click());
    const primary = () => document.body.querySelector<HTMLButtonElement>('[data-testid="model-selection-subagent-primary"]')!;
    const economy = () => document.body.querySelector<HTMLButtonElement>('[data-testid="model-selection-subagent-economy"]')!;
    expect(primary().getAttribute('aria-checked')).toBe('true');
    expect(economy().getAttribute('aria-checked')).toBe('false');
    expect(document.body.textContent).toContain('modelSelector.routing.subagents.hint');
    await act(async () => economy().click());
    expect(configManager.setConfig).toHaveBeenCalledExactlyOnceWith('ai.model_routing.subagent_model', 'economy');
    expect(configManager.updateConfig).not.toHaveBeenCalled();
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
    expect(economy().getAttribute('aria-checked')).toBe('true');
    await act(async () => modeOption('manual')!.click());
    expect(document.body.querySelector('[data-testid="model-selection-config-fast"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="model-selection-subagent-policy"]')?.textContent).toContain('modelSelector.roles.subagentDefault');
  });

  it.each(['old-host', 'missing-economy'] as const)('gates smart subagent choices for %s', async reason => {
    if (reason === 'old-host') vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValue({
      apiVersion: 1, mode: 'manual', defaultMode: 'manual', ready: false, connected: null, issue: null, summaryEnabled: false,
    });
    await renderSelector(CATALOG_MODELS, 'primary', undefined, { primary: 'acme-fast', fast: 'umbra-main', economy: reason === 'missing-economy' ? undefined : 'umbra-main' });
    await openSettingsMenu(); await act(async () => modeOption('smart')!.click());
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="model-selection-smart-advanced"]')!.click());
    expect(document.body.querySelector<HTMLButtonElement>('[data-testid="model-selection-subagent-economy"]')?.disabled).toBe(true);
    if (reason === 'old-host') {
      expect(document.body.querySelector<HTMLButtonElement>('[data-testid="model-selection-subagent-primary"]')?.disabled).toBe(true);
      expect(document.body.textContent).toContain('modelSelector.routing.subagents.unsupported');
    }
    expect(configManager.setConfig).not.toHaveBeenCalled();
  });

  it('shows unready smart configuration without enabling routing or changing defaults', async () => {
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'umbra-main', reasoningPreset: 'high' } });
    await renderSelector(CATALOG_MODELS, 'umbra-main', 'session-a');
    await openSettingsMenu();

    expect(modeOption('smart')?.disabled).toBe(false);
    await act(async () => modeOption('smart')!.click());
    expect(document.body.querySelector('[data-testid="model-selection-smart-preview"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="model-selection-smart-primary"]')?.textContent).toContain('acme-fast-native');
    expect(document.body.querySelector('[data-testid="model-selection-smart-economy"]')?.textContent).toContain('umbra-main-native');
    expect(document.body.textContent).toContain('modelSelector.routing.notReady');
    expect(document.body.querySelector('[data-testid="model-selection-scope"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="model-billing-summary"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="model-selection-config-primary"]')).toBeNull();
    expect(configManager.setConfig).not.toHaveBeenCalled();
    expect(configManager.updateConfig).not.toHaveBeenCalled();
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
    expect(flowChatStoreMocks.sessions.get('session-a')?.config).toEqual({ modelName: 'umbra-main', reasoningPreset: 'high' });

    await act(async () => modeOption('manual')!.click());
    expect(document.body.querySelector('[data-testid="model-selection-smart-preview"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="model-selection-config-primary"]')).not.toBeNull();
    expect(configManager.setConfig).not.toHaveBeenCalled();
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
  });

  const openRolePicker = async (role: 'primary' | 'economy') => {
    await act(async () => document.body.querySelector<HTMLButtonElement>(`[data-testid="model-selection-smart-${role}"]`)!.click());
  };
  const roleOption = (id: string) => document.body.querySelector<HTMLButtonElement>(`[data-testid="model-selection-role-option"][data-model-id="${id}"]`);

  const openRoleConfiguration = async (role: 'primary' | 'fast') => {
    await act(async () => document.body.querySelector<HTMLButtonElement>(`[data-testid="model-selection-config-${role}"]`)!.click());
  };

  it('collapses advanced overrides without changing models and resets the disclosure when reopened', async () => {
    await renderSelector(); await openSettingsMenu();
    expect(document.body.querySelector('[data-testid="model-selection-session-override"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="model-selection-override-summary"]')).toBeNull();
    await openAdvanced();
    expect(document.body.querySelector('[data-testid="model-selection-scope"]')?.textContent).toBe('modelSelector.scope.remember');
    await openModelList();
    await act(async () => modelOption('acme-deep')!.click());
    const toggle = document.body.querySelector<HTMLButtonElement>('[data-testid="model-selection-advanced"]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]'));
    expect(configManager.setConfig).toHaveBeenCalledExactlyOnceWith('ai.agent_model_defaults.mode', 'acme-deep');
    await act(async () => toggle.click());
    expect(document.body.querySelector('[data-testid="model-selection-session-override"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="model-selection-override-summary"]')).not.toBeNull();
    await openAdvanced();
    await openSettingsMenu(); await openSettingsMenu();
    expect(document.body.querySelector('[data-testid="model-selection-advanced"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(configManager.setConfig).toHaveBeenCalledOnce();
    expect(configManager.updateConfig).not.toHaveBeenCalled();
  });

  it('keeps a subagent’s own model selection directly accessible without global roles or advanced options', async () => {
    flowChatStoreMocks.sessions.set('subagent-a', { config: { modelName: 'umbra-main' } });
    await renderSelector(CATALOG_MODELS, 'primary', 'subagent-a');
    await act(async () => root.render(<ModelSelector currentMode="Standard" sessionId="subagent-a" isSubagentSession />));
    await openSettingsMenu();
    expect(document.body.querySelector('[data-testid="model-selection-role-config"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="model-selection-advanced"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="model-selection-scope"]')).toBeNull();
    await openModelList();
    await act(async () => modelOption('acme-deep')!.click());
    expect(flowChatStoreMocks.sessions.get('subagent-a')?.config.modelName).toBe('acme-deep');
    expect(configManager.setConfig).not.toHaveBeenCalled();
    expect(configManager.updateConfig).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'higher'] as const)('uses economy billing copy in smart mode and fast billing copy in manual mode: %s', async pricing => {
    const models = pricing === 'unknown' ? CATALOG_MODELS : CATALOG_MODELS.map((model, index) => withModelBilling(model, {
      version: 1, kind: 'api', currency: 'CNY', input: index + 1, output: index + 1,
      source: 'Fixture rates', account: '', updatedAt: '2026-10-19T00:00:00Z', binding: modelBillingBinding(model),
    }));
    await renderSelector(models); await openSettingsMenu();
    await act(async () => modeOption('smart')!.click());
    expect(document.body.querySelector('[data-testid="model-selection-smart-economy"]')?.textContent).toContain('modelSelector.economyModel');
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="model-billing-toggle"]')!.click());
    const billing = () => document.body.querySelector('[data-testid="model-billing-summary"]')!;
    expect(billing().textContent).toContain(pricing === 'unknown' ? 'billing.economyIncomplete' : 'billing.economyHigher');
    expect(billing().textContent).not.toContain('billing.fastHigher');
    if (pricing === 'higher') expect(billing().textContent).toContain('billing.economyEstimate');
    await act(async () => modeOption('manual')!.click());
    expect(billing().textContent).toContain(pricing === 'unknown' ? 'billing.incomplete' : 'billing.fastHigher');
    expect(billing().textContent).not.toContain('billing.economyHigher');
    expect(configManager.updateConfig).not.toHaveBeenCalled();
    expect(configManager.setConfig).not.toHaveBeenCalled();
  });

  it.each(['primary', 'fast'] as const)('edits the %s role without replacing the main session or subagent defaults', async role => {
    const defaults = { primary: 'acme-fast', fast: 'umbra-main', image_understanding: 'vision-model' };
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'umbra-main', reasoningPreset: 'high' } });
    await renderSelector(CATALOG_MODELS, 'umbra-main', 'session-a', defaults);
    await openSettingsMenu();
    const roles = document.body.querySelector('[data-testid="model-selection-role-config"]')!;
    expect(roles.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    expect(roles.querySelectorAll('[role="menuitemradio"]')).toHaveLength(0);
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-provider"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="model-selection-session-override"]')).toBeNull();
    vi.mocked(configManager.updateConfig).mockResolvedValueOnce({ ...defaults, [role]: 'acme-deep' });
    await openRoleConfiguration(role);
    expect(document.body.textContent).toContain('modelSelector.roles.saveHint');
    expect(document.body.textContent).not.toContain('modelSelector.picker.previewHint');
    await act(async () => roleOption('acme-deep')!.click());
    expect(configManager.updateConfig).toHaveBeenCalledExactlyOnceWith('ai.default_models', expect.any(Function));
    const updater = vi.mocked(configManager.updateConfig).mock.calls[0][1];
    expect(await updater(defaults)).toEqual({ ...defaults, [role]: 'acme-deep' });
    expect(document.body.querySelector(`[data-testid="model-selection-config-${role}"]`)?.textContent).toContain('acme-deep-native');
    expect(document.activeElement).toBe(document.body.querySelector(`[data-testid="model-selection-config-${role}"]`));
    expect(configManager.setConfig).not.toHaveBeenCalled();
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
    expect(flowChatStoreMocks.sessions.get('session-a')?.config).toEqual({ modelName: 'umbra-main', reasoningPreset: 'high' });
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="model-billing-toggle"]')!.click());
    expect(document.body.querySelector('[data-testid="model-billing-summary"]')?.textContent).toContain('acme-deep-native');
    expect(document.body.querySelector('[data-testid="model-billing-summary"]')?.textContent).toContain('umbra-main-native');
  });

  it('clears the fast binding to follow primary without making it a main-session choice', async () => {
    await renderSelector(); await openSettingsMenu();
    vi.mocked(configManager.updateConfig).mockResolvedValueOnce({ primary: 'acme-fast', fast: null });
    await openRoleConfiguration('fast');
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="model-selection-role-inherit"]')!.click());
    expect(await vi.mocked(configManager.updateConfig).mock.calls[0][1]({ primary: 'acme-fast', fast: 'umbra-main' }))
      .toEqual({ primary: 'acme-fast', fast: null });
    expect(document.body.querySelector('[data-testid="model-selection-config-fast"]')?.textContent).toContain('modelSelector.roles.followPrimary');
    expect(configManager.setConfig).not.toHaveBeenCalled();
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
    await openRoleConfiguration('fast');
    expect(document.body.querySelector('[data-testid="model-selection-role-inherit"]')?.getAttribute('aria-checked')).toBe('true');
    expect(roleOption('acme-fast')?.getAttribute('aria-checked')).toBe('false');
  });

  it('retains the configured role after a failed save and allows retry', async () => {
    await renderSelector(); await openSettingsMenu();
    vi.mocked(configManager.updateConfig).mockRejectedValueOnce(new Error('Host unavailable'));
    await openRoleConfiguration('fast');
    await act(async () => roleOption('acme-deep')!.click());
    expect(document.body.querySelector('[data-testid="model-selection-role-picker"]')).not.toBeNull();
    expect(roleOption('umbra-main')?.getAttribute('aria-checked')).toBe('true');
    expect(roleOption('acme-deep')?.disabled).toBe(false);
    expect(notificationStore.getState().notificationHistory.some(item => item.message === 'modelSelector.roles.saveFailed')).toBe(true);
    vi.mocked(configManager.updateConfig).mockResolvedValueOnce({ primary: 'acme-fast', fast: 'acme-deep' });
    await act(async () => roleOption('acme-deep')!.click());
    expect(document.body.querySelector('[data-testid="model-selection-config-fast"]')?.textContent).toContain('acme-deep-native');
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
  });

  it.each([{ kind: 'inherit' }, { kind: 'fixed', model_id: 'acme-deep' }])('shows a separately configured subagent default without rewriting it: %j', async selection => {
    await renderSelector();
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': CATALOG_MODELS,
      'ai.default_models': { primary: 'acme-fast', fast: 'umbra-main' },
      'ai.agent_model_defaults': { mode: 'primary', subagents: { default: selection } },
    });
    await act(async () => flowChatStoreMocks.configChangeListeners.forEach(listener => listener('ai.agent_model_defaults')));
    await openSettingsMenu();
    expect(document.body.querySelector('[data-testid="model-selection-subagent-policy"]')?.textContent).toBe('modelSelector.roles.subagentOverride');
    expect(document.body.querySelector('[data-testid="model-selection-config-fast"]')?.textContent).toContain('modelSelector.roles.fastAvailable');
    expect(document.body.querySelector('[data-testid="model-selection-config-fast"]')?.textContent).not.toContain('modelSelector.roles.fastPurpose');
    expect(configManager.setConfig).not.toHaveBeenCalled();
    expect(configManager.updateConfig).not.toHaveBeenCalled();
  });

  it('does not let a completed local role save replace the selected peer configuration', async () => {
    await renderSelector(); await openSettingsMenu();
    let finishSave!: (defaults: DefaultModelsConfig) => void;
    vi.mocked(configManager.updateConfig).mockReturnValueOnce(new Promise(resolve => { finishSave = resolve; }));
    await openRoleConfiguration('primary');
    await act(async () => roleOption('acme-deep')!.click());
    expect(roleOption('umbra-main')?.disabled).toBe(true);
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': [model('peer-model', 'Peer', 'provider-peer', 'https://peer.test/v1')],
      'ai.default_models': { primary: 'peer-model' },
      'ai.agent_model_defaults': { mode: 'primary' },
    });
    await act(async () => activateSurface('peer-role-config'));
    await openSettingsMenu();
    await act(async () => finishSave({ primary: 'acme-deep', fast: 'umbra-main' }));
    expect(document.body.querySelector('[data-testid="model-selection-config-primary"]')?.textContent).toContain('peer-model-native');
    expect(document.body.textContent).not.toContain('acme-deep-native');
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
  });

  it('persists independent smart role bindings without replacing main or subagent selections', async () => {
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'umbra-main', reasoningPreset: 'high' } });
    await renderSelector(CATALOG_MODELS, 'umbra-main', 'session-a');
    await openSettingsMenu();
    await act(async () => modeOption('smart')!.click());
    await openRolePicker('primary');
    expect(roleOption('acme-fast')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => roleOption('acme-deep')!.click());
    expect(document.body.querySelector('[data-testid="model-selection-role-picker"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="model-selection-smart-primary"]')?.textContent).toContain('acme-deep-native');
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="model-selection-smart-primary"]'));
    await openRolePicker('economy');
    await act(async () => roleOption('acme-fast')!.click());
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="model-selection-smart-economy"]'));
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="model-billing-toggle"]')!.click());
    const billing = document.body.querySelector('[data-testid="model-billing-summary"]')!;
    expect(billing.textContent).toContain('acme-deep-native');
    expect(billing.textContent).toContain('acme-fast-native');
    expect(billing.textContent).not.toContain('umbra-main-native');
    await act(async () => modeOption('manual')!.click());
    expect(document.body.querySelector('[data-testid="model-selection-config-primary"]')?.textContent).toContain('acme-deep-native');
    expect(document.body.querySelector('[data-testid="model-selection-config-fast"]')?.textContent).toContain('umbra-main-native');
    await openRoleConfiguration('primary');
    expect(roleOption('acme-fast')?.getAttribute('aria-checked')).toBe('false');
    expect(roleOption('acme-deep')?.getAttribute('aria-checked')).toBe('true');
    expect(configManager.setConfig).not.toHaveBeenCalled();
    expect(configManager.updateConfig).toHaveBeenCalledTimes(2);
    const saved = (await configManager.getConfigs(['ai.default_models']))['ai.default_models'];
    expect(saved).toEqual({ primary: 'acme-deep', fast: 'umbra-main', economy: 'acme-fast' });
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
    expect(flowChatStoreMocks.sessions.get('session-a')?.config).toEqual({ modelName: 'umbra-main', reasoningPreset: 'high' });
  });

  it('searches configured channels and excludes disabled or non-chat models from preview choices', async () => {
    await renderSelector([...CATALOG_MODELS,
      { ...model('disabled', 'Acme', 'provider-acme', 'https://acme.test/v1'), enabled: false },
      { ...model('image-only', 'Acme', 'provider-acme', 'https://acme.test/v1'), category: 'multimodal', capabilities: ['image_understanding'] },
    ]);
    await openSettingsMenu();
    await act(async () => modeOption('smart')!.click());
    await openRolePicker('primary');
    expect(roleOption('disabled')).toBeNull();
    expect(roleOption('image-only')).toBeNull();
    const search = document.body.querySelector<HTMLInputElement>('[aria-label="modelSelector.picker.search"]')!;
    expect(document.activeElement).toBe(search);
    const searchFor = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, value);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await searchFor('Umbra');
    expect(roleOption('umbra-main')).not.toBeNull();
    expect(roleOption('acme-fast')).toBeNull();
    await searchFor('no-such-model');
    expect(document.body.querySelector('[data-testid="model-selection-role-options"]')?.textContent).toContain('modelSelector.picker.empty');
    expect(document.body.querySelectorAll('[data-testid="model-selection-role-option"]')).toHaveLength(0);
  });

  it('returns from the inline role picker with Escape while retaining the smart preview', async () => {
    await renderSelector(); await openSettingsMenu();
    await act(async () => modeOption('smart')!.click());
    await openRolePicker('economy');
    const search = document.body.querySelector<HTMLInputElement>('[aria-label="modelSelector.picker.search"]')!;
    await act(async () => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true })));
    expect(document.body.querySelector('[data-testid="model-selection-role-picker"]')).not.toBeNull();
    await act(async () => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.body.querySelector('[data-testid="model-selection-role-picker"]')).toBeNull();
    expect(modeOption('smart')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="model-selection-smart-economy"]'));
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('shares role bindings between sessions while keeping each strategy separate', async () => {
    await renderSelector(CATALOG_MODELS, 'primary', 'session-a'); await openSettingsMenu();
    await act(async () => modeOption('smart')!.click());
    await openRolePicker('primary');
    await act(async () => roleOption('acme-deep')!.click());
    await renderSelector(CATALOG_MODELS, 'primary', 'session-b', { primary: 'acme-deep', fast: 'umbra-main', economy: 'umbra-main' });
    await act(async () => modeOption('smart')!.click());
    expect(document.body.querySelector('[data-testid="model-selection-smart-primary"]')?.textContent).toContain('acme-deep-native');
    expect(document.body.querySelector('[data-testid="model-selection-smart-primary"]')?.textContent).not.toContain('acme-fast-native');
  });

  it('selects the advertised levels inline and keeps Auto separate from Off without closing the card', async () => {
    aiApiMocks.getModelCatalog.mockResolvedValue({
      version: 1,
      default_models: { primary: 'acme-fast' },
      models: [{
        id: 'acme-fast',
        reasoning: {
          status: 'known',
          default_preset: 'medium',
          presets: ['off', 'low', 'medium', 'high', 'xhigh'].map((id, order) => ({
            id, label: id, order, source: 'models_dev', actions: id === 'off'
              ? [{ type: 'toggle', enabled: false }] : [{ type: 'effort', value: id }],
          })),
        },
      }],
    });
    await renderSelector();
    await openSettingsMenu();
    const slider = () => document.body.querySelector<HTMLInputElement>('input[type="range"]');
    const openReasoning = async () => {
      await act(async () => document.body.querySelector<HTMLButtonElement>(
        '[data-testid="chat-model-selector-settings-reasoning"]',
      )!.click());
    };
    expect(slider()).toBeNull();
    expect(document.body.querySelector('[data-reasoning-mode="auto"] [data-testid="chat-model-selector-settings-reasoning"]')?.textContent)
      .toBe('reasoningSelector.thinking · reasoningSelector.auto');

    await openReasoning();
    expect(document.body.querySelectorAll('[data-testid="chat-model-selector-reasoning-options"] [aria-pressed="true"]')).toHaveLength(1);
    expect(document.body.querySelector('[data-openbitfun-value="auto"]')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-openbitfun-value="preset:high"]',
    )!.click());
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(slider()).toBeNull();
    expect(optionsPanel()).toBeNull();
    const manualRow = document.body.querySelector('[data-reasoning-mode="manual"]')!;
    expect(manualRow.querySelector('[data-testid="chat-model-selector-settings-reasoning"]')?.textContent)
      .toBe('reasoningSelector.thinking · reasoningSelector.levels.high');
    expect(manualRow.querySelectorAll('[data-testid="chat-model-selector-settings-reasoning"]')).toHaveLength(1);
    expect(document.body.querySelector('[data-reasoning-mode="manual"] [data-openbitfun-name="reasoning-auto"]')).toBeNull();
    await openReasoning();
    expect(getRecentReasoningPreset('acme-fast')).toBe('high');
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-openbitfun-value="preset:off"]')!.click();
    });
    expect(getRecentReasoningPreset('acme-fast')).toBe('off');
    expect(slider()).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings-reasoning"]')?.textContent)
      .toBe('reasoningSelector.thinking · reasoningSelector.levels.off');
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="chat-model-selector-settings-reasoning"]'));

    await openReasoning();
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-openbitfun-value="auto"]',
    )!.click());
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(slider()).toBeNull();
    expect(getRecentReasoningPreset('acme-fast')).toBeUndefined();
    const autoRow = document.body.querySelector('[data-reasoning-mode="auto"]')!;
    const autoChoice = autoRow.querySelector('[data-testid="chat-model-selector-settings-reasoning"]');
    expect(autoChoice?.textContent).toBe('reasoningSelector.thinking · reasoningSelector.auto');
    expect(document.activeElement).toBe(autoChoice);
  });

  it('commits the session before remembering defaults and leaves the selector usable during that save', async () => {
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'umbra-main' } });
    let commitSession!: () => void;
    let saveDefault!: () => void;
    vi.mocked(agentAPI.updateSessionModel).mockReturnValueOnce(new Promise(resolve => { commitSession = resolve; }));
    vi.mocked(configManager.setConfig).mockReturnValueOnce(new Promise(resolve => { saveDefault = resolve; }));
    await renderSelector(CATALOG_MODELS, 'umbra-main', 'session-a');
    await openMenu();
    await openProvider('provider-acme');
    await act(async () => modelOption('acme-deep')!.click());
    expect(agentAPI.updateSessionModel).toHaveBeenCalledTimes(1);
    expect(configManager.setConfig).not.toHaveBeenCalled();
    await act(async () => commitSession());
    expect(configManager.setConfig).toHaveBeenCalledWith('ai.agent_model_defaults.mode', 'acme-deep');
    expect(optionsPanel()).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')!.disabled).toBe(false);
    expect(flowChatStoreMocks.sessions.get('session-a')?.config.modelName).toBe('acme-deep');
    await act(async () => saveDefault());
  });

  const chooseSaveScope = async (scope: 'session' | 'remember') => {
    await openAdvanced();
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="model-selection-scope"]')!.click());
    const choice = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
      .find(button => button.textContent === `modelSelector.scope.${scope}`)!;
    await act(async () => choice.click());
  };

  it('keeps a temporary model on its session without changing defaults or another session', async () => {
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'umbra-main' } });
    flowChatStoreMocks.sessions.set('session-b', { config: { modelName: 'umbra-main' } });
    await renderSelector(CATALOG_MODELS, 'umbra-main', 'session-a');
    await openSettingsMenu();
    await chooseSaveScope('session');
    await openModelList();
    await openProvider('provider-acme');
    await act(async () => modelOption('acme-deep')!.click());
    expect(agentAPI.updateSessionModel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-a', modelName: 'acme-deep' }));
    expect(configManager.setConfig).not.toHaveBeenCalled();
    expect(flowChatStoreMocks.sessions.get('session-b')?.config.modelName).toBe('umbra-main');
    expect(document.body.querySelector('[data-testid="model-selection-scope"]')?.textContent).toBe('modelSelector.scope.session');
    await chooseSaveScope('remember');
    expect(configManager.setConfig).toHaveBeenCalledWith('ai.agent_model_defaults.mode', 'acme-deep');
  });

  it('can make a choice temporary after selecting it without undoing the session change', async () => {
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'umbra-main' } });
    let savedDefault = 'umbra-main';
    vi.mocked(configManager.setConfig).mockImplementation(async (_path, value) => { savedDefault = value as string; });
    vi.mocked(configManager.updateConfig).mockImplementation(async (_path, update) => { savedDefault = update(savedDefault) as string; return savedDefault; });
    await renderSelector(CATALOG_MODELS, 'umbra-main', 'session-a');
    await openMenu(); await openProvider('provider-acme');
    await act(async () => modelOption('acme-deep')!.click());
    expect(savedDefault).toBe('acme-deep');
    await chooseSaveScope('session');
    expect(savedDefault).toBe('umbra-main');
    expect(flowChatStoreMocks.sessions.get('session-a')?.config.modelName).toBe('acme-deep');
  });

  it('dismisses the nested scope menu with Escape while retaining the model picker', async () => {
    await renderSelector(CATALOG_MODELS, 'primary', 'session-a');
    await openSettingsMenu();
    await openAdvanced();
    const scopeButton = document.body.querySelector<HTMLButtonElement>('[data-testid="model-selection-scope"]')!;
    await act(async () => scopeButton.click());
    expect(scopeButton.getAttribute('aria-expanded')).toBe('true');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(scopeButton.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(scopeButton);
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens billing over the picker and returns without changing a model', async () => {
    await renderSelector(); await openSettingsMenu();
    const button = (label: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === label)!;
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="model-billing-toggle"]')!.click());
    await act(async () => button('billing.edit').click());
    expect(document.body.querySelector('[data-testid="model-billing-editor"]')).not.toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.body.querySelector('[data-testid="model-billing-editor"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
  });

  it('closes the model panel and restores focus to its composer trigger', async () => {
    await renderSelector(); await openSettingsMenu();
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="modelSelector.close"]')!.click());
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
  });

  it('preserves a committed session selection when remembering the default fails', async () => {
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'umbra-main' } });
    vi.mocked(configManager.setConfig).mockRejectedValueOnce(new Error('default save failed'));
    await renderSelector(CATALOG_MODELS, 'umbra-main', 'session-a');
    await openMenu();
    await openProvider('provider-acme');
    await act(async () => modelOption('acme-deep')!.click());
    expect(flowChatStoreMocks.sessions.get('session-a')?.config.modelName).toBe('acme-deep');
    expect(notificationStore.getState().activeNotifications.some(item => item.message === 'modelSelector.defaultSaveFailed')).toBe(true);
    expect(optionsPanel()).toBeNull();
  });

  it('skips an identical model and preset', async () => {
    flowChatStoreMocks.sessions.set('session-a', { config: { modelName: 'acme-fast' } });
    await renderSelector(CATALOG_MODELS, 'acme-fast', 'session-a');
    await openMenu();
    await openProvider('provider-acme');
    await act(async () => modelOption('acme-fast')!.click());
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
    expect(configManager.setConfig).not.toHaveBeenCalled();
  });

  it('rolls back an unpinned selection and context limit when the session update fails', async () => {
    flowChatStoreMocks.sessions.set('session-a', { config: {} });
    vi.mocked(agentAPI.updateSessionModel).mockRejectedValueOnce(new Error('session write failed'));
    await renderSelector(CATALOG_MODELS, 'umbra-main', 'session-a');
    await openMenu();
    await openProvider('provider-acme');
    await act(async () => modelOption('acme-deep')!.click());
    expect(flowChatStoreMocks.store.updateSessionModelName).toHaveBeenLastCalledWith('session-a', undefined);
    expect(flowChatStoreMocks.store.updateSessionMaxContextTokens).toHaveBeenLastCalledWith('session-a', undefined);
    expect(configManager.setConfig).not.toHaveBeenCalled();
  });

  it('shows only the chosen provider\'s models and applies a selection', async () => {
    await renderSelector(CATALOG_MODELS, 'umbra-main');
    await openMenu();
    await openProvider('provider-acme');

    expect(document.body.querySelector('[data-testid="chat-model-selector-back"]')).toBeNull();
    expect(providerRows()).toHaveLength(0);
    expect(modelOption('acme-fast')).not.toBeNull();
    expect(modelOption('acme-deep')).not.toBeNull();
    expect(modelOption('umbra-main')).toBeNull();
    expect(sharedPanelItems()).not.toBeNull();
    expect(sharedPanelItems()?.contains(modelOption('acme-fast'))).toBe(true);
    expect(sharedPanelItems()?.contains(modelOption('acme-deep'))).toBe(true);
    // Model choices are concrete models owned by this provider.
    expect(modelOption('primary')).toBeNull();

    const card = document.body.querySelector('[data-testid="chat-model-selector-menu"]');
    let finishSave!: () => void;
    vi.mocked(configManager.setConfig).mockReturnValueOnce(new Promise<void>(resolve => { finishSave = resolve; }));
    await act(async () => {
      modelOption('acme-deep')?.click();
      await Promise.resolve();
    });
    expect(card?.getAttribute('data-open')).toBe('true');
    expect(optionsPanel()).not.toBeNull();
    await act(async () => { finishSave(); });

    expect(configManager.setConfig).toHaveBeenCalledWith(
      'ai.agent_model_defaults.mode',
      'acme-deep',
    );
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.querySelector('[data-testid="chat-model-selector-menu"]')).toBe(card);
    expect(optionsPanel()).toBeNull();
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]'));
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    )!.click());
    expect(modelOption('acme-deep')?.getAttribute('aria-checked')).toBe('true');
    expect(modelOption('umbra-main')).not.toBeNull();
  });

  it('keeps the selector visible and actionable when no model is configured', async () => {
    const onAvailabilityChange = vi.fn();
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': [],
      'ai.default_models': {},
      'ai.agent_model_defaults': { mode: 'primary' },
    });
    await act(async () => {
      root.render(
        <ModelSelector
          currentMode='Standard'
          onAvailabilityChange={onAvailabilityChange}
        />,
      );
      await Promise.resolve();
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-btn"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain('modelSelector.status.unconfigured');
    expect(onAvailabilityChange).toHaveBeenLastCalledWith({
      status: 'unconfigured',
      canSend: false,
    });

    await openMenu();
    expect(document.body.querySelector(
      '[data-testid="chat-model-selector-status"][data-model-status="unconfigured"]',
    )).not.toBeNull();
    expect(document.body.querySelector(
      '[data-testid="chat-model-selector-open-settings"]',
    )).not.toBeNull();
  });

  it('blocks sending with a missing pinned ID while keeping replacement models selectable', async () => {
    const onAvailabilityChange = vi.fn();
    flowChatStoreMocks.sessions.set('missing-model-session', {
      config: { agentType: 'Standard', modelName: 'removed-id' },
    });
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': CATALOG_MODELS,
      'ai.default_models': { primary: 'acme-fast' },
      'ai.agent_model_defaults': { mode: 'primary' },
    });
    await act(async () => {
      root.render(<ModelSelector currentMode="Standard" sessionId="missing-model-session"
        onAvailabilityChange={onAvailabilityChange} />);
      await Promise.resolve();
    });
    expect(onAvailabilityChange).toHaveBeenLastCalledWith({
      status: 'target-model-unavailable', canSend: false,
    });
    await openMenu();
    await openProvider('provider-acme');
    expect(modelOption('acme-fast')).not.toBeNull();
  });

  it('distinguishes configured models from enabled chat models', async () => {
    const onAvailabilityChange = vi.fn();
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': [{
        ...model('disabled-model', 'Disabled', 'provider-disabled', 'https://disabled.test/v1'),
        enabled: false,
      }],
      'ai.default_models': { primary: 'disabled-model' },
      'ai.agent_model_defaults': { mode: 'primary' },
    });
    await act(async () => {
      root.render(
        <ModelSelector
          currentMode='Standard'
          onAvailabilityChange={onAvailabilityChange}
        />,
      );
      await Promise.resolve();
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-btn"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain('modelSelector.status.noEnabledChatModel');
    expect(onAvailabilityChange).toHaveBeenLastCalledWith({
      status: 'no-enabled-chat-model',
      canSend: false,
    });
  });

  it('treats empty capabilities as the category default for legacy chat models', async () => {
    const onAvailabilityChange = vi.fn();
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': [{
      ...model('legacy-chat', 'Legacy', 'provider-legacy', 'https://legacy.test/v1'),
      category: 'general_chat',
      capabilities: [],
      }],
      'ai.default_models': { primary: 'legacy-chat' },
      'ai.agent_model_defaults': { mode: 'legacy-chat' },
    });

    await act(async () => {
      root.render(
        <ModelSelector
          currentMode='Standard'
          onAvailabilityChange={onAvailabilityChange}
        />,
      );
      await Promise.resolve();
    });
    expect(onAvailabilityChange).toHaveBeenLastCalledWith({
      status: 'ready',
      canSend: true,
    });

    await openMenu();
    expect(document.body.querySelectorAll('[data-testid="chat-model-selector-option"]')).toHaveLength(1);
    await openProvider('provider-legacy');
    expect(modelOption('legacy-chat')).not.toBeNull();
  });

  it('keeps model choices available when the optional catalog request fails', async () => {
    const onAvailabilityChange = vi.fn();
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': CATALOG_MODELS,
      'ai.default_models': { primary: 'acme-fast', fast: 'umbra-main' },
      'ai.agent_model_defaults': { mode: 'acme-fast' },
    });
    aiApiMocks.getModelCatalog.mockRejectedValueOnce(new Error('catalog unavailable'));

    await act(async () => {
      root.render(
        <ModelSelector
          currentMode='Standard'
          modeDefaultModelId="acme-fast"
          onAvailabilityChange={onAvailabilityChange}
        />,
      );
      await Promise.resolve();
    });

    expect(onAvailabilityChange).toHaveBeenLastCalledWith({
      status: 'catalog-unavailable',
      canSend: true,
    });
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')).not.toBeNull();

    await openMenu();
    expect(document.body.querySelectorAll('[data-testid="chat-model-selector-option"]')).toHaveLength(3);
  });

  it('refreshes the selector after the model configuration is saved', async () => {
    const onAvailabilityChange = vi.fn();
    const firstModel = model('first-model', 'First', 'provider-first', 'https://first.test/v1');
    const secondModel = model('second-model', 'Second', 'provider-second', 'https://second.test/v1');

    vi.mocked(configManager.getConfigs)
      .mockResolvedValueOnce({
        'ai.models': [firstModel],
        'ai.default_models': { primary: 'first-model' },
        'ai.agent_model_defaults': { mode: 'first-model' },
      })
      .mockResolvedValueOnce({
        'ai.models': [secondModel],
        'ai.default_models': { primary: 'second-model' },
        'ai.agent_model_defaults': { mode: 'second-model' },
      });

    await act(async () => {
      root.render(
        <ModelSelector
          currentMode='Standard'
          onAvailabilityChange={onAvailabilityChange}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.textContent)
      .toContain('first-model-native');

    const listeners = [...flowChatStoreMocks.configChangeListeners];
    expect(listeners).toHaveLength(3);
    await act(async () => {
      // ModelSettingsPage writes ai.models through ConfigManager's ai-scoped
      // mutation notification, so this is the post-save event to handle.
      listeners.forEach(listener => listener('ai'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="chat-model-selector-btn"]')?.textContent)
      .toContain('second-model-native');
    expect(onAvailabilityChange).toHaveBeenLastCalledWith({
      status: 'ready',
      canSend: true,
    });
  });

  it('keeps the current filtered list intact until the short exit finishes', async () => {
    await renderSelector();
    await openMenu();
    await openProvider('provider-acme');
    const surface = document.body.querySelector<HTMLElement>('[data-testid="chat-model-selector-menu"]')!;
    const closingOptions = optionsPanel();
    const selectedProviderModel = modelOption('acme-fast');
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')!;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(surface.getAttribute('data-open')).toBe('false');
    expect(surface.getAttribute('aria-hidden')).toBe('true');
    expect(surface.hasAttribute('inert')).toBe(true);
    expect(surface.getAttribute('data-menu-level')).toBe('models');
    expect(optionsPanel()).toBe(closingOptions);
    expect(modelOption('acme-fast')).toBe(selectedProviderModel);
    act(() => vi.advanceTimersByTime(99));
    expect(surface.isConnected).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(surface.isConnected).toBe(false);
  });

  it.each(['pointer', 'keyboard'])('cancels an exit and resets the summary when reopened by %s', async (input) => {
    await renderSelector();
    await openMenu();
    await openProvider('provider-acme');
    const surface = document.body.querySelector<HTMLElement>('[data-testid="chat-model-selector-menu"]')!;
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-model-selector-btn"]')!;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    act(() => vi.advanceTimersByTime(50));
    await act(async () => trigger.dispatchEvent(input === 'pointer'
      ? new MouseEvent('click', { bubbles: true, detail: 1 })
      : new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));

    expect(document.body.querySelector('[data-testid="chat-model-selector-menu"]')).toBe(surface);
    expect(surface.getAttribute('data-open')).toBe('true');
    expect(surface.getAttribute('data-menu-level')).toBe('settings');
    expect(surface.hasAttribute('inert')).toBe(false);
    expect(optionsPanel()).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings"]')).not.toBeNull();
    act(() => vi.advanceTimersByTime(100));
    expect(surface.isConnected).toBe(true);
  });

  it('replaces summary contents on click and returns within the same menu surface', async () => {
    flowChatStoreMocks.sessions.set('session-a', {
      config: { agentType: 'Standard', modelName: 'umbra-main', reasoningPreset: 'high' },
    });
    aiApiMocks.getModelCatalog.mockResolvedValue({
      version: 1,
      default_models: { primary: 'acme-fast' },
      models: [{
        id: 'umbra-main',
        reasoning: {
          status: 'known',
          default_preset: 'medium',
          presets: [
            { id: 'medium', label: 'Medium', order: 10, source: 'models_dev', actions: [{ type: 'effort', value: 'medium' }] },
            { id: 'high', label: 'High', order: 20, source: 'models_dev', actions: [{ type: 'effort', value: 'high' }] },
          ],
        },
      }],
    });

    await renderSelector(CATALOG_MODELS, 'primary', 'session-a');
    await openSettingsMenu();
    await openAdvanced();
    const modelRow = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    );
    const surface = document.body.querySelector('[data-testid="chat-model-selector-menu"]');
    await act(async () => {
      modelRow?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      modelRow?.focus();
    });
    expect(optionsPanel()).toBeNull();
    await act(async () => modelRow?.click());
    expect(optionsPanel()?.dataset.panelKind).toBe('models');
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-menu"]')).toBe(surface);
    expect(document.body.querySelectorAll('[role="menu"]')).toHaveLength(1);

    await act(async () => optionsPanel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    const reasoningRow = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-reasoning"]',
    )!;
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="chat-model-selector-settings-model"]'));
    await act(async () => reasoningRow.click());
    expect(optionsPanel()).toBeNull();
    expect(document.body.querySelector('[data-testid="chat-model-selector-menu"]')).toBe(surface);
    expect(document.body.querySelector('[data-testid="chat-model-selector-settings"]')).not.toBeNull();
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    })));
    expect(optionsPanel()).toBeNull();
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="chat-model-selector-settings-reasoning"]'));
  });

  it('supports Right and Left Arrow navigation and dismisses the card on outside click', async () => {
    flowChatStoreMocks.sessions.set('session-a', {
      config: { agentType: 'Standard', modelName: 'umbra-main', reasoningPreset: 'high' },
    });
    aiApiMocks.getModelCatalog.mockResolvedValue({
      version: 1,
      default_models: { primary: 'acme-fast' },
      models: [{
        id: 'umbra-main',
        reasoning: {
          status: 'known',
          default_preset: 'medium',
          presets: [
            { id: 'medium', label: 'Medium', order: 10, source: 'models_dev', actions: [{ type: 'effort', value: 'medium' }] },
            { id: 'high', label: 'High', order: 20, source: 'models_dev', actions: [{ type: 'effort', value: 'high' }] },
          ],
        },
      }],
    });
    await renderSelector(CATALOG_MODELS, 'primary', 'session-a');
    await openSettingsMenu();
    await openAdvanced();
    const modelRow = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    );
    modelRow?.focus();

    await act(async () => {
      modelRow?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await new Promise(resolve => window.setTimeout(resolve, 25));
    });
    expect(optionsPanel()?.dataset.panelKind).toBe('models');
    expect(optionsPanel()?.contains(document.activeElement)).toBe(true);

    await act(async () => {
      optionsPanel()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(optionsPanel()).toBeNull();
    const returnedModelRow = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector-settings-model"]',
    )!;
    expect(document.activeElement).toBe(returnedModelRow);

    await act(async () => returnedModelRow.click());
    const closingOptions = optionsPanel();
    expect(closingOptions).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(optionsPanel()).toBe(closingOptions);
    expect(document.body.querySelector(
      '[data-testid="chat-model-selector-menu"]',
    )?.getAttribute('data-open')).toBe('false');
  });

  it('keeps a config written before the provider-instance migration visible', async () => {
    // Upgraded installs can still hold models without the grouping metadata;
    // they must stay selectable as their own provider rather than disappear.
    await renderSelector([
      ...CATALOG_MODELS,
      model('legacy-model', 'Legacy endpoint', undefined, 'https://legacy.test/v1'),
    ]);
    await openMenu();

    await openProvider('legacy-model');
    expect(modelOption('legacy-model')).not.toBeNull();
  });
});
