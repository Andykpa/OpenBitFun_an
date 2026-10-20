/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelRouterSettings } from './ModelRouterSettings';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { configManager } from '../services/ConfigManager';
import type { ModelRoutingConfig } from '../types';

vi.mock('@/infrastructure/i18n', () => { const t = (key: string) => key; return { useI18n: () => ({ t }) }; });
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({ agentAPI: { getModelRoutingStatus: vi.fn() } }));
vi.mock('../services/ConfigManager', () => ({ configManager: { getConfig: vi.fn(), updateConfig: vi.fn() } }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('Router setup', () => {
  let root: Root;
  let container: HTMLDivElement;
  let host: ModelRoutingConfig & { futureField?: string };
  const onClose = vi.fn(); const onSaved = vi.fn();
  const button = (key: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === key)!;
  const render = async () => { await act(async () => root.render(<ModelRouterSettings models={[]} onClose={onClose} onSaved={onSaved} />)); };
  beforeEach(() => {
    activateSurface('local'); vi.clearAllMocks();
    host = { default_mode: 'manual', router_model_id: null, tokenizer_path: '', simple_threshold: .75, timeout_ms: 10000, summary_enabled: false };
    vi.mocked(configManager.getConfig).mockImplementation(async () => ({ ...host }));
    vi.mocked(configManager.updateConfig).mockImplementation(async (_path, update) => { host = update(host) as typeof host; return host; });
    vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValue({ apiVersion: 1, mode: 'manual', defaultMode: 'manual', ready: false, connected: null, issue: 'Configure Router', summaryEnabled: false });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it('preserves concurrently changed strategy and future fields without enabling routing', async () => {
    await render(); host.default_mode = 'smart'; host.futureField = 'preserve';
    await act(async () => button('router.save').click());
    expect(host.default_mode).toBe('smart'); expect(host.futureField).toBe('preserve');
    expect(configManager.updateConfig).toHaveBeenCalledWith('ai.model_routing', expect.any(Function));
    expect(onClose).toHaveBeenCalledOnce(); expect(onSaved).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'primary', 'economy', 'auto', 'future-policy'])('preserves the host subagent policy while saving Router details: %s', async policy => {
    await render();
    if (policy !== undefined) host.subagent_model = policy;
    await act(async () => button('router.save').click());
    expect(host.subagent_model).toBe(policy);
    if (policy === undefined) expect(Object.hasOwn(host, 'subagent_model')).toBe(false);
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('does not write configuration to an older host', async () => {
    await render(); vi.mocked(agentAPI.getModelRoutingStatus).mockRejectedValueOnce(new Error('unsupported host'));
    await act(async () => button('router.save').click());
    expect(configManager.updateConfig).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('unsupported host');
  });

  it('uses the explicit protocol probe result instead of treating a saved config as connected', async () => {
    await render();
    await act(async () => button('router.test').click());
    expect(agentAPI.getModelRoutingStatus).toHaveBeenLastCalledWith({ probe: true });
    expect(document.body.textContent).toContain('Configure Router');
    expect(document.body.textContent).not.toContain('router.connected'); expect(onClose).not.toHaveBeenCalled();
  });
});
