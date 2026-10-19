import { useEffect, useRef, useState } from 'react';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';

export type ModelSelectionScope = 'remember' | 'session';
const STORAGE_PREFIX = 'openbitfun.model-selection.scope.v1:';
const readScope = (key: string): ModelSelectionScope => {
  try { return window.localStorage.getItem(STORAGE_PREFIX + key) === 'session' ? 'session' : 'remember'; }
  catch { return 'remember'; }
};

/** Only the editor's save preference is local. Models/defaults remain host-owned. */
export function useModelSelectionScope({ scopeKey, epoch, sessionId, allowed, open, defaultModel, selectedModel, onDefaultChange, defaultPath = 'ai.agent_model_defaults.mode', skipUnchangedWrite = false, scopeOverride }: {
  defaultPath?: string; skipUnchangedWrite?: boolean; scopeOverride?: ModelSelectionScope;
  scopeKey: string; epoch: number; sessionId?: string; allowed: boolean; open: boolean;
  defaultModel: string; selectedModel: string; onDefaultChange: (model: string) => void;
}) {
  const identity = `${epoch}:${scopeKey}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [preference, setPreference] = useState(() => ({ identity, value: readScope(scopeKey) }));
  const [pendingIdentity, setPendingIdentity] = useState<string | null>(null);
  const edit = useRef<{ identity: string; baseline: string; lastWritten?: string } | null>(null);
  const scope = !allowed ? 'session' : !sessionId ? 'remember'
    : scopeOverride ?? (preference.identity === identity ? preference.value : readScope(scopeKey));
  useEffect(() => {
    if (!open) { edit.current = null; return; }
    if (edit.current?.identity !== identity) edit.current = { identity, baseline: defaultModel };
  }, [open, identity, defaultModel]);

  const markDefaultWrite = (modelId: string) => {
    if (identityRef.current !== identity) return;
    if (!edit.current || edit.current.identity !== identity) edit.current = { identity, baseline: defaultModel };
    edit.current.lastWritten = modelId;
  };
  const changeScope = async (next: ModelSelectionScope) => {
    if (!allowed || !sessionId || scope === next || pendingIdentity === identity) return;
    const surface = getActiveSurfaceScope();
    setPendingIdentity(identity);
    try {
      let updated: string | undefined;
      if (next === 'remember') {
        if (!skipUnchangedWrite || selectedModel !== defaultModel) {
          markDefaultWrite(selectedModel);
          await configManager.setConfig(defaultPath, selectedModel);
          updated = selectedModel;
        }
      } else if (edit.current?.identity === identity && edit.current.lastWritten) {
        const { baseline, lastWritten } = edit.current;
        // ConfigManager serializes this behind outstanding default saves. Only
        // undo our own edit; do not overwrite a newer choice from another editor.
        updated = await configManager.updateConfig<string>(defaultPath, current =>
          current === lastWritten ? baseline : current);
      }
      if (!surface.isCurrent() || identityRef.current !== identity) return;
      if (updated) onDefaultChange(updated);
      // Related default owners share one UI preference. Only its owner commits
      // the scope after all requested default writes have completed.
      if (scopeOverride === undefined) {
        setPreference({ identity, value: next });
        try { window.localStorage.setItem(STORAGE_PREFIX + scopeKey, next); } catch { /* In-memory preference remains usable. */ }
      }
      if (next === 'session' && edit.current) edit.current.lastWritten = undefined;
    } finally {
      // A session can be switched away from and back to without a new device
      // epoch. Clear only this operation, even if its editor is no longer shown.
      setPendingIdentity(current => current === identity ? null : current);
    }
  };
  return { scope, pending: pendingIdentity === identity, remember: allowed && scope === 'remember', markDefaultWrite, changeScope };
}
