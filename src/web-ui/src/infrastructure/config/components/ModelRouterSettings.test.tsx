/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelRouterSettings } from './ModelRouterSettings';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { aiApi, type ConnectionTestResult } from '@/infrastructure/api/service-api/AIApi';
import { configManager } from '../services/ConfigManager';
import type { AIModelConfig, DefaultModelsConfig, ModelRoutingConfig } from '../types';

vi.mock('@/infrastructure/i18n', () => { const t = (key: string) => key; return { useI18n: () => ({ t }) }; });
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({ agentAPI: { getModelRoutingStatus: vi.fn() } }));
vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({ configAPI: { getConfig: vi.fn() } }));
vi.mock('@/infrastructure/api/service-api/AIApi', () => ({ aiApi: { testAIConfigConnection: vi.fn() } }));
vi.mock('../services/ConfigManager', () => ({ configManager: { getConfigs: vi.fn(), updateConfig: vi.fn() } }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const connectionResult = (success: boolean): ConnectionTestResult => ({ success, response_time_ms: 12 });
const routingStatus = (connected: boolean | null) => ({
  apiVersion: 1, mode: 'manual', defaultMode: 'manual', ready: connected === true,
  connected, issue: connected === true ? null : 'Configure Router', summaryEnabled: true,
  estimatedTokenBudgetSupported: true,
});

describe('Router setup', () => {
  let root: Root;
  let container: HTMLDivElement;
  let unmounted: boolean;
  let host: ModelRoutingConfig & { futureField?: string };
  let defaults: DefaultModelsConfig;
  const onClose = vi.fn(); const onSaved = vi.fn();
  const button = (key: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === key)!;
  const models = ['main', 'economy', 'next'].map(id => ({ id, model_name: id, name: 'Provider', provider: 'openai',
    enabled: true, category: 'text', capabilities: ['text_chat'] })) as AIModelConfig[];
  const render = async (catalog = models) => { await act(async () => root.render(<ModelRouterSettings models={catalog} onClose={onClose} onSaved={onSaved} />)); };
  const changeRole = async (role: 'primary' | 'economy', value: string) => {
    await act(async () => document.body.querySelector<HTMLButtonElement>(`[role="combobox"][aria-label="core.${role}.label"]`)!.click());
    await act(async () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))
      .find(option => option.textContent?.includes(value))!.click());
  };
  const changeEconomy = () => changeRole('economy', 'next');
  const row = (role: 'primary' | 'economy' | 'router') => document.body.querySelector<HTMLElement>(`[data-model-routing-check="${role}"]`)!;
  const expectState = (role: 'primary' | 'economy' | 'router', state: string) => {
    expect(row(role)).not.toBeNull();
    expect(row(role).textContent).toContain(`router.connectionChecks.${state}`);
  };
  const check = async () => { await act(async () => button('router.test').click()); };
  beforeEach(() => {
    activateSurface('local'); vi.clearAllMocks();
    host = { default_mode: 'manual', router_model_id: 'next', tokenizer_path: '', simple_threshold: .75, timeout_ms: 10000, summary_enabled: false };
    defaults = { primary: 'main', economy: 'economy', fast: 'main' };
    vi.mocked(configManager.getConfigs).mockImplementation(async () => ({ 'ai.model_routing': { ...host }, 'ai.default_models': { ...defaults } }));
    vi.mocked(configAPI.getConfig).mockImplementation(async () => ({ ...host }));
    vi.mocked(configManager.updateConfig).mockImplementation(async (path, update) => {
      if (path === 'ai.default_models') { defaults = update(defaults) as DefaultModelsConfig; return defaults; }
      host = update(host) as typeof host; return host;
    });
    vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValue(routingStatus(true));
    vi.mocked(aiApi.testAIConfigConnection).mockReset().mockResolvedValue(connectionResult(true));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    unmounted = false;
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { if (!unmounted) await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

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
    vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValue(routingStatus(null));
    await check();
    expect(agentAPI.getModelRoutingStatus).toHaveBeenLastCalledWith({ probe: true });
    expectState('router', 'failed');
    expect(document.body.textContent).not.toContain('Configure Router');
    expect(document.body.textContent).not.toContain('router.connected'); expect(onClose).not.toHaveBeenCalled();
  });

  it('localizes a rejected protocol check containing a tokenizer file error', async () => {
    await render();
    vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValueOnce({ apiVersion: 1, estimatedTokenBudgetSupported: true } as Awaited<ReturnType<typeof agentAPI.getModelRoutingStatus>>)
      .mockRejectedValueOnce(new Error('Failed to load Router tokenizer from /host/tokenizer.json'));
    await act(async () => button('router.test').click());
    expectState('router', 'failed');
    expect(document.body.textContent).not.toContain('Failed to load Router tokenizer');
    expect(onClose).not.toHaveBeenCalled();
  });
  it('checks both selected execution models and the Router and displays three separate successes', async () => {
    await render();
    await check();
    expect(aiApi.testAIConfigConnection).toHaveBeenCalledTimes(2);
    expect(aiApi.testAIConfigConnection).toHaveBeenCalledWith(models[0]);
    expect(aiApi.testAIConfigConnection).toHaveBeenCalledWith(models[1]);
    expect(agentAPI.getModelRoutingStatus).toHaveBeenLastCalledWith({ probe: true });
    expect(row('primary').textContent).toContain('core.primary.label');
    expect(row('economy').textContent).toContain('core.economy.label');
    expect(row('router').textContent).toContain('router.connectionChecks.router');
    for (const role of ['primary', 'economy', 'router'] as const) expectState(role, 'connected');
    expect(onClose).not.toHaveBeenCalled();
    expect(button('router.test').disabled).toBe(false);
  });

  it('shows a returned primary-model failure without hiding successful economy and Router checks', async () => {
    vi.mocked(aiApi.testAIConfigConnection).mockImplementation(async config => config.id === 'main'
      ? { ...connectionResult(false), message_code: 'network_issue', error_details: 'secret provider response' }
      : connectionResult(true));
    await render();
    await check();
    expectState('primary', 'failed');
    expectState('economy', 'connected');
    expectState('router', 'connected');
    expect(row('primary').textContent).toContain('messages.connectionTestMessages.networkIssue');
    expect(document.body.textContent).not.toContain('secret provider response');
  });

  it('isolates rejected model tests and does not expose request configuration or raw errors', async () => {
    vi.mocked(aiApi.testAIConfigConnection).mockImplementation(async config => {
      if (config.id === 'economy') throw new Error('Provider rejected api_key=private-secret');
      return connectionResult(true);
    });
    await render();
    await check();
    expectState('primary', 'connected');
    expectState('economy', 'failed');
    expectState('router', 'connected');
    expect(document.body.textContent).not.toContain('private-secret');
  });

  it('updates each result as it settles rather than waiting for every service', async () => {
    const primary = deferred<ConnectionTestResult>();
    const economy = deferred<ConnectionTestResult>();
    const router = deferred<Awaited<ReturnType<typeof agentAPI.getModelRoutingStatus>>>();
    vi.mocked(aiApi.testAIConfigConnection).mockImplementation(config => config.id === 'main' ? primary.promise : economy.promise);
    vi.mocked(agentAPI.getModelRoutingStatus).mockImplementation(request => request?.probe ? router.promise : Promise.resolve(routingStatus(null)));
    await render();
    await check();
    expect(aiApi.testAIConfigConnection).toHaveBeenCalledTimes(2);
    expect(agentAPI.getModelRoutingStatus).toHaveBeenLastCalledWith({ probe: true });
    for (const role of ['primary', 'economy', 'router'] as const) expectState(role, 'checking');
    expect(button('router.test').disabled).toBe(true);
    expect(document.body.querySelector<HTMLButtonElement>('[aria-label="core.economy.label"]')!.disabled).toBe(true);
    await act(async () => primary.resolve(connectionResult(true)));
    expectState('primary', 'connected');
    expectState('economy', 'checking');
    expectState('router', 'checking');
    await act(async () => router.resolve(routingStatus(false)));
    expectState('router', 'failed');
    expectState('economy', 'checking');
    await act(async () => economy.resolve(connectionResult(false)));
    expectState('economy', 'failed');
    expect(button('router.test').disabled).toBe(false);
  });

  it.each([
    { label: 'missing', role: 'primary' as const, modelId: null, catalog: models },
    { label: 'deleted', role: 'economy' as const, modelId: 'deleted', catalog: models },
    { label: 'disabled', role: 'economy' as const, modelId: 'economy', catalog: models.map(model => model.id === 'economy' ? { ...model, enabled: false } : model) },
    { label: 'non-chat', role: 'primary' as const, modelId: 'main', catalog: models.map(model => model.id === 'main' ? { ...model, category: 'speech_recognition', capabilities: ['speech_recognition'] } as AIModelConfig : model) },
  ])('identifies a $label role selection while still checking the other services', async ({ role, modelId, catalog }) => {
    defaults[role] = modelId;
    await render(catalog);
    await check();
    expectState(role, 'unconfigured');
    expectState(role === 'primary' ? 'economy' : 'primary', 'connected');
    expectState('router', 'connected');
    expect(aiApi.testAIConfigConnection).toHaveBeenCalledTimes(1);
    expect(agentAPI.getModelRoutingStatus).toHaveBeenLastCalledWith({ probe: true });
  });

  it('shares a model connection request when both roles select the same concrete model', async () => {
    defaults.economy = 'main';
    await render();
    await check();
    expect(aiApi.testAIConfigConnection).toHaveBeenCalledOnce();
    expect(aiApi.testAIConfigConnection).toHaveBeenCalledWith(models[0]);
    expectState('primary', 'connected');
    expectState('economy', 'connected');
    expectState('router', 'connected');
  });

  it('clears completed results when a model role changes and tests the new selection', async () => {
    await render();
    await check();
    expectState('economy', 'connected');
    await changeEconomy();
    expect(document.body.querySelector('[data-model-routing-check]')).toBeNull();
    vi.mocked(aiApi.testAIConfigConnection).mockClear();
    await check();
    expect(aiApi.testAIConfigConnection).toHaveBeenCalledWith(models[2]);
    expect(aiApi.testAIConfigConnection).not.toHaveBeenCalledWith(models[1]);
    expectState('economy', 'connected');
  });

  it('replaces old results with checking states on retry and then shows the new outcomes', async () => {
    vi.mocked(aiApi.testAIConfigConnection).mockResolvedValue(connectionResult(false));
    vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValue(routingStatus(false));
    await render();
    await check();
    for (const role of ['primary', 'economy', 'router'] as const) expectState(role, 'failed');
    const next = deferred<ConnectionTestResult>();
    const router = deferred<Awaited<ReturnType<typeof agentAPI.getModelRoutingStatus>>>();
    vi.mocked(aiApi.testAIConfigConnection).mockReturnValue(next.promise);
    vi.mocked(agentAPI.getModelRoutingStatus).mockImplementation(request => request?.probe ? router.promise : Promise.resolve(routingStatus(null)));
    await check();
    for (const role of ['primary', 'economy', 'router'] as const) expectState(role, 'checking');
    await act(async () => { next.resolve(connectionResult(true)); router.resolve(routingStatus(true)); });
    for (const role of ['primary', 'economy', 'router'] as const) expectState(role, 'connected');
  });

  it('does not apply late service results after switching execution devices', async () => {
    const pending = deferred<ConnectionTestResult>();
    const router = deferred<Awaited<ReturnType<typeof agentAPI.getModelRoutingStatus>>>();
    vi.mocked(aiApi.testAIConfigConnection).mockReturnValue(pending.promise);
    vi.mocked(agentAPI.getModelRoutingStatus).mockImplementation(request => request?.probe ? router.promise : Promise.resolve(routingStatus(null)));
    await render();
    await check();
    await act(async () => activateSurface('peer-other'));
    const before = document.body.textContent;
    const savedCalls = onSaved.mock.calls.length;
    await act(async () => { pending.resolve(connectionResult(true)); router.resolve(routingStatus(true)); });
    expect(document.body.textContent).toBe(before);
    expect(onSaved).toHaveBeenCalledTimes(savedCalls);
    expect(aiApi.testAIConfigConnection).toHaveBeenCalledTimes(2);
  });

  it('allows closing during service checks and ignores their results after the dialog unmounts', async () => {
    const pending = deferred<ConnectionTestResult>();
    const router = deferred<Awaited<ReturnType<typeof agentAPI.getModelRoutingStatus>>>();
    vi.mocked(aiApi.testAIConfigConnection).mockReturnValue(pending.promise);
    vi.mocked(agentAPI.getModelRoutingStatus).mockImplementation(request => request?.probe ? router.promise : Promise.resolve(routingStatus(null)));
    await render();
    await check();
    for (const role of ['primary', 'economy', 'router'] as const) expectState(role, 'checking');
    const close = document.body.querySelector<HTMLButtonElement>('[role="dialog"] [data-openbitfun-part="close"]')!;
    expect(close.disabled).toBe(false);
    expect(button('router.test').disabled).toBe(true);
    await act(async () => close.click());
    expect(onClose).toHaveBeenCalledOnce();
    const savedCalls = onSaved.mock.calls.length;
    const writes = vi.mocked(configManager.updateConfig).mock.calls.length;
    const routerCalls = vi.mocked(agentAPI.getModelRoutingStatus).mock.calls.length;
    await act(async () => root.unmount()); unmounted = true;
    await act(async () => { pending.resolve(connectionResult(true)); router.resolve(routingStatus(true)); });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector('[data-model-routing-check]')).toBeNull();
    expect(onSaved).toHaveBeenCalledTimes(savedCalls);
    expect(onClose).toHaveBeenCalledOnce();
    expect(configManager.updateConfig).toHaveBeenCalledTimes(writes);
    expect(agentAPI.getModelRoutingStatus).toHaveBeenCalledTimes(routerCalls);
    expect(aiApi.testAIConfigConnection).toHaveBeenCalledTimes(2);
  });

  it('abandons capability negotiation on unmount before launching any service tests or writes', async () => {
    const support = deferred<Awaited<ReturnType<typeof agentAPI.getModelRoutingStatus>>>();
    vi.mocked(agentAPI.getModelRoutingStatus).mockReturnValue(support.promise);
    await render();
    await check();
    await act(async () => root.unmount()); unmounted = true;
    await act(async () => support.resolve(routingStatus(null)));
    expect(configManager.updateConfig).not.toHaveBeenCalled();
    expect(aiApi.testAIConfigConnection).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(agentAPI.getModelRoutingStatus).toHaveBeenCalledOnce();
  });

});
