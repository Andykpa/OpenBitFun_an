// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalSessionCandidate, ExternalSessionImportPlan, ExternalSessionWorkspaceGroup } from '@/infrastructure/api/service-api/ExternalSessionImportAPI';

const mocks = vi.hoisted(() => ({
  listWorkspaces: vi.fn(), listWorkspaceSessions: vi.fn(), plan: vi.fn(), apply: vi.fn(), cancel: vi.fn(), openMainSession: vi.fn(),
  openWorkspace: vi.fn(), setActiveWorkspace: vi.fn(), switchWorkspace: vi.fn(),
  refreshSessions: vi.fn(), ensureMetadata: vi.fn(), peer: false, epoch: 0,
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({
  t: (key: string, values?: Record<string, unknown>) => values ? key + ':' + JSON.stringify(values) : key,
  formatNumber: String, formatDate: () => 'date',
}) }));
vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: () => true }));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({
  usePeerDeviceModeOptional: () => ({ peerMode: { active: mocks.peer } }),
}));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({ getActiveSurfaceScope: () => {
  const epoch = mocks.epoch;
  return { isCurrent: () => epoch === mocks.epoch };
} }));
vi.mock('@/infrastructure/api/service-api/ExternalSessionImportAPI', () => ({ externalSessionImportAPI: mocks }));
vi.mock('@/infrastructure/api/service-api/GlobalAPI', () => ({ globalAPI: { openWorkspaceById: mocks.openWorkspace } }));
vi.mock('@/infrastructure/services/business/workspaceManager', () => ({ workspaceManager: {
  getState: () => ({ openedWorkspaces: new Map(), recentWorkspaces: [], activeWorkspaceId: 'unrelated-current' }),
  setActiveWorkspace: mocks.setActiveWorkspace, switchWorkspace: mocks.switchWorkspace,
} }));
vi.mock('@/flow_chat/services/FlowChatManager', () => ({ flowChatManager: { refreshWorkspaceSessions: mocks.refreshSessions } }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({ flowChatStore: { ensurePersistedSessionMetadata: mocks.ensureMetadata } }));
vi.mock('@/flow_chat/services/sessionActivation', () => ({ openMainSession: mocks.openMainSession }));
vi.mock('@openbitfun/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openbitfun/ui')>();
  const Wrapper = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return {
    ...actual,
    Alert: ({ message }: { message: React.ReactNode }) => <div role="alert">{message}</div>,
    Button: ({ children, disabled, onClick }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button disabled={disabled} onClick={onClick}>{children}</button>,
    LoadingState: Wrapper, OverflowText: Wrapper, StatusPill: Wrapper,
  };
});

import ExternalAgentSessions from './ExternalAgentSessions';

function candidate(id: string, cwd = 'C:/source', imported = false): ExternalSessionCandidate {
  return { candidateId: id, ecosystemId: 'codex', sourceSessionId: id, cwd, title: id,
    status: 'complete', fileSizeBytes: 200, fingerprint: id,
    ...(imported ? { targetWorkspaceId: 'source-workspace', importedSessionId: 'import-' + id } : {}),
  };
}

function plan(id: string): ExternalSessionImportPlan {
  return { schemaVersion: 1, planFingerprint: 'plan-' + id, candidate: { ...candidate(id), targetWorkspaceName: 'Source' },
    targetWorkspaceId: 'source-workspace', workspaceMapping: 'exact', estimatedStorageBytes: 200, warnings: [],
    turns: [{ sourceTurnId: 'turn-1', turnIndex: 0, userPreview: 'hello', assistantPreview: 'answer',
      toolCallCount: 0, sourceEventCount: 2, status: 'complete', estimatedBytes: 200 }],
  };
}

