/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { useModelSelectionScope } from './useModelSelectionScope';

vi.mock('@/infrastructure/config/services/ConfigManager', () => ({ configManager: { setConfig: vi.fn(), updateConfig: vi.fn() } }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('model selection save scope', () => {
  let root: Root;
  let container: HTMLDivElement;
  let hostDefault: string;
  let result: ReturnType<typeof useModelSelectionScope>;
  const changed = vi.fn();
  const Harness = (props: Parameters<typeof useModelSelectionScope>[0]) => { result = useModelSelectionScope(props); return null; };
  const render = async ({ sessionId = 'session-a' as string | undefined, allowed = true, selected = 'fast', open = true } = {}) => {
    const surface = getActiveSurfaceScope();
    await act(async () => root.render(<Harness
      scopeKey={surface.key('model-selection-scope', sessionId)} epoch={surface.epoch}
      sessionId={sessionId} allowed={allowed} open={open} defaultModel={hostDefault} selectedModel={selected} onDefaultChange={changed}
    />));
  };
  beforeEach(() => {
    activateSurface('local'); vi.clearAllMocks();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    hostDefault = 'primary';
    vi.mocked(configManager.setConfig).mockImplementation(async (_path, value) => { hostDefault = value as string; });
    vi.mocked(configManager.updateConfig).mockImplementation(async (_path, update) => { hostDefault = update(hostDefault) as string; return hostDefault; });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it('remembers by default and saves the current choice when promoted from session-only', async () => {
    await render(); expect(result!.remember).toBe(true);
    await act(async () => result!.changeScope('session'));
    expect(hostDefault).toBe('primary'); expect(result!.remember).toBe(false);
    await act(async () => result!.changeScope('remember'));
    expect(hostDefault).toBe('fast'); expect(result!.scope).toBe('remember');
  });

  it('undoes only default edits from this opening when switching to session-only', async () => {
    await render();
    result!.markDefaultWrite('fast'); hostDefault = 'fast';
    await act(async () => result!.changeScope('session'));
    expect(hostDefault).toBe('primary'); expect(changed).toHaveBeenCalledWith('primary');
  });

  it('does not overwrite another editor’s newer default', async () => {
    await render(); result!.markDefaultWrite('fast'); hostDefault = 'other-editor';
    await act(async () => result!.changeScope('session'));
    expect(hostDefault).toBe('other-editor');
  });

  it('retains the temporary preference across remounts, isolating sessions and devices', async () => {
    await render(); await act(async () => result!.changeScope('session'));
    await act(async () => root.render(null));
    await render(); expect(result!.scope).toBe('session');
    await render({ sessionId: 'session-b' }); expect(result!.scope).toBe('remember');
    activateSurface('peer-host'); await render(); expect(result!.scope).toBe('remember');
    activateSurface('local'); await render(); expect(result!.scope).toBe('session');
  });

  it('does not advertise remembered defaults for delegated or externally owned selections', async () => {
    await render({ allowed: false });
    await act(async () => result!.changeScope('remember'));
    expect(result!.scope).toBe('session'); expect(configManager.setConfig).not.toHaveBeenCalled();
  });

  it('keeps the previous scope on save failure', async () => {
    await render(); result!.markDefaultWrite('fast'); hostDefault = 'fast';
    vi.mocked(configManager.updateConfig).mockRejectedValueOnce(new Error('offline'));
    await act(async () => { await expect(result!.changeScope('session')).rejects.toThrow('offline'); });
    expect(result!.scope).toBe('remember'); expect(result!.pending).toBe(false);
  });

  it('discards late completion after a device activation', async () => {
    await render(); result!.markDefaultWrite('fast');
    let finish!: (value: string) => void;
    vi.mocked(configManager.updateConfig).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let pending!: Promise<void>;
    await act(async () => { pending = result!.changeScope('session'); });
    activateSurface('peer-host'); await render();
    await act(async () => { finish('primary'); await pending; });
    expect(changed).not.toHaveBeenCalled(); expect(result!.scope).toBe('remember');
  });

  it('does not leave the original session busy when a save finishes on another session', async () => {
    await render(); result!.markDefaultWrite('fast');
    let finish!: (value: string) => void;
    vi.mocked(configManager.updateConfig).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let pending!: Promise<void>;
    await act(async () => { pending = result!.changeScope('session'); });
    await render({ sessionId: 'session-b' });
    await act(async () => { finish('primary'); await pending; });
    await render(); expect(result!.pending).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });
});
