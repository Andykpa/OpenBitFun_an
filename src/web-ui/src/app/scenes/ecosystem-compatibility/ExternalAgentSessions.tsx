import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Disclosure, Icon, LoadingState, OverflowText, Spinner, StatusPill } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { globalAPI } from '@/infrastructure/api/service-api/GlobalAPI';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import {
  externalSessionImportAPI,
  type ExternalSessionCandidate,
  type ExternalSessionWorkspaceGroup,
} from '@/infrastructure/api/service-api/ExternalSessionImportAPI';

interface Props {
  onCountChange?: (count: number) => void;
  onBusyChange?: (busy: boolean) => void;
  refreshVersion?: number;
}

interface ImportProgress {
  groupKey: string;
  candidateId?: string;
  completed: number;
  phase: 'preparing' | 'importing' | 'scanning';
  cancelling: boolean;
}

interface ImportRun {
  cancelled: boolean;
  operationId?: string;
  isCurrent: () => boolean;
}

function importErrorKey(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/no readable replacement|no usable human conversation/i.test(message)) return 'sessions.errors.noHistory';
  if (/malformed jsonl/i.test(message)) return 'sessions.errors.corrupt';
  if (/limit|budget/i.test(message)) return 'sessions.errors.tooLarge';
  if (/removed or moved/i.test(message)) return 'sessions.errors.sourceMissing';
  if (/workspace/i.test(message)) return 'sessions.errors.workspaceUnavailable';
  return 'sessions.importFailed';
}

function catalogErrorKey(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && error.code === 'workspace_pagination_unsupported'
    ? 'sessions.workspacePaginationUnsupported' : 'sessions.loadFailed';
}

// Navigation belongs to the device surface. Changing workspace may unmount the
// originating view, which must not cancel the requested session activation.
async function enterImportedSession(candidate: ExternalSessionCandidate, isCurrent: () => boolean) {
  const workspaceId = candidate.targetWorkspaceId!;
  const sessionId = candidate.importedSessionId!;
  const state = workspaceManager.getState();
  const known = state.openedWorkspaces.get(workspaceId)
    ?? state.recentWorkspaces.find((workspace) => workspace.id === workspaceId);
  if (known) {
    await workspaceManager.switchWorkspace(known);
  } else {
    await globalAPI.openWorkspaceById(workspaceId);
    if (!isCurrent()) return;
    await workspaceManager.setActiveWorkspace(workspaceId);
  }
  if (!isCurrent()) return;
  await flowChatManager.refreshWorkspaceSessions({ id: workspaceId });
  if (!isCurrent()) return;
  const available = await flowChatStore.ensurePersistedSessionMetadata(sessionId, workspaceId);
  if (!isCurrent()) return;
  if (!available) throw new Error('Imported session is unavailable');
  await openMainSession(sessionId, { workspaceId, isCurrent });
}

