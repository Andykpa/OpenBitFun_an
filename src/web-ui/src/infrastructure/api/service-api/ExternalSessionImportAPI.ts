import { invokePrepared } from './invokePrepared';
import { invokeExternalSourceCommand } from './ExternalSourcesAPI';

export type ExternalSessionStatus = 'complete' | 'interrupted' | 'unsupported' | 'corrupt';
export type ExternalSessionEcosystem = 'codex' | 'zcode';
export type ExternalSessionWorkspaceMapping = 'exact' | 'user_selected' | 'missing_source_path' | 'unsupported';
export interface ExternalSessionCandidate {
  candidateId: string;
  ecosystemId: string;
  sourceSessionId: string;
  title?: string;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  modelProvider?: string;
  modelName?: string;
  turnCount?: number;
  fileSizeBytes: number;
  formatVersion?: string;
  status: ExternalSessionStatus;
  fingerprint: string;
  sourceLocation?: string;
  targetWorkspaceId?: string;
  targetWorkspaceName?: string;
  importedSessionId?: string;
}

export interface ExternalSessionImportWarning {
  code: string;
  detail: string;
}

export interface ExternalSessionTurnPreview {
  sourceTurnId: string;
  turnIndex: number;
  userPreview: string;
  assistantPreview?: string;
  toolCallCount: number;
  sourceEventCount: number;
  status: ExternalSessionStatus;
  estimatedBytes: number;
}

export interface ExternalSessionImportPlan {
  schemaVersion: number;
  planFingerprint: string;
  candidate: ExternalSessionCandidate;
  targetWorkspaceId: string;
  workspaceMapping: ExternalSessionWorkspaceMapping;
  turns: ExternalSessionTurnPreview[];
  estimatedStorageBytes: number;
  warnings: ExternalSessionImportWarning[];
}

export interface ExternalSessionCatalog {
  schemaVersion: number;
  ecosystemId: string;
  sourceRevision: string;
  candidates: ExternalSessionCandidate[];
  diagnostics: ExternalSessionImportWarning[];
  nextCursor?: number;
  workspaces?: ExternalSessionWorkspaceGroup[];
}

export interface ExternalSessionWorkspaceGroup {
  workspaceKey: string;
  cwd?: string;
  totalCount: number;
  candidates: ExternalSessionCandidate[];
  nextCursor?: number;
}

export interface ExternalSessionWorkspaceCatalog extends ExternalSessionCatalog {
  workspaces: ExternalSessionWorkspaceGroup[];
}

export interface ExternalSessionImportApplied {
  schemaVersion: number;
  sessionId: string;
  importedTurnCount: number;
  warningCodes: string[];
  alreadyImported: boolean;
}

function boundedString(value: unknown, max = 4096): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

function normalizeCandidate(value: unknown, ecosystemId: ExternalSessionEcosystem): ExternalSessionCandidate {
  const item = value as Record<string, unknown>;
  if (!item || typeof item !== 'object' || typeof item.candidateId !== 'string'
    || item.ecosystemId !== ecosystemId || typeof item.sourceSessionId !== 'string'
    || typeof item.fileSizeBytes !== 'number' || typeof item.status !== 'string'
    || typeof item.fingerprint !== 'string') {
    throw new Error('Invalid external session candidate response');
  }
  return {
    candidateId: item.candidateId,
    ecosystemId,
    sourceSessionId: item.sourceSessionId,
    title: boundedString(item.title), cwd: boundedString(item.cwd),
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : undefined,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : undefined,
    modelProvider: boundedString(item.modelProvider, 256), modelName: boundedString(item.modelName, 256),
    turnCount: typeof item.turnCount === 'number' ? item.turnCount : undefined,
    fileSizeBytes: item.fileSizeBytes, formatVersion: boundedString(item.formatVersion, 256),
    status: item.status as ExternalSessionStatus, fingerprint: item.fingerprint,
    sourceLocation: boundedString(item.sourceLocation),
    targetWorkspaceId: boundedString(item.targetWorkspaceId, 256),
    targetWorkspaceName: boundedString(item.targetWorkspaceName, 512),
    importedSessionId: boundedString(item.importedSessionId, 256),
  };
}

function normalizeCatalog(value: unknown, ecosystemId: ExternalSessionEcosystem): ExternalSessionCatalog {
  const item = value as Record<string, unknown>;
  if (item && typeof item === 'object' && item.ecosystemId !== ecosystemId) {
    throw Object.assign(new Error('The host does not support session discovery for this ecosystem'), { code: 'ecosystem_import_unsupported' });
  }
  if (!item || typeof item !== 'object' || item.schemaVersion !== 1
    || !Array.isArray(item.candidates)) throw new Error('Invalid external session catalog response');
  return {
    schemaVersion: 1,
    ecosystemId,
    sourceRevision: typeof item.sourceRevision === 'string' ? item.sourceRevision : '',
    candidates: item.candidates.map((candidate) => normalizeCandidate(candidate, ecosystemId)),
    diagnostics: Array.isArray(item.diagnostics) ? item.diagnostics as ExternalSessionImportWarning[] : [],
    nextCursor: typeof item.nextCursor === 'number' ? item.nextCursor : undefined,
    workspaces: Array.isArray(item.workspaces) ? item.workspaces.map((group) => normalizeWorkspace(group, ecosystemId)) : undefined,
  };
}

