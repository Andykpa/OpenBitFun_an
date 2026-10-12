import { useEffect, useState } from 'react';
import { Alert, Button, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogHeading, DialogTitle, LoadingState, OverflowText, StatusPill } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { WorkspaceKind } from '@/shared/types';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import { externalSessionImportAPI, type ExternalSessionCandidate, type ExternalSessionImportMode, type ExternalSessionImportPlan } from '@/infrastructure/api/service-api/ExternalSessionImportAPI';
import { EcosystemDialog as Dialog } from './EcosystemDialog';

interface Props {
  onCountChange?: (count: number) => void;
  refreshVersion?: number;
}

export default function ExternalAgentSessions({ onCountChange, refreshVersion = 0 }: Props) {
  const { t, formatDate, formatNumber } = useI18n('scenes/ecosystem-compatibility');
  const formatBytes = (value: number) => value < 1024
    ? `${formatNumber(value)} B`
    : value < 1024 * 1024
      ? `${formatNumber(Math.round(value / 1024))} KB`
      : `${formatNumber(Number((value / (1024 * 1024)).toFixed(1)))} MB`;
  const { workspace } = useCurrentWorkspace();
  const peer = usePeerDeviceModeOptional();
  const supported = isTauriRuntime() && !peer?.peerMode.active && workspace?.workspaceKind !== WorkspaceKind.Remote;
  const [candidates, setCandidates] = useState<ExternalSessionCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ExternalSessionCandidate | null>(null);
  const [plan, setPlan] = useState<ExternalSessionImportPlan | null>(null);
  const [mode, setMode] = useState<ExternalSessionImportMode>('latest_compacted');
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!supported) {
      setCandidates([]);
      onCountChange?.(0);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    void externalSessionImportAPI.listCandidates().then((catalog) => {
      if (!alive) return;
      setCandidates(catalog.candidates);
      onCountChange?.(catalog.candidates.length);
    }).catch(() => {
      if (!alive) return;
      setError(t('sessions.loadFailed'));
      onCountChange?.(0);
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [onCountChange, refreshVersion, supported, t]);

  const openPlan = (candidate: ExternalSessionCandidate, requestedMode = mode) => {
    if (!workspace?.id) return;
    setSelected(candidate);
    setPlan(null);
    setPlanning(true);
    void externalSessionImportAPI.plan(workspace.id, candidate.candidateId, requestedMode).then(setPlan)
      .catch(() => setError(t('sessions.planFailed')))
      .finally(() => setPlanning(false));
  };

  const apply = async () => {
    if (!plan || !workspace?.id || applying) return;
    setApplying(true);
    setError(null);
    try {
      const result = await externalSessionImportAPI.apply({
        schemaVersion: plan.schemaVersion,
        planFingerprint: plan.planFingerprint,
        candidateId: plan.candidate.candidateId,
        targetWorkspaceId: workspace.id,
        agentId: 'primary',
        sessionTitle: plan.candidate.title,
        includeToolHistory: true,
        includeThinking: false,
        mode,
      });
      await flowChatManager.refreshWorkspaceSessions({ id: workspace.id });
      setSelected(null);
      setPlan(null);
      await openMainSession(result.sessionId, { workspaceId: workspace.id });
    } catch {
      setError(t('sessions.importFailed'));
    } finally {
      setApplying(false);
    }
  };

  if (!supported) return <section className="ecosystem-compatibility__section" data-external-session-import="codex">
    <div className="ecosystem-compatibility__section-heading"><div><h2>{t('sessions.title')}</h2><p>{t('sessions.description')}</p></div></div>
    <Alert showIcon={false} message={t('sessions.unsupported')} />
  </section>;

  return <>
    <section className="ecosystem-compatibility__section" data-external-session-import="codex">
      <div className="ecosystem-compatibility__section-heading">
        <div><h2>{t('sessions.title')}</h2><p>{t('sessions.description')}</p></div>
      </div>
      {error ? <Alert className="ecosystem-compatibility__notice" role="status" showIcon={false} message={error} /> : null}
      {loading ? <LoadingState size="sm">{t('loading')}</LoadingState> : null}
      {!loading && candidates.length === 0 && !error ? <p className="ecosystem-compatibility__empty-state">{t('sessions.empty')}</p> : null}
      <div className="ecosystem-compatibility__content-overview" role="table" aria-label={t('sessions.title')}>
        {candidates.map((candidate) => <div key={candidate.candidateId} className="ecosystem-compatibility__content-summary" role="row">
          <span role="cell" className="ecosystem-compatibility__import-item">
            <span className="ecosystem-compatibility__import-item-copy">
              <strong className="ecosystem-compatibility__content-title"><OverflowText>{candidate.title || candidate.sourceSessionId}</OverflowText></strong>
              <small>{candidate.cwd || t('sessions.unknownWorkspace')} · {candidate.updatedAt ? formatDate(new Date(candidate.updatedAt), { dateStyle: 'short', timeStyle: 'short' }) : ''} · {formatBytes(candidate.fileSizeBytes)}</small>
            </span>
          </span>
          <span role="cell"><StatusPill tone="neutral">{candidate.turnCount ?? '—'} {t('sessions.turns')}</StatusPill></span>
          <span role="cell" className="ecosystem-compatibility__content-summary-state"><Button size="sm" variant="outline" onClick={() => openPlan(candidate)}>{t('sessions.import')}</Button></span>
        </div>)}
      </div>
    </section>
    <Dialog open={selected !== null} onOpenChange={(open) => { if (!open && !applying) { setSelected(null); setPlan(null); } }} size="xl" closeOnEscape={!applying} closeOnPointerOutside={!applying}>
      <DialogHeader><DialogHeading><DialogTitle>{t('sessions.reviewTitle')}</DialogTitle></DialogHeading>{!applying ? <DialogClose /> : null}</DialogHeader>
      <DialogBody className="ecosystem-compatibility__catalog-body">
        {selected ? <p>{selected.title || selected.sourceSessionId}</p> : null}
        <label>{t('sessions.mode')}
          <select value={mode} disabled={planning || applying} onChange={(event) => { const next = event.target.value as ExternalSessionImportMode; setMode(next); if (selected && workspace?.id) openPlan(selected, next); }}>
            <option value="latest_compacted">{t('sessions.latestCompacted')}</option>
            <option value="full">{t('sessions.fullHistory')}</option>
          </select>
        </label>
        {planning ? <LoadingState size="sm">{t('sessions.planning')}</LoadingState> : null}
        {plan ? <>
          <p>{t('sessions.previewSummary', { turns: formatNumber(plan.turns.length), size: formatBytes(plan.estimatedStorageBytes) })}</p>
          {plan.workspaceMapping === 'missing_source_path' ? <Alert showIcon={false} message={t('sessions.workspaceWarning')} /> : null}
          {plan.warnings.length > 0 ? <Alert showIcon={false} message={plan.warnings.map((warning) => warning.detail).join(' ')} /> : null}
          <div className="ecosystem-compatibility__content-overview">
            {plan.turns.slice(0, 20).map((turn) => <div key={turn.sourceTurnId} className="ecosystem-compatibility__content-summary"><span>{turn.turnIndex + 1}</span><OverflowText>{turn.userPreview}</OverflowText><small>{turn.toolCallCount} {t('sessions.tools')}</small></div>)}
          </div>
        </> : null}
      </DialogBody>
      <DialogFooter><Button variant="outline" disabled={applying} onClick={() => { setSelected(null); setPlan(null); }}>{t('sessions.cancel')}</Button><Button variant="primary" disabled={!plan || planning || applying} loading={applying} onClick={() => void apply()}>{t('sessions.importAndContinue')}</Button></DialogFooter>
    </Dialog>
  </>;
}
