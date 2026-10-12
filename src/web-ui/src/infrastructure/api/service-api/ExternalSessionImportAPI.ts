import { invokePrepared } from './invokePrepared';

export type ExternalSessionStatus = 'complete' | 'interrupted' | 'unsupported' | 'corrupt';
export type ExternalSessionWorkspaceMapping = 'exact' | 'user_selected' | 'missing_source_path' | 'unsupported';
export type ExternalSessionImportMode = 'full' | 'latest_compacted';

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

function normalizeCandidate(value: unknown): ExternalSessionCandidate {
  const item = value as Record<string, unknown>;
  if (!item || typeof item !== 'object' || typeof item.candidateId !== 'string'
    || typeof item.ecosystemId !== 'string' || typeof item.sourceSessionId !== 'string'
    || typeof item.fileSizeBytes !== 'number' || typeof item.status !== 'string'
    || typeof item.fingerprint !== 'string') {
    throw new Error('Invalid external session candidate response');
  }
  return {
    candidateId: item.candidateId,
    ecosystemId: item.ecosystemId,
    sourceSessionId: item.sourceSessionId,
    title: boundedString(item.title), cwd: boundedString(item.cwd),
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : undefined,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : undefined,
    modelProvider: boundedString(item.modelProvider, 256), modelName: boundedString(item.modelName, 256),
    turnCount: typeof item.turnCount === 'number' ? item.turnCount : undefined,
    fileSizeBytes: item.fileSizeBytes, formatVersion: boundedString(item.formatVersion, 256),
    status: item.status as ExternalSessionStatus, fingerprint: item.fingerprint,
    sourceLocation: boundedString(item.sourceLocation),
  };
}

function normalizeCatalog(value: unknown): ExternalSessionCatalog {
  const item = value as Record<string, unknown>;
  if (!item || typeof item !== 'object' || item.schemaVersion !== 1 || item.ecosystemId !== 'codex'
    || !Array.isArray(item.candidates)) throw new Error('Invalid external session catalog response');
  return {
    schemaVersion: 1,
    ecosystemId: 'codex',
    sourceRevision: typeof item.sourceRevision === 'string' ? item.sourceRevision : '',
    candidates: item.candidates.map(normalizeCandidate),
    diagnostics: Array.isArray(item.diagnostics) ? item.diagnostics as ExternalSessionImportWarning[] : [],
    nextCursor: typeof item.nextCursor === 'number' ? item.nextCursor : undefined,
  };
}

export const externalSessionImportAPI = {
  listCandidates(cursor = 0, limit = 50, query?: string): Promise<ExternalSessionCatalog> {
    return invokePrepared('list_external_session_import_candidates', async () => ({
      request: { cursor, limit, query: query?.trim() || undefined },
    })).then(normalizeCatalog);
  },

  plan(workspaceId: string, candidateId: string, mode: ExternalSessionImportMode): Promise<ExternalSessionImportPlan> {
    return invokePrepared('plan_external_session_import', async () => ({
      request: { workspaceId, candidateId, mode },
    }));
  },

  apply(request: {
    schemaVersion: number;
    planFingerprint: string;
    candidateId: string;
    targetWorkspaceId: string;
    agentId: string;
    sessionTitle?: string;
    includeToolHistory: boolean;
    includeThinking: boolean;
    mode: ExternalSessionImportMode;
  }): Promise<ExternalSessionImportApplied> {
    return invokePrepared('apply_external_session_import', async () => ({ request }));
  },
};
