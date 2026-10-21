/**
 * ProgrammersDayEgg — the 10.24 title-bar easter egg.
 *
 * Renders only on the local calendar day of October 24. It fills the free
 * title-bar space with bit rain, decodes the binary form of 1024 into a
 * phosphor-lit `<1024/>` with a blinking terminal cursor, glitches on hover
 * and now and then, and bursts the rain plus bit particles when clicked.
 *
 * The script-driven effects (rain, decode, blink, glitch toggles) do not
 * consult `prefers-reduced-motion`: Windows reports it whenever the system
 * "Animation effects" setting is off, which would leave the egg inert. CSS
 * keyframes still follow the global reduced-motion rules.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Tooltip } from '@openbitfun/ui';

import { useI18n } from '@/infrastructure/i18n';
import { BitRain } from './bitRain';
import {
  DECODE_TOTAL_FRAMES,
  PROGRAMMERS_DAY_VALUE,
  decodeFrame,
  useIsProgrammersDay,
} from './programmersDay';
import './ProgrammersDayEgg.scss';

const DECODE_FRAME_MS = 60;
const PARTICLE_COUNT = 8;
const PARTICLE_LIFETIME_MS = 1000;
/** Keeps the burst inside the 45px chrome row so it never paints over the search field. */
const PARTICLE_SPREAD_X_PX = 72;
const PARTICLE_SPREAD_Y_PX = 22;
const ENTRANCE_RAIN_BURST_MS = 2400;
const CLICK_RAIN_BURST_MS = 1600;
const GLITCH_MS = 360;
const AMBIENT_GLITCH_MIN_MS = 7000;
const AMBIENT_GLITCH_JITTER_MS = 6000;
const CURSOR_BLINK_MS = 530;
const FLICKER_CHANCE_PER_BLINK = 0.15;
const FLICKER_MS = 70;

interface Particle {
  id: number;
  glyph: '0' | '1';
  dx: number;
  dy: number;
  delayMs: number;
}

interface ParticleBurst {
  id: number;
  particles: Particle[];
}

function createParticles(): Particle[] {
  return Array.from({ length: PARTICLE_COUNT }, (_, id) => ({
    id,
    glyph: Math.random() < 0.5 ? '0' : '1',
    dx: Math.round((Math.random() - 0.5) * PARTICLE_SPREAD_X_PX),
    dy: Math.round((Math.random() - 0.5) * PARTICLE_SPREAD_Y_PX),
    delayMs: Math.round(Math.random() * 120),
  }));
}

