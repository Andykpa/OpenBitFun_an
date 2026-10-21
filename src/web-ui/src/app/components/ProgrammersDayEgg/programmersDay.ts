import { useEffect, useState } from 'react';

/** Programmer's Day falls on 10.24 because 2^10 = 1024. */
const PROGRAMMERS_DAY_MONTH_INDEX = 9;
const PROGRAMMERS_DAY_DATE = 24;
/** Guards against timers that fire a few milliseconds before the local midnight boundary. */
const MIDNIGHT_SETTLE_MS = 1000;

export const PROGRAMMERS_DAY_PREVIEW_STORAGE_KEY = 'openbitfun.debug.programmersDayPreview';

export const PROGRAMMERS_DAY_BINARY = (1024).toString(2);
export const PROGRAMMERS_DAY_VALUE = '1024';

export function isProgrammersDay(date: Date): boolean {
  return date.getMonth() === PROGRAMMERS_DAY_MONTH_INDEX && date.getDate() === PROGRAMMERS_DAY_DATE;
}

export function msUntilNextLocalMidnight(now: Date): number {
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(0, nextMidnight.getTime() - now.getTime());
}

/** Development builds may force the egg on any day; production builds tree-shake this branch. */
export function isProgrammersDayPreviewForced(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return globalThis.localStorage?.getItem(PROGRAMMERS_DAY_PREVIEW_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function resolveProgrammersDayActive(): boolean {
  return isProgrammersDayPreviewForced() || isProgrammersDay(new Date());
}

/**
 * Tracks whether the local calendar day is October 24. Long-running windows
 * re-evaluate at local midnight and after sleep or background throttling,
 * when timers may have drifted past the boundary.
 */
export function useIsProgrammersDay(): boolean {
  const [active, setActive] = useState(resolveProgrammersDayActive);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = () => {
      setActive(resolveProgrammersDayActive());
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(refresh, msUntilNextLocalMidnight(new Date()) + MIDNIGHT_SETTLE_MS);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };

    refresh();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', refresh);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return active;
}

export const DECODE_SCRAMBLE_FRAMES = 6;
export const DECODE_TOTAL_FRAMES = 16;

/**
 * Text for one frame of the binary-to-decimal decode: the binary form flickers,
 * then shrinks while the decimal digits lock in from the left.
 */
export function decodeFrame(frame: number, random: () => number = Math.random): string {
  const randomBit = () => (random() < 0.5 ? '0' : '1');
  if (frame >= DECODE_TOTAL_FRAMES) return PROGRAMMERS_DAY_VALUE;
  if (frame < DECODE_SCRAMBLE_FRAMES) {
    return Array.from(PROGRAMMERS_DAY_BINARY, (bit, index) => (
      index > 0 && random() < 0.3 ? randomBit() : bit
    )).join('');
  }

  const progress = (frame - DECODE_SCRAMBLE_FRAMES) / (DECODE_TOTAL_FRAMES - DECODE_SCRAMBLE_FRAMES);
  const length = Math.round(
    PROGRAMMERS_DAY_BINARY.length - (PROGRAMMERS_DAY_BINARY.length - PROGRAMMERS_DAY_VALUE.length) * progress,
  );
  const lockedDigits = Math.floor(PROGRAMMERS_DAY_VALUE.length * progress);
  let text = PROGRAMMERS_DAY_VALUE.slice(0, lockedDigits);
  while (text.length < length) text += randomBit();
  return text;
}
