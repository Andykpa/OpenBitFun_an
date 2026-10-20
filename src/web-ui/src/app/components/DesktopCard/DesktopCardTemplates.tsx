import React, { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, StatusPill, type StatusPillTone } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { cronAPI, type CronJob } from '@/infrastructure/api/service-api/CronAPI';
import type {
  DesktopCardRecord,
  DesktopCardTemplate,
} from '@/infrastructure/api/service-api/DesktopCardAPI';
import { createLogger } from '@/shared/utils/logger';
import DesktopCardCustomFrame from './DesktopCardCustomFrame';
import {
  countdownParts,
  formatCountdownClock,
  formatMetricValue,
  metricHint,
  metricRawValue,
  metricTone,
  progressState,
  type DesktopCardFormatters,
} from './desktopCardModel';
import { useNow } from './useNow';

const log = createLogger('DesktopCardTemplates');

type TemplateOf<K extends DesktopCardTemplate['kind']> = Extract<DesktopCardTemplate, { kind: K }>;

export function CountdownTemplate({ template, onDismiss }: {
  template: TemplateOf<'countdown'>;
  onDismiss: () => void;
}) {
  const { t } = useI18n('components');
  const now = useNow(1000, Date.now() < template.targetAtMs);
  const parts = countdownParts(template.targetAtMs, template.startedAtMs, now);
  return (
    <div className="openbitfun-desktop-card__countdown" data-state={parts.due ? 'due' : 'running'}
      data-openbitfun-component="desktop-card" data-openbitfun-part="countdown">
      <div className="openbitfun-desktop-card__countdown-clock" role="timer" aria-live={parts.due ? 'assertive' : 'off'}>
        {parts.due ? t('desktopCard.countdown.due') : (
          <>
            {parts.days > 0 && <span className="openbitfun-desktop-card__countdown-days">{t('desktopCard.countdown.days', { count: parts.days })}</span>}
            {formatCountdownClock(parts)}
          </>
        )}
      </div>
      {template.message && <p className="openbitfun-desktop-card__countdown-message">{template.message}</p>}
      {parts.due ? (
        <Button size="sm" variant="secondary" onClick={onDismiss}>{t('desktopCard.countdown.dismiss')}</Button>
      ) : parts.elapsedRatio !== null && (
        <div className="openbitfun-desktop-card__bar" aria-hidden="true">
          <span style={{ inlineSize: `${(parts.elapsedRatio * 100).toFixed(2)}%` }} />
        </div>
      )}
    </div>
  );
}

export function ChecklistTemplate({ template, onToggle }: {
  template: TemplateOf<'checklist'>;
  onToggle: (itemId: string, done: boolean) => void;
}) {
  const { t } = useI18n('components');
  if (template.items.length === 0) {
    return <p className="openbitfun-desktop-card__empty">{t('desktopCard.checklist.empty')}</p>;
  }
  return (
    <ul className="openbitfun-desktop-card__checklist" data-openbitfun-component="desktop-card" data-openbitfun-part="checklist">
      {template.items.map(item => (
        <li key={item.id} data-done={item.done ? 'true' : undefined}>
          <Checkbox size="sm" checked={item.done === true} label={item.text}
            onCheckedChange={checked => onToggle(item.id, checked)} />
        </li>
      ))}
    </ul>
  );
}

export function NoteTemplate({ template }: { template: TemplateOf<'note'> }) {
  return <p className="openbitfun-desktop-card__note" data-openbitfun-component="desktop-card" data-openbitfun-part="note">{template.text}</p>;
}

export function ProgressTemplate({ template, data, formatters }: {
  template: TemplateOf<'progress'>;
  data: unknown;
  formatters: DesktopCardFormatters;
}) {
  const state = progressState(template, data);
  return (
    <div className="openbitfun-desktop-card__progress" data-openbitfun-component="desktop-card" data-openbitfun-part="progress">
      <div className="openbitfun-desktop-card__progress-head">
        <span className="openbitfun-desktop-card__progress-value">
          {state.ratio === null ? '—' : formatters.formatNumber(state.ratio, { style: 'percent', maximumFractionDigits: 0 })}
        </span>
        {state.value !== null && (
          <span className="openbitfun-desktop-card__muted">
            {formatters.formatNumber(state.value)} / {formatters.formatNumber(state.max)}
          </span>
        )}
      </div>
      <div className="openbitfun-desktop-card__bar" role="progressbar" aria-valuemin={0} aria-valuemax={state.max}
        aria-valuenow={state.value ?? undefined}>
        <span style={{ inlineSize: `${((state.ratio ?? 0) * 100).toFixed(2)}%` }} />
      </div>
      {state.status && <p className="openbitfun-desktop-card__muted openbitfun-desktop-card__progress-status">{state.status}</p>}
    </div>
  );
}