export default function ExternalAgentSessions({ onCountChange, onBusyChange, refreshVersion = 0 }: Props) {
  const { t, formatDate, formatNumber } = useI18n('scenes/ecosystem-compatibility');
  const peer = usePeerDeviceModeOptional();
  const supported = isTauriRuntime() && !peer?.peerMode.active;
  const [groups, setGroups] = useState<ExternalSessionWorkspaceGroup[]>([]);
  const [nextCursor, setNextCursor] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [loadingGroupKey, setLoadingGroupKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [cancelledKeys, setCancelledKeys] = useState<Set<string>>(new Set());
  const [completedGroups, setCompletedGroups] = useState<Set<string>>(new Set());
  const alive = useRef(false);
  const listRequest = useRef(0);
  const busyRef = useRef(false);
  const activeRun = useRef<ImportRun | null>(null);
  const activeLoad = useRef<{ cancelled: boolean } | null>(null);
  const imported = useRef(new Map<string, ExternalSessionCandidate>());

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    const request = ++listRequest.current;
    setLoading(supported);
    setListError(null);
    if (activeLoad.current) {
      activeLoad.current.cancelled = true;
      activeLoad.current = null;
      busyRef.current = false;
      setLoadingGroupKey(null);
    }
    if (!supported) {
      setGroups([]);
      setNextCursor(undefined);
      return;
    }
    void externalSessionImportAPI.listWorkspaces().then((catalog) => {
      if (request !== listRequest.current) return;
      imported.current.clear();
      setCompletedGroups(new Set());
      setErrors({});
      setCancelledKeys(new Set());
      setGroups(catalog.workspaces);
      setNextCursor(catalog.nextCursor);
    }).catch((error) => {
      if (request === listRequest.current) setListError(catalogErrorKey(error));
    }).finally(() => {
      if (request === listRequest.current) setLoading(false);
    });
    return () => { listRequest.current += 1; };
  }, [revision, refreshVersion, supported]);

  const sessionCount = groups.reduce((count, group) => count + group.totalCount, 0);
  useEffect(() => { onCountChange?.(sessionCount); }, [sessionCount, onCountChange]);
  const busy = progress !== null || openingId !== null || loadingGroupKey !== null;
  useEffect(() => { onBusyChange?.(busy || loading); }, [busy, loading, onBusyChange]);
  useEffect(() => () => { onBusyChange?.(false); }, [onBusyChange]);

  const loadMore = async () => {
    if (nextCursor === undefined || loading || busyRef.current) return;
    const request = ++listRequest.current;
    setLoading(true);
    setListError(null);
    try {
      const catalog = await externalSessionImportAPI.listWorkspaces(nextCursor);
      if (request !== listRequest.current) return;
      setGroups((previous) => {
        const displayed = new Set(previous.map((group) => group.workspaceKey));
        return [...previous, ...catalog.workspaces.filter((group) => !displayed.has(group.workspaceKey))];
      });
      setNextCursor(catalog.nextCursor);
    } catch (error) {
      if (request === listRequest.current) setListError(catalogErrorKey(error));
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  };

  const loadAllSessions = async (group: ExternalSessionWorkspaceGroup) => {
    if (group.nextCursor === undefined || loading || busyRef.current || !supported) return;
    const scope = getActiveSurfaceScope();
    const run = { cancelled: false };
    const isCurrent = () => alive.current && scope.isCurrent() && activeLoad.current === run && !run.cancelled;
    activeLoad.current = run;
    busyRef.current = true;
    setLoadingGroupKey(group.workspaceKey);
    const actionKey = 'load:' + group.workspaceKey;
    setErrors((previous) => ({ ...previous, [actionKey]: '' }));
    setCancelledKeys((previous) => { const next = new Set(previous); next.delete(actionKey); return next; });
    try {
      let cursor: number | undefined = group.nextCursor;
      while (cursor !== undefined && isCurrent()) {
        const page = await externalSessionImportAPI.listWorkspaceSessions(group.workspaceKey, cursor);
        if (!isCurrent()) return;
        setGroups((previous) => previous.map((current) => {
          if (current.workspaceKey !== group.workspaceKey) return current;
          const candidates = Array.from(new Map([...current.candidates, ...page.candidates]
            .map((candidate) => [candidate.candidateId, imported.current.get(candidate.candidateId) ?? candidate])).values());
          return { ...current, candidates, totalCount: Math.max(page.totalCount, candidates.length), nextCursor: page.nextCursor };
        }));
        cursor = page.nextCursor;
      }
    } catch {
      if (isCurrent()) setErrors((previous) => ({ ...previous, [actionKey]: 'sessions.loadWorkspaceFailed' }));
    } finally {
      if (activeLoad.current === run) {
        activeLoad.current = null;
        busyRef.current = false;
        if (alive.current) setLoadingGroupKey(null);
      }
    }
  };

  const cancelLoadAll = () => {
    if (!activeLoad.current || !loadingGroupKey) return;
    activeLoad.current.cancelled = true;
    activeLoad.current = null;
    busyRef.current = false;
    setCancelledKeys((previous) => new Set(previous).add('load:' + loadingGroupKey));
    setLoadingGroupKey(null);
  };

  const updateImported = (candidate: ExternalSessionCandidate, groupKey: string) => {
    imported.current.set(candidate.candidateId, candidate);
    setGroups((previous) => previous.map((group) => group.workspaceKey === groupKey ? {
      ...group,
      candidates: group.candidates.map((item) => item.candidateId === candidate.candidateId ? candidate
        : { ...item, targetWorkspaceId: candidate.targetWorkspaceId, targetWorkspaceName: candidate.targetWorkspaceName }),
    } : group));
  };

  const runImport = async (groupKey: string, single?: ExternalSessionCandidate) => {
    if (busyRef.current || loading || !supported) return;
    const scope = getActiveSurfaceScope();
    const run: ImportRun = { cancelled: false, isCurrent: () => alive.current && scope.isCurrent() };
    activeRun.current = run;
    busyRef.current = true;
    const actionKey = single?.candidateId ?? groupKey;
    const group = groups.find((item) => item.workspaceKey === groupKey);
    const initial = single ? [single] : group?.candidates ?? [];
    const seen = new Set<string>();
    let completed = 0;
    let failures = 0;
    setErrors((previous) => ({ ...previous, [actionKey]: '' }));
    setCancelledKeys((previous) => { const next = new Set(previous); next.delete(actionKey); return next; });
    setProgress({ groupKey, candidateId: single?.candidateId, completed, phase: 'preparing', cancelling: false });

    const processPage = async (page: ExternalSessionCandidate[]) => {
      for (const source of page) {
        if (run.cancelled || !run.isCurrent()) return;
        if (seen.has(source.candidateId)) continue;
        seen.add(source.candidateId);
        const candidate = imported.current.get(source.candidateId) ?? source;
        if (candidate.importedSessionId) continue;
        run.operationId = crypto.randomUUID();
        setProgress((current) => current && { ...current, phase: 'preparing' });
        try {
          const plan = await externalSessionImportAPI.plan(candidate.candidateId, run.operationId);
          if (run.cancelled || !run.isCurrent()) return;
          if (plan.turns.length === 0) throw new Error('No usable human conversation was found');
          setProgress((current) => current && { ...current, phase: 'importing' });
          const result = await externalSessionImportAPI.apply({
            operationId: run.operationId,
            schemaVersion: plan.schemaVersion,
            planFingerprint: plan.planFingerprint,
            candidateId: plan.candidate.candidateId,
            targetWorkspaceId: plan.targetWorkspaceId,
            agentId: 'primary',
            sessionTitle: plan.candidate.title,
            includeToolHistory: true,
            includeThinking: false,
          });
          if (!run.isCurrent()) return;
          // A cancellation arriving after publication must still show the saved session.
          updateImported({ ...candidate, ...plan.candidate, targetWorkspaceId: plan.targetWorkspaceId, importedSessionId: result.sessionId }, groupKey);
          completed += 1;
          setProgress((current) => current && { ...current, completed });
        } catch (error) {
          if (!run.isCurrent() || run.cancelled) return;
          failures += 1;
          setErrors((previous) => ({ ...previous, [candidate.candidateId]: importErrorKey(error) }));
        } finally {
          if (scope.isCurrent() && run.operationId) {
            await externalSessionImportAPI.cancel(run.operationId).catch(() => undefined);
          }
          run.operationId = undefined;
        }
      }
    };

    try {
      await processPage(initial);
      let cursor = single ? undefined : group?.nextCursor;
      while (cursor !== undefined && !run.cancelled && run.isCurrent()) {
        setProgress((current) => current && { ...current, phase: 'scanning' });
        const page = await externalSessionImportAPI.listWorkspaceSessions(groupKey, cursor);
        if (run.cancelled || !run.isCurrent()) break;
        await processPage(page.candidates);
        cursor = page.nextCursor;
      }
      if (!run.isCurrent()) return;
      if (run.cancelled) {
        if (!single || completed === 0) setCancelledKeys((previous) => new Set(previous).add(actionKey));
      } else if (!single && failures === 0) {
        setCompletedGroups((previous) => new Set(previous).add(groupKey));
      } else if (!single && failures > 0) {
        setErrors((previous) => ({ ...previous, [groupKey]: t('sessions.batchPartial', { failed: formatNumber(failures) }) }));
      }
    } catch {
      if (run.isCurrent() && !run.cancelled) setErrors((previous) => ({ ...previous, [actionKey]: 'sessions.batchFailed' }));
    } finally {
      if (activeRun.current === run) {
        activeRun.current = null;
        busyRef.current = false;
        if (alive.current) setProgress(null);
      }
    }
  };

  const cancelImport = () => {
    const run = activeRun.current;
    if (!run || !run.isCurrent()) return;
    run.cancelled = true;
    setProgress((current) => current && { ...current, cancelling: true });
    if (run.operationId) {
      void externalSessionImportAPI.cancel(run.operationId).catch(() => {
        if (run.isCurrent()) {
          setProgress((current) => current && { ...current, cancelling: false });
          setErrors((previous) => ({ ...previous, [progress?.candidateId ?? progress?.groupKey ?? '']: 'sessions.cancelFailed' }));
        }
      });
    }
  };

  const openImported = async (candidate: ExternalSessionCandidate) => {
    if (!candidate.importedSessionId || !candidate.targetWorkspaceId || busyRef.current || !supported) return;
    const scope = getActiveSurfaceScope();
    busyRef.current = true;
    setOpeningId(candidate.candidateId);
    setErrors((previous) => ({ ...previous, [candidate.candidateId]: '' }));
    try {
      await enterImportedSession(candidate, () => scope.isCurrent());
    } catch {
      if (alive.current && scope.isCurrent()) setErrors((previous) => ({ ...previous, [candidate.candidateId]: 'sessions.openFailed' }));
    } finally {
      busyRef.current = false;
      if (alive.current) setOpeningId(null);
    }
  };

  const feedback = (key: string) => errors[key]
    ? <span className="ecosystem-compatibility__session-error" role="alert">{errors[key].startsWith('sessions.') ? t(errors[key]) : errors[key]}</span>
    : cancelledKeys.has(key) ? <span className="ecosystem-compatibility__session-status" role="status">{t('sessions.cancelled')}</span> : null;

  const progressActions = (batch: boolean) => <>
    <Button size="sm" variant="outline" aria-disabled="true" tabIndex={-1} leadingIcon={<Spinner size="xs" />} labelBehavior="static" aria-live="polite">
      {progress?.cancelling ? t('sessions.cancelling') : batch
        ? t('sessions.importProgress', { count: formatNumber(progress?.completed ?? 0) })
        : t(progress?.phase === 'preparing' ? 'sessions.preparing' : 'sessions.importing')}
    </Button>
    <Button size="sm" variant="text" disabled={progress?.cancelling} onClick={cancelImport}>{t('sessions.cancel')}</Button>
  </>;

  return <section className="ecosystem-compatibility__section" data-external-session-import="codex">
    <Disclosure summary={t('sessions.title')} unmountOnClose contentInnerClassName="ecosystem-compatibility__session-groups"
      renderHeader={(trigger) => <div className="ecosystem-compatibility__section-heading ecosystem-compatibility__session-heading">
        <h2><button {...trigger} className="ecosystem-compatibility__session-heading-trigger">
          <Icon name="chevron-right" size="sm" /><span>{t('sessions.title')}</span>
        </button></h2>
        <StatusPill tone="neutral">{t('sessions.workspaceCount', { count: formatNumber(groups.length) })}</StatusPill>
      </div>}>
      {!supported ? <Alert tone="info" message={t('sessions.unsupported')} /> : <>
        {listError ? <div className="ecosystem-compatibility__session-list-error" role="alert">
          <span>{t(listError)}</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => nextCursor === undefined ? setRevision((value) => value + 1) : void loadMore()}>{t('retry')}</Button>
        </div> : null}
        {!loading && groups.length === 0 && !listError ? <p>{t('sessions.empty')}</p> : null}
        {groups.map((group) => {
          const key = group.workspaceKey;
          const name = group.candidates.find((candidate) => candidate.targetWorkspaceName)?.targetWorkspaceName;
          const allImported = group.candidates.every((candidate) => candidate.importedSessionId)
            && (group.nextCursor === undefined || completedGroups.has(key));
          const importingGroup = progress?.groupKey === key && !progress.candidateId;
          const loadingGroup = loadingGroupKey === key;
          return <Disclosure key={key} summary={name || group.cwd || t('sessions.unknownWorkspace')} description={name ? group.cwd : undefined} unmountOnClose
            className="ecosystem-compatibility__session-group"
            actions={<div className="ecosystem-compatibility__session-group-actions">
              <StatusPill tone="neutral">{group.nextCursor === undefined
                ? t('sessions.loadedCount', { count: formatNumber(group.candidates.length) })
                : t('sessions.partialCount', { loaded: formatNumber(group.candidates.length), total: formatNumber(group.totalCount) })}</StatusPill>
              {feedback(key)}
              {importingGroup ? progressActions(true) : allImported
                ? <StatusPill tone="success">{t('sessions.allImported')}</StatusPill>
                : <Button size="sm" variant="outline" disabled={busy || loading} onClick={() => void runImport(key)}>{t('sessions.importAll')}</Button>}
            </div>}>
            <div className="ecosystem-compatibility__session-list">
              {group.candidates.map((candidate) => <div key={candidate.candidateId} className="ecosystem-compatibility__session-row">
                <div className="ecosystem-compatibility__session-copy">
                  <strong><OverflowText>{candidate.title || candidate.sourceSessionId}</OverflowText></strong>
                  {candidate.updatedAt ? <small>{formatDate(new Date(candidate.updatedAt), { dateStyle: 'short', timeStyle: 'short' })}</small> : null}
                  {feedback(candidate.candidateId)}
                </div>
                <div className="ecosystem-compatibility__session-group-actions">
                  {progress?.candidateId === candidate.candidateId ? progressActions(false) : candidate.importedSessionId
                    ? <><StatusPill tone="success">{t('sessions.imported')}</StatusPill><Button size="sm" variant="outline" disabled={busy} loading={openingId === candidate.candidateId} onClick={() => void openImported(candidate)}>{t('sessions.openImported')}</Button></>
                    : <Button size="sm" variant="outline" disabled={busy} onClick={() => void runImport(key, candidate)}>{t('sessions.import')}</Button>}
                </div>
              </div>)}
            </div>
            {group.nextCursor !== undefined ? <div className="ecosystem-compatibility__session-load-actions">
              {feedback('load:' + key)}
              {loadingGroup ? <>
                <Button size="sm" variant="outline" aria-disabled="true" tabIndex={-1} leadingIcon={<Spinner size="xs" />} labelBehavior="static" aria-live="polite">
                  {t('sessions.loadProgress', { loaded: formatNumber(group.candidates.length), total: formatNumber(group.totalCount) })}
                </Button>
                <Button size="sm" variant="text" onClick={cancelLoadAll}>{t('sessions.cancel')}</Button>
              </> : <Button size="sm" variant="outline" disabled={busy || loading} onClick={() => void loadAllSessions(group)}>{t('sessions.loadAll')}</Button>}
            </div> : null}
          </Disclosure>;
        })}
        {loading ? <LoadingState size="sm">{t('loading')}</LoadingState> : null}
        {nextCursor !== undefined ? <Button size="sm" variant="outline" disabled={loading || busy} onClick={() => void loadMore()}>{t('sessions.loadMore')}</Button> : null}
      </>}
    </Disclosure>
  </section>;
}
