import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./invokePrepared', () => ({ invokePrepared: mocks.invoke }));
vi.mock('./ExternalSourcesAPI', () => ({ invokeExternalSourceCommand: mocks.invoke }));
import { externalSessionImportAPI } from './ExternalSessionImportAPI';

function catalog(workspaces?: unknown[]) {
  return { schemaVersion: 1, ecosystemId: 'codex', sourceRevision: 'v1', candidates: [], diagnostics: [], nextCursor: null, workspaces };
}
function group(workspaceKey = 'source', nextCursor: number | null = null) {
  return { workspaceKey, cwd: '/source', totalCount: 7, candidates: [], nextCursor };
}

describe('external session workspace pagination', () => {
  beforeEach(() => mocks.invoke.mockReset());

  it('requests five recent workspaces with five session previews each', async () => {
    mocks.invoke.mockResolvedValue({ ...catalog([group()]), nextCursor: 10 });
    const result = await externalSessionImportAPI.listWorkspaces(5);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('list_external_session_import_candidates', {
      request: { cursor: 5, limit: 5, scope: { kind: 'workspaces', previewLimit: 5 } },
    });
    expect(result.nextCursor).toBe(10);
    expect(result.workspaces[0].nextCursor).toBeUndefined();
  });

  it('requests a page from only the selected source workspace', async () => {
    mocks.invoke.mockResolvedValue(catalog([group('source')]));
    await externalSessionImportAPI.listWorkspaceSessions('source', 5);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('list_external_session_import_candidates', {
      request: { cursor: 5, limit: 25, scope: { kind: 'workspace', workspaceKey: 'source' } },
    });
  });

  it('keeps the legacy flat catalog readable and refuses to treat it as grouped support', async () => {
    mocks.invoke.mockResolvedValue(catalog());
    expect((await externalSessionImportAPI.listCandidates()).candidates).toEqual([]);
    await expect(externalSessionImportAPI.listWorkspaces()).rejects.toMatchObject({ code: 'workspace_pagination_unsupported' });
  });

  it('rejects responses for another workspace and cursors that cannot progress', async () => {
    mocks.invoke.mockResolvedValueOnce(catalog([group('other')])).mockResolvedValueOnce(catalog([group('source', 5)]));
    await expect(externalSessionImportAPI.listWorkspaceSessions('source', 5)).rejects.toThrow('does not match');
    await expect(externalSessionImportAPI.listWorkspaceSessions('source', 5)).rejects.toThrow('did not advance');
  });
});
