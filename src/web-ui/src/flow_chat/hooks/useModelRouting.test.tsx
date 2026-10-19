/** @vitest-environment jsdom */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentAPI, type ModelRoutingStatus } from '@/infrastructure/api/service-api/AgentAPI';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { activateSurface, getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { useModelRouting } from './useModelRouting';

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({ agentAPI: { getModelRoutingStatus: vi.fn(), updateSessionModel: vi.fn() } }));
vi.mock('@/infrastructure/config/services/ConfigManager', () => ({ configManager: { setConfig: vi.fn(), updateConfig: vi.fn(), onConfigChange: vi.fn(() => () => {}) } }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('host-owned model routing', () => {
  let root: Root;
  let container: HTMLDivElement;
  let result: ReturnType<typeof useModelRouting>;
  let host: ModelRoutingStatus;
  const changed = vi.fn();
  const Harness = (props: Parameters<typeof useModelRouting>[0]) => { result = useModelRouting(props); return null; };
  const render = async (sessionId: string | undefined = 'session-a', allowed = true) => {
    const surface = getActiveSurfaceScope();
    const scopeKey = surface.key('routing-test', sessionId);
    await act(async () => root.render(<Harness identity={`${surface.epoch}:${scopeKey}`} epoch={surface.epoch} scopeKey={scopeKey}
      request={{ sessionId, workspacePath: '/remote/workspace' }} allowed={allowed} open modelName="custom-main"
      reasoningPreset="high" onModelChange={changed} />));
  };
  beforeEach(() => {
    activateSurface('local'); vi.clearAllMocks();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    host = { apiVersion: 1, mode: 'manual', defaultMode: 'manual', ready: true, issue: null, connected: null, summaryEnabled: false };
    vi.mocked(agentAPI.getModelRoutingStatus).mockImplementation(async () => ({ ...host }));
    vi.mocked(agentAPI.updateSessionModel).mockImplementation(async request => { host.mode = request.routingMode!; });
    vi.mocked(configManager.setConfig).mockImplementation(async (_path, value) => { host.defaultMode = value as string; });
    vi.mocked(configManager.updateConfig).mockImplementation(async (_path, update) => { host.defaultMode = update(host.defaultMode) as string; return host.defaultMode; });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it('sends the session strategy to its host and remembers it for new conversations', async () => {
    await render();
    await act(async () => { expect(await result!.select('smart')).toBe(true); });
    expect(agentAPI.updateSessionModel).toHaveBeenCalledWith({ sessionId: 'session-a', workspacePath: '/remote/workspace', modelName: 'primary', reasoningPreset: 'high', routingMode: 'smart' });
    expect(configManager.setConfig).toHaveBeenCalledWith('ai.model_routing.default_mode', 'smart');
    expect(result!.mode).toBe('smart'); expect(changed).toHaveBeenCalledWith('primary');
  });

  it('allows a temporary strategy without changing the host default', async () => {
    await render(); await act(async () => result!.changeScope('session'));
    await act(async () => { await result!.select('smart'); });
    expect(agentAPI.updateSessionModel).toHaveBeenCalledOnce();
    expect(configManager.setConfig).not.toHaveBeenCalled(); expect(host.defaultMode).toBe('manual');
  });

  it('keeps a draft-only strategy local and reads host readiness without a nonexistent session ID', async () => {
    const surface = getActiveSurfaceScope();
    const Draft = () => {
      const [mode, setMode] = useState<'manual' | 'smart'>();
      result = useModelRouting({ identity: 'draft', epoch: surface.epoch, scopeKey: 'draft',
        request: { sessionId: 'reserved', workspacePath: '/remote/workspace' },
        draft: { mode, onChange: setMode }, allowed: true, open: true, modelName: 'primary',
        onModelChange: changed });
      return null;
    };
    await act(async () => root.render(<Draft />));
    await act(async () => result.changeScope('session'));
    await act(async () => { expect(await result.select('smart')).toBe(true); });
    expect(result.mode).toBe('smart');
    expect(agentAPI.getModelRoutingStatus).toHaveBeenCalledWith({ workspacePath: '/remote/workspace' });
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled();
    expect(configManager.setConfig).not.toHaveBeenCalled();
    expect(host.defaultMode).toBe('manual');
  });

  it('restores the loaded default when changing a remembered edit to session-only', async () => {
    host.defaultMode = 'smart'; host.mode = 'smart';
    await render(); await act(async () => { await result!.select('manual'); });
    expect(host.defaultMode).toBe('manual');
    await act(async () => result!.changeScope('session'));
    expect(host.defaultMode).toBe('smart'); expect(host.mode).toBe('manual');
  });

  it('does not enable an unconfigured router or an unsupported host', async () => {
    host.ready = false;
    await render(); await act(async () => { expect(await result!.select('smart')).toBe(false); });
    expect(agentAPI.updateSessionModel).not.toHaveBeenCalled(); expect(configManager.setConfig).not.toHaveBeenCalled();
    vi.mocked(agentAPI.getModelRoutingStatus).mockRejectedValue(new Error('unknown command'));
    await render('session-b');
    expect(result!.status).toBeNull();
    await act(async () => { expect(await result!.select('smart')).toBe(false); });
  });

  it('does not persist a default when the session mutation fails', async () => {
    await render(); vi.mocked(agentAPI.updateSessionModel).mockRejectedValueOnce(new Error('offline'));
    await act(async () => { await expect(result!.select('smart')).rejects.toThrow('offline'); });
    expect(configManager.setConfig).not.toHaveBeenCalled(); expect(result!.mode).toBe('manual'); expect(result!.pending).toBe(false);
  });

  it('discards a late mutation after changing sessions', async () => {
    await render(); let finish!: () => void;
    vi.mocked(agentAPI.updateSessionModel).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(); }));
    let pending!: Promise<boolean>;
    await act(async () => { pending = result!.select('smart'); });
    await render('session-b');
    await act(async () => { finish(); expect(await pending).toBe(false); });
    expect(configManager.setConfig).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled(); expect(result!.pending).toBe(false);
  });

  it('does not leak a stale response across device activation', async () => {
    let finish!: (value: ModelRoutingStatus) => void;
    vi.mocked(agentAPI.getModelRoutingStatus).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render(); const previous = finish;
    activateSurface('peer');
    vi.mocked(agentAPI.getModelRoutingStatus).mockResolvedValue({ ...host, mode: 'manual' });
    await render(); await act(async () => { previous({ ...host, mode: 'smart' }); });
    expect(result!.mode).toBe('manual');
  });
});
