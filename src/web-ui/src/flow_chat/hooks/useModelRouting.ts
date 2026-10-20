import { useCallback, useEffect, useRef, useState } from 'react';
import { agentAPI, type ModelRoutingStatus, type ModelRoutingStatusRequest } from '@/infrastructure/api/service-api/AgentAPI';
import type { ModelRoutingMode, SmartSubagentModel } from '@/infrastructure/config/types';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { useModelSelectionScope, type ModelSelectionScope } from './useModelSelectionScope';

/** A host response is the authority for both strategy and feature support. */
export function useModelRouting({ identity, epoch, scopeKey, scope, request, allowed, readOnly = false, open, modelName, reasoningPreset, onModelChange, draft }: {
  scope?: ModelSelectionScope;
  draft?: { mode?: ModelRoutingMode; onChange: (mode: ModelRoutingMode) => void };
  identity: string; epoch: number; scopeKey: string; request: ModelRoutingStatusRequest;
  allowed: boolean; readOnly?: boolean; open: boolean; modelName: string; reasoningPreset?: string;
  onModelChange: (id: string) => void;
}) {
  const live = useRef(identity); live.current = identity;
  const sequence = useRef(0);
  const busy = useRef(false);
  const [snapshot, setSnapshot] = useState<{ identity: string; status: ModelRoutingStatus | null }>({ identity, status: null });
  const [pendingIdentity, setPendingIdentity] = useState<string | null>(null);
  const status = allowed && snapshot.identity === identity ? snapshot.status : null;
  const selectedMode = draft ? draft.mode ?? status?.defaultMode : request.sessionId ? status?.mode : status?.defaultMode;
  const mode: ModelRoutingMode = selectedMode === 'smart' ? 'smart' : 'manual';
  const requestKey = JSON.stringify(draft ? { ...request, sessionId: undefined } : request);
  const refresh = useCallback(async () => {
    const order = ++sequence.current;
    const surface = getActiveSurfaceScope();
    if (!allowed) return;
    try {
      const status = await agentAPI.getModelRoutingStatus(JSON.parse(requestKey));
      if (!surface.isCurrent() || live.current !== identity || order !== sequence.current) return;
      setSnapshot({ identity, status: status.apiVersion === 1 ? status : null });
    } catch {
      if (surface.isCurrent() && live.current === identity && order === sequence.current) setSnapshot({ identity, status: null });
    }
  }, [allowed, identity, requestKey]);
  useEffect(() => {
    void refresh();
    return configManager.onConfigChange(path => {
      if (!path || path === 'ai' || ['ai.models', 'ai.default_models', 'ai.model_routing'].some(owner => path === owner || path.startsWith(`${owner}.`))) void refresh();
    });
  }, [refresh]);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  const preference = useModelSelectionScope({
    scopeKey, epoch, sessionId: request.sessionId, allowed: allowed && !readOnly, open: open && status !== null,
    scopeOverride: scope,
    defaultPath: 'ai.model_routing.default_mode', skipUnchangedWrite: true, defaultModel: status?.defaultMode ?? 'manual', selectedModel: mode,
    onDefaultChange: value => setSnapshot(current => current.identity === identity && current.status
      ? { identity, status: { ...current.status, defaultMode: value } } : current),
  });
  const select = async (next: ModelRoutingMode) => {
    if (!allowed || readOnly || !status || busy.current || preference.pending || (next === 'smart' && !status.ready)) return false;
    if (next === mode && selectedMode === mode && (!draft || draft.mode !== undefined)) return true;
    const surface = getActiveSurfaceScope();
    busy.current = true; setPendingIdentity(identity);
    try {
      const selected = next === 'smart' ? 'primary' : modelName;
      if (request.sessionId) {
        if (draft) draft.onChange(next);
        else await agentAPI.updateSessionModel({ ...request, sessionId: request.sessionId,
            modelName: selected, reasoningPreset: reasoningPreset ?? null, routingMode: next });
        if (!surface.isCurrent() || live.current !== identity) return false;
        onModelChange(selected);
      }
      if (preference.remember) {
        preference.markDefaultWrite(next);
        await configManager.setConfig('ai.model_routing.default_mode', next);
      }
      if (!surface.isCurrent() || live.current !== identity) return false;
      await refresh();
      return true;
    } finally {
      busy.current = false;
      setPendingIdentity(current => current === identity ? null : current);
    }
  };
  const selectSubagentModel = async (next: SmartSubagentModel) => {
    if (!allowed || readOnly || typeof status?.subagentModel !== 'string' || busy.current || preference.pending
      || (next === 'auto' && status.subagentRoutingSupported !== true)) return false;
    const surface = getActiveSurfaceScope();
    if (surface.epoch !== epoch || live.current !== identity) return false;
    busy.current = true; setPendingIdentity(identity);
    try {
      // Negotiate before writing: older hosts accept unknown config keys but
      // cannot apply this policy. Never report that as a successful selection.
      const current = await agentAPI.getModelRoutingStatus(JSON.parse(requestKey));
      if (!surface.isCurrent() || live.current !== identity) return false;
      if (current.apiVersion !== 1 || typeof current.subagentModel !== 'string'
        || (next === 'auto' && current.subagentRoutingSupported !== true)) {
        setSnapshot({ identity, status: current.apiVersion === 1 ? current : null });
        return false;
      }
      if (current.subagentModel !== next) await configManager.setConfig('ai.model_routing.subagent_model', next);
      if (!surface.isCurrent() || live.current !== identity) return false;
      await refresh();
      return surface.isCurrent() && live.current === identity;
    } finally {
      busy.current = false;
      setPendingIdentity(current => current === identity ? null : current);
    }
  };
  return { status, mode, pending: pendingIdentity === identity || preference.pending, select, selectSubagentModel, refresh, changeScope: preference.changeScope };
}
