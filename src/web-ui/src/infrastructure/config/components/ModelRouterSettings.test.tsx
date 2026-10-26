/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelRouterSettings } from './ModelRouterSettings';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { configManager } from '../services/ConfigManager';
import type { AIModelConfig, DefaultModelsConfig, ModelRoutingConfig } from '../types';

vi.mock('@/infrastructure/i18n', () => { const t = (key: string) => key; return { useI18n: () => ({ t }) }; });
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({ agentAPI: { getModelRoutingStatus: vi.fn() } }));
vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({ configAPI: { getConfig: vi.fn() } }));
vi.mock('../services/ConfigManager', () => ({ configManager: { getConfigs: vi.fn(), updateConfig: vi.fn() } }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('Router setup', () => {
  let root: Root;
  let container: HTMLDivElement;
  let host: ModelRoutingConfig & { futureField?: string };
  let defaults: DefaultModelsConfig;
  const onClose = vi.fn(); const onSaved = vi.fn();
  const button = (key: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === key)!;
  const models = ['main', 'economy', 'next'].map(id => ({ id, model_name: id, name: 'Provider', provider: 'openai',
    enabled: true, category: 'text', capabilities: ['text_chat'] })) as AIModelConfig[];
  const render = async () => { await act(async () => root.render(<ModelRouterSettings models={models} onClose={onClose} onSaved={onSaved} />)); };
  const changeEconomy = async () => {
    await act(async () => document.body.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="core.economy.label"]')!.click());
    await act(async () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))
      .find(option => option.textContent?.includes('next'))!.click());
  };
  beforeEach(() => {
    activateSurface('local'); vi.clearAllMocks();
    host = { default_mode: 'manual', router_model_id: null, tokenizer_path: '', simple_threshold: .75, timeout_ms: 10000, summary_enabled: false };
    defaults = { primary: 'main', economy: 'economy', fast: 'main' };
    vi.mocked(configManager.getConfigs).mockImplementation(async () => ({ 'ai.model_routing': { ...host }, 'ai.default_models': { ...defaults } }));
    vi.mocked(configAPI.getConfig).mockImplementation(async () => ({ ...host }));
    vi.mocked(configManager.updateConfig).mockImplementation(async (path, update) => {
      if (path === 'ai.default_models') { defaults = update(defaults) as DefaultModelsConfig; return defaults; }
      host = update(host) as typeof host; return host;
    });
    vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValue({ apiVersion: 1, mode: 'manual', defaultMode: 'manual', ready: false, connected: null, issue: 'Configure Router', summaryEnabled: false, estimatedTokenBudgetSupported: true });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it('preserves concurrently changed strategy and future fields without enabling routing', async () => {
    await render(); host.default_mode = 'smart'; host.futureField = 'preserve';
    host.subagent_model = 'economy'; defaults.fast = 'next';
    host.simple_threshold = .9; host.timeout_ms = 20000;
    expect(document.body.querySelector('[data-testid="model-billing-toggle"]')).toBeNull();
    expect(document.body.querySelector('[aria-label="router.threshold"]')).toBeNull();
    expect(document.body.querySelector('[aria-label="router.timeout"]')).toBeNull();
    expect(document.body.querySelector('[role="switch"]')).toBeNull();
    await act(async () => button('router.save').click());
    expect(host.summary_enabled).toBe(true);
    expect(host.default_mode).toBe('smart'); expect(host.futureField).toBe('preserve');
    expect(host.subagent_model).toBe('economy'); expect(defaults.fast).toBe('next');
    expect(host.simple_threshold).toBe(.9); expect(host.timeout_ms).toBe(20000);
    expect(configManager.updateConfig).toHaveBeenCalledTimes(1);
    expect(configManager.updateConfig).toHaveBeenCalledWith('ai.model_routing', expect.any(Function));
    expect(onClose).toHaveBeenCalledOnce(); expect(onSaved).toHaveBeenCalledOnce();
  });

  it('automatically enables summaries from legacy disabled settings without showing summary controls or notices', async () => {
    expect(host.summary_enabled).toBe(false);
    await render();
    expect(document.body.querySelector('[role="switch"]')).toBeNull();
    expect(document.body.textContent).not.toContain('router.summary');
    expect(document.body.textContent).not.toContain('router.summaryHint');
    expect(host.summary_enabled).toBe(false);
    await act(async () => button('router.save').click());
    expect(host.summary_enabled).toBe(true);
    expect(host.default_mode).toBe('manual');
    expect(defaults).toEqual({ primary: 'main', economy: 'economy', fast: 'main' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('configures smart model roles while preserving concurrent defaults and legacy subagent settings', async () => {
    await render();
    await changeEconomy();
    defaults.primary = 'next'; defaults.fast = 'economy'; host.subagent_model = 'primary';
    await act(async () => button('router.save').click());
    expect(defaults).toEqual({ primary: 'next', economy: 'next', fast: 'economy' });
    expect(host.subagent_model).toBe('primary'); expect(host.default_mode).toBe('manual');
    expect(configManager.updateConfig).toHaveBeenCalledWith('ai.default_models', expect.any(Function));
  });

  it('saves without a tokenizer field or path when the host explicitly supports estimated budgets', async () => {
    delete host.tokenizer_path;
    await render();
    expect(document.body.querySelector('[aria-label="router.tokenizer"]')).toBeNull();
    expect(document.body.textContent).not.toContain('router.tokenizerHint');
    await act(async () => button('router.save').click());
    expect(host).not.toHaveProperty('tokenizer_path');
    expect(configAPI.getConfig).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce(); expect(onSaved).toHaveBeenCalledOnce();
  });

  it.each(['', '/host/current-tokenizer.json', ' /host/legacy-tokenizer.json '])(
    'preserves the latest hidden tokenizer path verbatim: %j', async path => {
      host.tokenizer_path = '/host/initial-tokenizer.json';
      await render();
      host.tokenizer_path = path;
      await act(async () => button('router.save').click());
      expect(host.tokenizer_path).toBe(path);
      expect(onClose).toHaveBeenCalledOnce();
    },
  );

  it('allows an older host with a tokenizer path configured since the dialog opened', async () => {
    delete host.tokenizer_path;
    await render();
    host.tokenizer_path = ' /host/current-tokenizer.json ';
    vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValueOnce({ apiVersion: 1 } as Awaited<ReturnType<typeof agentAPI.getModelRoutingStatus>>);
    await act(async () => button('router.save').click());
    expect(configAPI.getConfig).toHaveBeenCalledWith('ai.model_routing');
    expect(host.tokenizer_path).toBe(' /host/current-tokenizer.json ');
    expect(onClose).toHaveBeenCalledOnce(); expect(onSaved).toHaveBeenCalledOnce();
  });

  it.each([
    { capability: undefined, path: undefined },
    { capability: undefined, path: '  ' },
    { capability: false, path: '' },
  ])('requires an upgrade before any role/config writes without estimated support: %j', async ({ capability, path }) => {
    host.tokenizer_path = '/host/initial-tokenizer.json';
    await render();
    await changeEconomy();
    host.tokenizer_path = path;
    vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValueOnce({
      apiVersion: 1, estimatedTokenBudgetSupported: capability,
    } as Awaited<ReturnType<typeof agentAPI.getModelRoutingStatus>>);
    await act(async () => button('router.save').click());
    expect(document.body.textContent).toContain('router.tokenBudgetUnsupported');
    expect(configManager.updateConfig).not.toHaveBeenCalled();
    expect(defaults.economy).toBe('economy');
    expect(onClose).not.toHaveBeenCalled(); expect(onSaved).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unreadable'])('shows an explicit error for %s current host configuration before writing roles', async failure => {
    host.tokenizer_path = '/host/initial-tokenizer.json';
    await render();
    await changeEconomy();
    vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValueOnce({ apiVersion: 1 } as Awaited<ReturnType<typeof agentAPI.getModelRoutingStatus>>);
    if (failure === 'missing') vi.mocked(configAPI.getConfig).mockResolvedValueOnce(undefined);
    else vi.mocked(configAPI.getConfig).mockRejectedValueOnce(new Error('Peer configuration unavailable'));
    await act(async () => button('router.save').click());
    expect(document.body.textContent).toContain('router.loadFailed');
    expect(document.body.textContent).not.toContain('Peer configuration unavailable');
    expect(configManager.updateConfig).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled(); expect(onSaved).not.toHaveBeenCalled();
  });

  it('rejects a legacy path removed between validation and the routing write', async () => {
    host.tokenizer_path = '/host/initial-tokenizer.json';
    await render();
    vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValueOnce({ apiVersion: 1 } as Awaited<ReturnType<typeof agentAPI.getModelRoutingStatus>>);
    vi.mocked(configManager.updateConfig).mockImplementationOnce(async (_path, update) => {
      delete host.tokenizer_path;
      host = update(host) as typeof host;
      return host;
    });
    await act(async () => button('router.save').click());
    expect(document.body.textContent).toContain('router.tokenBudgetUnsupported');
    expect(host).not.toHaveProperty('tokenizer_path');
    expect(host.default_mode).toBe('manual');
    expect(onClose).not.toHaveBeenCalled(); expect(onSaved).not.toHaveBeenCalled();
  });

  it('does not write after switching hosts during the legacy path check', async () => {
    await render();
    await changeEconomy();
    vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValueOnce({ apiVersion: 1 } as Awaited<ReturnType<typeof agentAPI.getModelRoutingStatus>>);
    let finish!: (value: ModelRoutingConfig) => void;
    vi.mocked(configAPI.getConfig).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await act(async () => button('router.save').click());
    await act(async () => activateSurface('peer-other'));
    await act(async () => finish({ ...host, tokenizer_path: '/peer/tokenizer.json' }));
    expect(configManager.updateConfig).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it.each(['incomplete', 'unreadable'])('leaves %s configuration disabled with a localized error', async failure => {
    if (failure === 'incomplete') vi.mocked(configManager.getConfigs).mockResolvedValueOnce({ 'ai.default_models': defaults });
    else vi.mocked(configManager.getConfigs).mockRejectedValueOnce(new Error('Failed to read config file'));
    await render();
    expect(button('router.save').disabled).toBe(true);
    expect(document.body.textContent).toContain('router.loadFailed');
    expect(document.body.textContent).not.toContain('Failed to read config file');
    expect(configManager.updateConfig).not.toHaveBeenCalled();
  });

  it('does not write after switching execution hosts during capability negotiation', async () => {
    await render();
    let finish!: (value: Awaited<ReturnType<typeof agentAPI.getModelRoutingStatus>>) => void;
    vi.mocked(agentAPI.getModelRoutingStatus).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await act(async () => button('router.save').click());
    await act(async () => activateSurface('peer-other'));
    await act(async () => finish({ apiVersion: 1 } as Awaited<ReturnType<typeof agentAPI.getModelRoutingStatus>>));
    expect(configManager.updateConfig).not.toHaveBeenCalled(); expect(onSaved).not.toHaveBeenCalled();
  });

  it('does not write configuration to an older host', async () => {
    await render(); vi.mocked(agentAPI.getModelRoutingStatus).mockRejectedValueOnce(new Error('unsupported host'));
    await act(async () => button('router.save').click());
    expect(configManager.updateConfig).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('router.loadFailed');
    expect(document.body.textContent).not.toContain('unsupported host');
  });

  it('shows an unsupported host response without writing configuration', async () => {
    await render();
    vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValueOnce({ apiVersion: 2 } as Awaited<ReturnType<typeof agentAPI.getModelRoutingStatus>>);
    await act(async () => button('router.save').click());
    expect(configManager.updateConfig).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('router.unsupported');
  });

  it.each([new Error('Failed to read config file'), 'Failed to read config file'])('localizes a save failure and keeps the draft available', async error => {
    await render();
    vi.mocked(configManager.updateConfig).mockRejectedValueOnce(error);
    await act(async () => button('router.save').click());
    expect(document.body.textContent).toContain('router.saveFailed');
    expect(document.body.textContent).not.toContain('Failed to read config file');
    expect(button('router.save').disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled(); expect(onSaved).not.toHaveBeenCalled();
    expect(host.default_mode).toBe('manual'); expect(defaults.economy).toBe('economy');
  });

  it('uses the explicit protocol probe result instead of treating a saved config as connected', async () => {
    await render();
    await act(async () => button('router.test').click());
    expect(agentAPI.getModelRoutingStatus).toHaveBeenLastCalledWith({ probe: true });
    expect(document.body.textContent).toContain('router.checkFailed');
    expect(document.body.textContent).not.toContain('Configure Router');
    expect(document.body.textContent).not.toContain('router.connected'); expect(onClose).not.toHaveBeenCalled();
  });

  it('localizes a rejected protocol check containing a tokenizer file error', async () => {
    await render();
    vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValueOnce({ apiVersion: 1, estimatedTokenBudgetSupported: true } as Awaited<ReturnType<typeof agentAPI.getModelRoutingStatus>>)
      .mockRejectedValueOnce(new Error('Failed to load Router tokenizer from /host/tokenizer.json'));
    await act(async () => button('router.test').click());
    expect(document.body.textContent).toContain('router.checkFailed');
    expect(document.body.textContent).not.toContain('Failed to load Router tokenizer');
    expect(onClose).not.toHaveBeenCalled();
  });
});