const ProgrammersDayBadge: React.FC = () => {
  const { t } = useI18n('common');
  const [display, setDisplay] = useState(() => decodeFrame(0));
  const [burst, setBurst] = useState<ParticleBurst | null>(null);
  const [clipped, setClipped] = useState(false);
  const [glitching, setGlitching] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const badgeRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const valueRef = useRef<HTMLSpanElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);
  const rainRef = useRef<BitRain | null>(null);
  const decodeTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const burstTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const glitchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const burstIdRef = useRef(0);
  const isDecoding = display !== PROGRAMMERS_DAY_VALUE;
  const isDecodingRef = useRef(isDecoding);
  isDecodingRef.current = isDecoding;
  const clippedRef = useRef(clipped);
  clippedRef.current = clipped;

  // The binary frames are wider than the settled badge, so only the settled
  // width decides whether a narrow navigation column hides the badge.
  const measureFit = useCallback(() => {
    const badge = badgeRef.current;
    if (!badge || isDecodingRef.current) return;
    setClipped(badge.scrollWidth > badge.clientWidth + 1);
  }, []);

  const layoutRain = useCallback(() => {
    const root = rootRef.current;
    const badge = badgeRef.current;
    const rain = rainRef.current;
    if (!root || !rain) return;
    const rootRect = root.getBoundingClientRect();
    rain.resize(rootRect.width, rootRect.height);
    if (badge) {
      const badgeRect = badge.getBoundingClientRect();
      rain.setClearZone({ left: badgeRect.left - rootRect.left, right: badgeRect.right - rootRect.left });
    }
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const badge = badgeRef.current;
    if (!root || !badge || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      measureFit();
      layoutRain();
    });
    observer.observe(root);
    observer.observe(badge);
    return () => observer.disconnect();
  }, [measureFit, layoutRain]);

  useEffect(() => {
    if (!isDecoding) {
      measureFit();
      layoutRain();
    }
  }, [isDecoding, measureFit, layoutRain]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const rain = new BitRain(canvas);
    rainRef.current = rain;
    layoutRain();
    rain.burst(ENTRANCE_RAIN_BURST_MS);

    const syncRunning = () => {
      if (document.visibilityState === 'hidden' || clippedRef.current) rain.stop();
      else rain.start();
    };
    syncRunning();
    document.addEventListener('visibilitychange', syncRunning);
    return () => {
      document.removeEventListener('visibilitychange', syncRunning);
      rain.destroy();
      rainRef.current = null;
    };
  }, [layoutRain]);

  useEffect(() => {
    const rain = rainRef.current;
    if (!rain) return;
    if (clipped) rain.stop();
    else if (document.visibilityState !== 'hidden') rain.start();
  }, [clipped]);

  // Writes data attributes directly so the blink never re-renders React.
  useEffect(() => {
    let flickerTimer: ReturnType<typeof setTimeout> | undefined;
    const blinkTimer = setInterval(() => {
      const cursor = cursorRef.current;
      const value = valueRef.current;
      if (!cursor || !value || document.visibilityState === 'hidden' || clippedRef.current) return;
      cursor.dataset.blink = cursor.dataset.blink === 'off' ? 'on' : 'off';
      if (isDecodingRef.current || Math.random() >= FLICKER_CHANCE_PER_BLINK) return;
      value.dataset.flicker = 'on';
      if (flickerTimer !== undefined) clearTimeout(flickerTimer);
      flickerTimer = setTimeout(() => {
        flickerTimer = undefined;
        delete value.dataset.flicker;
      }, FLICKER_MS);
    }, CURSOR_BLINK_MS);
    return () => {
      clearInterval(blinkTimer);
      if (flickerTimer !== undefined) clearTimeout(flickerTimer);
    };
  }, []);

  const triggerGlitch = useCallback(() => {
    setGlitching(true);
    if (glitchTimerRef.current !== undefined) clearTimeout(glitchTimerRef.current);
    glitchTimerRef.current = setTimeout(() => {
      glitchTimerRef.current = undefined;
      setGlitching(false);
    }, GLITCH_MS);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        if (!isDecodingRef.current && !clippedRef.current && document.visibilityState !== 'hidden') {
          triggerGlitch();
        }
        schedule();
      }, AMBIENT_GLITCH_MIN_MS + Math.random() * AMBIENT_GLITCH_JITTER_MS);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [triggerGlitch]);

  const startDecode = useCallback(() => {
    if (decodeTimerRef.current !== undefined) clearInterval(decodeTimerRef.current);
    decodeTimerRef.current = undefined;
    let frame = 0;
    setDisplay(decodeFrame(frame));
    decodeTimerRef.current = setInterval(() => {
      frame += 1;
      setDisplay(decodeFrame(frame));
      if (frame >= DECODE_TOTAL_FRAMES) {
        clearInterval(decodeTimerRef.current);
        decodeTimerRef.current = undefined;
      }
    }, DECODE_FRAME_MS);
  }, []);

  useEffect(() => {
    startDecode();
    return () => {
      if (decodeTimerRef.current !== undefined) clearInterval(decodeTimerRef.current);
      if (burstTimerRef.current !== undefined) clearTimeout(burstTimerRef.current);
      if (glitchTimerRef.current !== undefined) clearTimeout(glitchTimerRef.current);
    };
  }, [startDecode]);

  const handleClick = useCallback(() => {
    startDecode();
    rainRef.current?.burst(CLICK_RAIN_BURST_MS);
    burstIdRef.current += 1;
    setBurst({ id: burstIdRef.current, particles: createParticles() });
    if (burstTimerRef.current !== undefined) clearTimeout(burstTimerRef.current);
    burstTimerRef.current = setTimeout(() => {
      burstTimerRef.current = undefined;
      setBurst(null);
    }, PARTICLE_LIFETIME_MS);
  }, [startDecode]);

  const handleMouseEnter = useCallback(() => {
    if (!isDecodingRef.current) triggerGlitch();
  }, [triggerGlitch]);

  const rootState = [
    isDecoding ? 'decoding' : '',
    clipped ? 'clipped' : '',
    glitching ? 'glitching' : '',
  ].filter(Boolean).join(' ');
  const rootClassName = [
    'openbitfun-programmers-day-egg',
    isDecoding ? 'is-decoding' : '',
    clipped ? 'is-clipped' : '',
    glitching ? 'is-glitching' : '',
  ].filter(Boolean).join(' ');

  return (
    <span
      ref={rootRef}
      className={rootClassName}
      data-openbitfun-component="programmers-day-egg"
      data-openbitfun-part="root"
      data-openbitfun-state={rootState || undefined}
      data-testid="programmers-day-egg"
    >
      <canvas
        ref={canvasRef}
        className="openbitfun-programmers-day-egg__rain"
        data-openbitfun-component="programmers-day-egg"
        data-openbitfun-part="rain"
        data-testid="programmers-day-egg-rain"
        aria-hidden="true"
      />
      <span className="openbitfun-programmers-day-egg__anchor" data-openbitfun-component="programmers-day-egg" data-openbitfun-part="anchor">
        <Tooltip content={t('nav.programmersDay.tooltip')} placement="bottom" disabled={clipped}>
          <button
            ref={badgeRef}
            type="button"
            className="openbitfun-programmers-day-egg__badge"
            data-openbitfun-component="programmers-day-egg"
            data-openbitfun-part="badge"
            data-testid="programmers-day-egg-badge"
            aria-label={t('nav.programmersDay.ariaLabel')}
            aria-hidden={clipped || undefined}
            tabIndex={clipped ? -1 : undefined}
            onClick={handleClick}
            onMouseEnter={handleMouseEnter}
          >
            <span className="openbitfun-programmers-day-egg__bracket" data-openbitfun-component="programmers-day-egg" data-openbitfun-part="bracket" aria-hidden="true">&lt;</span>
            <span
              ref={valueRef}
              className="openbitfun-programmers-day-egg__value"
              data-openbitfun-component="programmers-day-egg"
              data-openbitfun-part="value"
              data-text={display}
              data-testid="programmers-day-egg-value"
              aria-hidden="true"
            >
              {display}
            </span>
            <span className="openbitfun-programmers-day-egg__bracket" data-openbitfun-component="programmers-day-egg" data-openbitfun-part="bracket" aria-hidden="true">/&gt;</span>
            <span ref={cursorRef} className="openbitfun-programmers-day-egg__cursor" data-openbitfun-component="programmers-day-egg" data-openbitfun-part="cursor" aria-hidden="true" />
          </button>
        </Tooltip>
        {burst && (
          <span key={burst.id} className="openbitfun-programmers-day-egg__burst" data-openbitfun-component="programmers-day-egg" data-openbitfun-part="burst" aria-hidden="true">
            {burst.particles.map(particle => (
              <span
                key={particle.id}
                className="openbitfun-programmers-day-egg__particle"
                data-openbitfun-component="programmers-day-egg"
                data-openbitfun-part="particle"
                style={{
                  '--particle-dx': `${particle.dx}px`,
                  '--particle-dy': `${particle.dy}px`,
                  '--particle-delay': `${particle.delayMs}ms`,
                } as React.CSSProperties}
              >
                {particle.glyph}
              </span>
            ))}
          </span>
        )}
      </span>
    </span>
  );
};

const ProgrammersDayEgg: React.FC = () => {
  const active = useIsProgrammersDay();
  return active ? <ProgrammersDayBadge /> : null;
};

export default ProgrammersDayEgg;