function normalizeWorkspace(value: unknown, ecosystemId: ExternalSessionEcosystem): ExternalSessionWorkspaceGroup {
  const item = value as Record<string, unknown>;
  if (!item || typeof item !== 'object' || !boundedString(item.workspaceKey, 256)
    || !Number.isSafeInteger(item.totalCount) || (item.totalCount as number) < 0
    || !Array.isArray(item.candidates)
    || (item.nextCursor != null && (!Number.isSafeInteger(item.nextCursor) || (item.nextCursor as number) < 1))) {
    throw new Error('Invalid external session workspace response');
  }
  return {
    workspaceKey: item.workspaceKey as string,
    cwd: boundedString(item.cwd),
    totalCount: item.totalCount as number,
    candidates: item.candidates.map((candidate) => normalizeCandidate(candidate, ecosystemId)),
    nextCursor: typeof item.nextCursor === 'number' ? item.nextCursor : undefined,
  };
}

function normalizeWorkspaceCatalog(value: unknown, ecosystemId: ExternalSessionEcosystem): ExternalSessionWorkspaceCatalog {
  const catalog = normalizeCatalog(value, ecosystemId);
  if (!catalog.workspaces) {
    throw Object.assign(new Error('The host does not support workspace-scoped session discovery'), {
      code: 'workspace_pagination_unsupported',
    });
  }
  return { ...catalog, workspaces: catalog.workspaces };
}

// Keep the original Codex payload readable by hosts predating multi-source import.
function ecosystemRequest(ecosystemId: ExternalSessionEcosystem) {
  return ecosystemId === 'codex' ? {} : { ecosystemId };
}

export const externalSessionImportAPI = {
  listCandidates(cursor = 0, limit = 50, query?: string, ecosystemId: ExternalSessionEcosystem = 'codex'): Promise<ExternalSessionCatalog> {
    return invokePrepared('list_external_session_import_candidates', async () => ({
      request: { cursor, limit, query: query?.trim() || undefined, ...ecosystemRequest(ecosystemId) },
    })).then((value) => normalizeCatalog(value, ecosystemId));
  },

  listWorkspaces(cursor = 0, ecosystemId: ExternalSessionEcosystem = 'codex'): Promise<ExternalSessionWorkspaceCatalog> {
    return invokeExternalSourceCommand('list_external_session_import_candidates', {
      request: { cursor, limit: 5, scope: { kind: 'workspaces', previewLimit: 5 }, ...ecosystemRequest(ecosystemId) },
    }).then((value) => normalizeWorkspaceCatalog(value, ecosystemId));
  },

  async listWorkspaceSessions(workspaceKey: string, cursor: number, ecosystemId: ExternalSessionEcosystem = 'codex'): Promise<ExternalSessionWorkspaceGroup> {
    const catalog = normalizeWorkspaceCatalog(await invokeExternalSourceCommand('list_external_session_import_candidates', {
      request: { cursor, limit: 25, scope: { kind: 'workspace', workspaceKey }, ...ecosystemRequest(ecosystemId) },
    }), ecosystemId);
    if (catalog.workspaces.length !== 1 || catalog.workspaces[0].workspaceKey !== workspaceKey) {
      throw new Error('External session workspace response does not match the requested workspace');
    }
    const group = catalog.workspaces[0];
    if (group.nextCursor !== undefined && group.nextCursor <= cursor) {
      throw new Error('External session workspace cursor did not advance');
    }
    return group;
  },

  plan(candidateId: string, operationId?: string): Promise<ExternalSessionImportPlan> {
    return invokeExternalSourceCommand('plan_external_session_import', {
      request: { candidateId, operationId },
    });
  },

  apply(request: {
    operationId?: string;
    schemaVersion: number;
    planFingerprint: string;
    candidateId: string;
    targetWorkspaceId: string;
    agentId: string;
    sessionTitle?: string;
    includeToolHistory: boolean;
    includeThinking: boolean;
  }): Promise<ExternalSessionImportApplied> {
    return invokeExternalSourceCommand('apply_external_session_import', { request });
  },

  cancel(operationId: string): Promise<boolean> {
    return invokeExternalSourceCommand('cancel_external_session_import', { request: { operationId } });
  },
};