export function MetricsTemplate({ template, data, formatters }: {
  template: TemplateOf<'metrics'>;
  data: unknown;
  formatters: DesktopCardFormatters;
}) {
  const layout = template.layout === 'grid' ? 'grid' : 'list';
  return (
    <dl className="openbitfun-desktop-card__metrics" data-layout={layout}
      data-openbitfun-component="desktop-card" data-openbitfun-part="metrics">
      {template.items.map((item, index) => {
        const raw = metricRawValue(item, data);
        const hint = metricHint(item, data);
        return (
          <div key={`${item.label}-${index}`} className="openbitfun-desktop-card__metric"
            data-emphasis={item.emphasis ? 'true' : undefined} data-tone={metricTone(item, raw)} title={hint}>
            <dt>{item.label}</dt>
            <dd>{formatMetricValue(item, raw, formatters)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

const CRON_STATUS_TONE: Record<string, StatusPillTone> = {
  ok: 'success',
  error: 'danger',
  running: 'info',
  queued: 'info',
  cancelled: 'neutral',
};

function cronStatusLabel(t: (key: string) => string, status: string): string {
  switch (status) {
    case 'ok': return t('desktopCard.cron.status.ok');
    case 'error': return t('desktopCard.cron.status.error');
    case 'running': return t('desktopCard.cron.status.running');
    case 'queued': return t('desktopCard.cron.status.queued');
    case 'cancelled': return t('desktopCard.cron.status.cancelled');
    default: return status;
  }
}

export function CronJobTemplate({ template, formatters }: {
  template: TemplateOf<'cronJob'>;
  formatters: DesktopCardFormatters;
}) {
  const { t } = useI18n('components');
  const [job, setJob] = useState<CronJob | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  useNow(30_000);

  const load = useCallback(async () => {
    try {
      const jobs = await cronAPI.listJobs();
      setJob(jobs.find(candidate => candidate.id === template.jobId) ?? null);
      setFailed(false);
    } catch (error) {
      log.warn('Failed to load scheduled job for desktop card', { jobId: template.jobId, error });
      setFailed(true);
    }
  }, [template.jobId]);

  useEffect(() => {
    void load();
    const unlisten = cronAPI.onJobsChanged(() => { void load(); });
    const timer = window.setInterval(() => { void load(); }, 60_000);
    return () => {
      unlisten();
      window.clearInterval(timer);
    };
  }, [load]);

  if (failed && job === undefined) return <p className="openbitfun-desktop-card__empty">{t('desktopCard.cron.failed')}</p>;
  if (job === undefined) return <p className="openbitfun-desktop-card__empty">{t('desktopCard.loading')}</p>;
  if (job === null) return <p className="openbitfun-desktop-card__empty">{t('desktopCard.cron.missing')}</p>;

  const nextRun = job.state.nextRunAtMs ?? job.state.retryAtMs ?? null;
  const lastRun = job.state.lastRunFinishedAtMs ?? job.state.lastRunStartedAtMs ?? null;
  const lastStatus = job.state.lastRunStatus ?? null;
  return (
    <div className="openbitfun-desktop-card__cron" data-openbitfun-component="desktop-card" data-openbitfun-part="cron">
      <div className="openbitfun-desktop-card__cron-head">
        <span className="openbitfun-desktop-card__cron-name">{job.name}</span>
        <StatusPill tone={job.enabled ? 'success' : 'neutral'}>
          {t(job.enabled ? 'desktopCard.cron.enabled' : 'desktopCard.cron.paused')}
        </StatusPill>
      </div>
      <dl className="openbitfun-desktop-card__metrics" data-layout="list">
        <div className="openbitfun-desktop-card__metric">
          <dt>{t('desktopCard.cron.nextRun')}</dt>
          <dd title={nextRun ? formatters.formatDate(nextRun, { dateStyle: 'medium', timeStyle: 'short' }) : undefined}>
            {job.enabled && nextRun ? formatters.formatRelativeTime(nextRun) : '—'}
          </dd>
        </div>
        <div className="openbitfun-desktop-card__metric" data-tone={lastStatus ? CRON_STATUS_TONE[lastStatus] : undefined}>
          <dt>{t('desktopCard.cron.lastRun')}</dt>
          <dd title={job.state.lastError ?? undefined}>
            {lastStatus ? cronStatusLabel(t, lastStatus) : t('desktopCard.cron.neverRun')}
            {lastRun ? ` · ${formatters.formatRelativeTime(lastRun)}` : ''}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function CustomTemplate({ template, card, data, onOpenLink }: {
  template: TemplateOf<'custom'>;
  card: DesktopCardRecord;
  data: unknown;
  onOpenLink: (url: string) => void;
}) {
  const payload = React.useMemo(() => ({
    data,
    card: { id: card.id, title: card.title, subtitle: card.subtitle },
    error: card.lastData?.error,
  }), [data, card.id, card.title, card.subtitle, card.lastData?.error]);
  return <DesktopCardCustomFrame html={template.html} title={card.title} payload={payload} onOpenLink={onOpenLink} />;
}