function workspace(candidates: ExternalSessionCandidate[], totalCount = candidates.length, nextCursor?: number, workspaceKey = 'source-key'): ExternalSessionWorkspaceGroup {
  return { workspaceKey, cwd: candidates[0]?.cwd, candidates, totalCount, nextCursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('Codex direct session import', () => {
  let root: Root;
  let container: HTMLDivElement;
  let unmounted: boolean;
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.peer = false;
    mocks.epoch = 0;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    unmounted = false;
    mocks.listWorkspaces.mockResolvedValue({ workspaces: [workspace([candidate('one')])] });
    mocks.plan.mockImplementation(async (id) => plan(id));
    mocks.apply.mockImplementation(async (request) => ({ sessionId: 'import-' + request.candidateId, alreadyImported: false }));
    mocks.cancel.mockResolvedValue(true);
    mocks.ensureMetadata.mockResolvedValue(true);
  });
  afterEach(async () => {
    if (!unmounted) await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function button(text: string, parent: ParentNode = container) {
    const result = Array.from(parent.querySelectorAll('button')).find((node) => node.textContent === text);
    expect(result, text).toBeDefined();
    return result!;
  }
  const groupTrigger = () => container.querySelector<HTMLButtonElement>('.ecosystem-compatibility__session-group > [data-openbitfun-part="header"] > button')!;
  async function renderAndExpand() {
    await act(async () => root.render(<ExternalAgentSessions />));
    expect(container.querySelector('h2')?.textContent).toBe('sessions.title');
    await act(async () => button('sessions.title').click());
  }
  async function expandFirstGroup() {
    expect(groupTrigger()).not.toBeNull();
    if (groupTrigger().getAttribute('aria-expanded') !== 'true') await act(async () => groupTrigger().click());
  }

  it('imports directly, preserves the expanded group, and opens the source session', async () => {
    await renderAndExpand();
    await expandFirstGroup();
    await act(async () => button('sessions.import').click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.plan).toHaveBeenCalledWith('one', expect.any(String));
    expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({
      targetWorkspaceId: 'source-workspace', includeToolHistory: true,
      operationId: mocks.plan.mock.calls[0][1],
    }));
    expect(mocks.apply.mock.calls[0][0]).not.toHaveProperty('mode');
    expect(mocks.setActiveWorkspace).not.toHaveBeenCalled();
    expect(groupTrigger().getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('sessions.allImported');
    await act(async () => button('sessions.openImported').click());
    expect(mocks.openWorkspace).toHaveBeenCalledWith('source-workspace');
    expect(mocks.setActiveWorkspace).toHaveBeenCalledWith('source-workspace');
    expect(mocks.ensureMetadata).toHaveBeenCalledWith('import-one', 'source-workspace');
    expect(mocks.openMainSession).toHaveBeenCalledWith('import-one', expect.objectContaining({ workspaceId: 'source-workspace' }));
  });

  it('finishes navigation if switching workspace unmounts the originating view', async () => {
    mocks.listWorkspaces.mockResolvedValue({ workspaces: [workspace([candidate('one', 'C:/source', true)])] });
    mocks.openWorkspace.mockImplementation(async () => {
      root.unmount();
      unmounted = true;
    });
    await renderAndExpand();
    await expandFirstGroup();
    await act(async () => button('sessions.openImported').click());
    expect(mocks.openMainSession).toHaveBeenCalledWith('import-one', expect.objectContaining({ workspaceId: 'source-workspace' }));
    expect(mocks.openMainSession.mock.calls[0][1].isCurrent()).toBe(true);
  });

  it('imports visible sessions before scanning further pages without expanding the rendered catalog', async () => {
    const nextPage = deferred<ExternalSessionWorkspaceGroup>();
    mocks.listWorkspaces.mockResolvedValue({ workspaces: [workspace([candidate('one')], 2, 1)], nextCursor: 1 });
    mocks.listWorkspaceSessions.mockReturnValue(nextPage.promise);
    await renderAndExpand();
    await expandFirstGroup();
    await act(async () => button('sessions.importAll').click());
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.listWorkspaceSessions).toHaveBeenCalledWith('source-key', 1);
    expect(mocks.apply.mock.invocationCallOrder[0]).toBeLessThan(mocks.listWorkspaceSessions.mock.invocationCallOrder[0]);
    await act(async () => nextPage.resolve(workspace([candidate('two')], 2)));
    expect(mocks.plan.mock.calls.map(([id]) => id)).toEqual(['one', 'two']);
    expect(container.querySelectorAll('.ecosystem-compatibility__session-row')).toHaveLength(1);
    expect(container.querySelectorAll('.ecosystem-compatibility__session-group')).toHaveLength(1);
    expect(button('sessions.loadMore')).toBeDefined();
    expect(container.textContent).toContain('sessions.allImported');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => button('sessions.loadAll').click());
    await expandFirstGroup();
    expect(container.querySelectorAll('.ecosystem-compatibility__session-row')).toHaveLength(2);
    expect(mocks.apply).toHaveBeenCalledTimes(2);
  });

  it('cancels a single import while preparing before it can be applied', async () => {
    const pending = deferred<ExternalSessionImportPlan>();
    mocks.plan.mockReturnValue(pending.promise);
    await renderAndExpand();
    await expandFirstGroup();
    await act(async () => button('sessions.import').click());
    expect(container.textContent).toContain('sessions.preparing');
    await act(async () => button('sessions.cancel').click());
    expect(mocks.cancel).toHaveBeenCalledWith(mocks.plan.mock.calls[0][1]);
    await act(async () => pending.resolve(plan('one')));
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(container.textContent).toContain('sessions.cancelled');
    expect(button('sessions.import').disabled).toBe(false);
  });

  it('cancels an active single-session write and leaves the item available to retry', async () => {
    const pending = deferred<unknown>();
    mocks.apply.mockReturnValue(pending.promise);
    await renderAndExpand();
    await expandFirstGroup();
    await act(async () => button('sessions.import').click());
    expect(container.textContent).toContain('sessions.importing');
    await act(async () => button('sessions.cancel').click());
    expect(mocks.cancel).toHaveBeenCalledWith(mocks.apply.mock.calls[0][0].operationId);
    await act(async () => pending.reject(new Error('Session import cancelled')));
    expect(container.textContent).toContain('sessions.cancelled');
    expect(button('sessions.import').disabled).toBe(false);
  });

  it('retains a completed session when cancellation arrives after publication', async () => {
    const pending = deferred<unknown>();
    mocks.apply.mockReturnValue(pending.promise);
    await renderAndExpand();
    await expandFirstGroup();
    await act(async () => button('sessions.import').click());
    await act(async () => button('sessions.cancel').click());
    await act(async () => pending.resolve({ sessionId: 'import-one', alreadyImported: false }));
    expect(button('sessions.openImported')).toBeDefined();
    expect(container.textContent).not.toContain('sessions.cancelled');
  });

  it('stops batch import on cancellation and retains successful items', async () => {
    const second = deferred<ExternalSessionImportPlan>();
    mocks.listWorkspaces.mockResolvedValue({ workspaces: [workspace([candidate('one'), candidate('two')], 3, 2)] });
    mocks.plan.mockImplementation(async (id) => id === 'two' ? second.promise : plan(id));
    await renderAndExpand();
    await expandFirstGroup();
    await act(async () => button('sessions.importAll').click());
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    await act(async () => button('sessions.cancel').click());
    await act(async () => second.resolve(plan('two')));
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.listWorkspaceSessions).not.toHaveBeenCalled();
    expect(button('sessions.openImported')).toBeDefined();
    expect(container.textContent).toContain('sessions.cancelled');
    expect(button('sessions.importAll').disabled).toBe(false);
  });

  it('skips already imported visible items and processes pending later pages', async () => {
    mocks.listWorkspaces.mockResolvedValue({ workspaces: [workspace([candidate('done', 'C:/source', true)], 2, 1)] });
    mocks.listWorkspaceSessions.mockResolvedValue(workspace([{ ...candidate('later'), targetWorkspaceId: 'source-workspace' }], 2));
    await renderAndExpand();
    await act(async () => button('sessions.importAll').click());
    expect(mocks.plan).toHaveBeenCalledWith('later', expect.any(String));
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('sessions.allImported');
  });

  it('never applies a stale plan to another device', async () => {
    const pending = deferred<ExternalSessionImportPlan>();
    mocks.plan.mockReturnValue(pending.promise);
    await renderAndExpand();
    await act(async () => button('sessions.importAll').click());
    mocks.epoch += 1;
    mocks.peer = true;
    await act(async () => {
      root.render(<ExternalAgentSessions />);
      pending.resolve(plan('one'));
    });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(container.textContent).toContain('sessions.unsupported');
  });

  it('reports navigation failure next to the imported session and allows retry', async () => {
    mocks.listWorkspaces.mockResolvedValue({ workspaces: [workspace([candidate('done', 'C:/source', true)])] });
    mocks.openWorkspace.mockRejectedValue(new Error('Directory missing'));
    await renderAndExpand();
    await expandFirstGroup();
    await act(async () => button('sessions.openImported').click());
    expect(container.textContent).toContain('sessions.openFailed');
    expect(button('sessions.openImported').disabled).toBe(false);
    expect(mocks.openMainSession).not.toHaveBeenCalled();
  });

  it('adds only new workspaces without appending sessions to existing groups', async () => {
    const first = workspace([candidate('one')], 3, 1);
    const second = workspace([candidate('other', 'D:/other')], 1, undefined, 'other-key');
    mocks.listWorkspaces.mockResolvedValueOnce({ workspaces: [first], nextCursor: 1 })
      .mockResolvedValueOnce({ workspaces: [workspace([candidate('one'), candidate('hidden')], 3, 2), second] });
    await renderAndExpand();
    await expandFirstGroup();
    const expandedGroup = container.querySelector('.ecosystem-compatibility__session-group');
    await act(async () => button('sessions.loadMore').click());
    expect(mocks.listWorkspaces).toHaveBeenLastCalledWith(1);
    expect(container.querySelectorAll('.ecosystem-compatibility__session-group')).toHaveLength(2);
    expect(container.querySelector('.ecosystem-compatibility__session-group')).toBe(expandedGroup);
    expect(expandedGroup?.querySelectorAll('.ecosystem-compatibility__session-row')).toHaveLength(1);
    expect(groupTrigger().getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).not.toContain('hidden');
    expect(mocks.listWorkspaceSessions).not.toHaveBeenCalled();
  });

  it('loads all sessions only within the selected workspace and hides the completed action', async () => {
    const firstPage = deferred<ExternalSessionWorkspaceGroup>();
    const lastPage = deferred<ExternalSessionWorkspaceGroup>();
    mocks.listWorkspaces.mockResolvedValue({ workspaces: [workspace([candidate('one')], 3, 1)], nextCursor: 1 });
    mocks.listWorkspaceSessions.mockReturnValueOnce(firstPage.promise).mockReturnValueOnce(lastPage.promise);
    await renderAndExpand();
    await expandFirstGroup();
    await act(async () => button('sessions.loadAll').click());
    expect(container.textContent).toContain('sessions.loadProgress:{"loaded":"1","total":"3"}');
    await act(async () => firstPage.resolve(workspace([candidate('two')], 3, 2)));
    expect(container.querySelectorAll('.ecosystem-compatibility__session-row')).toHaveLength(2);
    expect(container.textContent).toContain('sessions.loadProgress:{"loaded":"2","total":"3"}');
    expect(mocks.listWorkspaceSessions.mock.calls).toEqual([['source-key', 1], ['source-key', 2]]);
    await act(async () => lastPage.resolve(workspace([candidate('three')], 3)));
    expect(container.querySelectorAll('.ecosystem-compatibility__session-row')).toHaveLength(3);
    expect(container.querySelector('.ecosystem-compatibility__session-load-actions')).toBeNull();
    expect(button('sessions.loadMore').disabled).toBe(false);
    expect(mocks.listWorkspaces).toHaveBeenCalledTimes(1);
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it('cancels loading immediately, preserves completed pages and resumes at the remaining cursor', async () => {
    const cancelledPage = deferred<ExternalSessionWorkspaceGroup>();
    const resumedPage = deferred<ExternalSessionWorkspaceGroup>();
    mocks.listWorkspaces.mockResolvedValue({ workspaces: [workspace([candidate('one')], 3, 1)] });
    mocks.listWorkspaceSessions.mockResolvedValueOnce(workspace([candidate('two')], 3, 2))
      .mockReturnValueOnce(cancelledPage.promise).mockReturnValueOnce(resumedPage.promise);
    await renderAndExpand();
    await expandFirstGroup();
    await act(async () => button('sessions.loadAll').click());
    expect(container.querySelectorAll('.ecosystem-compatibility__session-row')).toHaveLength(2);
    await act(async () => button('sessions.cancel').click());
    expect(button('sessions.loadAll').disabled).toBe(false);
    expect(container.textContent).toContain('sessions.cancelled');
    await act(async () => button('sessions.loadAll').click());
    expect(mocks.listWorkspaceSessions.mock.calls).toEqual([['source-key', 1], ['source-key', 2], ['source-key', 2]]);
    await act(async () => cancelledPage.resolve(workspace([candidate('stale')], 3)));
    expect(container.textContent).not.toContain('stale');
    expect(container.textContent).toContain('sessions.loadProgress');
    await act(async () => resumedPage.resolve(workspace([candidate('three')], 3)));
    expect(container.querySelectorAll('.ecosystem-compatibility__session-row')).toHaveLength(3);
    expect(container.querySelector('.ecosystem-compatibility__session-load-actions')).toBeNull();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('retains loaded sessions and retries the failed workspace page', async () => {
    mocks.listWorkspaces.mockResolvedValue({ workspaces: [workspace([candidate('one')], 3, 1)] });
    mocks.listWorkspaceSessions.mockResolvedValueOnce(workspace([candidate('two')], 3, 2))
      .mockRejectedValueOnce(new Error('Read failed')).mockResolvedValueOnce(workspace([candidate('three')], 3));
    await renderAndExpand();
    await expandFirstGroup();
    await act(async () => button('sessions.loadAll').click());
    expect(container.querySelectorAll('.ecosystem-compatibility__session-row')).toHaveLength(2);
    expect(container.textContent).toContain('sessions.loadWorkspaceFailed');
    await act(async () => button('sessions.loadAll').click());
    expect(mocks.listWorkspaceSessions).toHaveBeenLastCalledWith('source-key', 2);
    expect(container.querySelectorAll('.ecosystem-compatibility__session-row')).toHaveLength(3);
    expect(container.textContent).not.toContain('sessions.loadWorkspaceFailed');
  });

  it('does not offer loading for a workspace whose complete session list is visible', async () => {
    await renderAndExpand();
    await expandFirstGroup();
    expect(container.querySelector('.ecosystem-compatibility__session-load-actions')).toBeNull();
  });

  it('ignores an in-flight workspace page after switching device surfaces', async () => {
    const pending = deferred<ExternalSessionWorkspaceGroup>();
    mocks.listWorkspaces.mockResolvedValue({ workspaces: [workspace([candidate('one')], 2, 1)] });
    mocks.listWorkspaceSessions.mockReturnValue(pending.promise);
    await renderAndExpand();
    await expandFirstGroup();
    await act(async () => button('sessions.loadAll').click());
    mocks.epoch += 1;
    mocks.peer = true;
    await act(async () => root.render(<ExternalAgentSessions />));
    await act(async () => pending.resolve(workspace([candidate('late')], 2)));
    expect(container.textContent).toContain('sessions.unsupported');
    expect(container.querySelectorAll('.ecosystem-compatibility__session-row')).toHaveLength(0);
    expect(mocks.listWorkspaceSessions).toHaveBeenCalledTimes(1);
  });
});
