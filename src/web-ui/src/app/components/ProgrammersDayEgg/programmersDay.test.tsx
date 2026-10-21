// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DECODE_SCRAMBLE_FRAMES,
  DECODE_TOTAL_FRAMES,
  PROGRAMMERS_DAY_BINARY,
  PROGRAMMERS_DAY_PREVIEW_STORAGE_KEY,
  PROGRAMMERS_DAY_VALUE,
  decodeFrame,
  isProgrammersDay,
  msUntilNextLocalMidnight,
  useIsProgrammersDay,
} from './programmersDay';

describe('isProgrammersDay', () => {
  it('matches only October 24 in local time', () => {
    expect(isProgrammersDay(new Date(2026, 9, 24, 0, 0, 0))).toBe(true);
    expect(isProgrammersDay(new Date(2026, 9, 24, 23, 59, 59))).toBe(true);
    expect(isProgrammersDay(new Date(2026, 9, 23, 23, 59, 59))).toBe(false);
    expect(isProgrammersDay(new Date(2026, 9, 25, 0, 0, 0))).toBe(false);
    expect(isProgrammersDay(new Date(2026, 8, 24, 12, 0, 0))).toBe(false);
    expect(isProgrammersDay(new Date(2027, 9, 24, 12, 0, 0))).toBe(true);
  });
});

describe('msUntilNextLocalMidnight', () => {
  it('counts down to the next local calendar day', () => {
    expect(msUntilNextLocalMidnight(new Date(2026, 9, 23, 23, 59, 0))).toBe(60_000);
    expect(msUntilNextLocalMidnight(new Date(2026, 9, 24, 0, 0, 0))).toBe(
      new Date(2026, 9, 25).getTime() - new Date(2026, 9, 24).getTime(),
    );
    expect(msUntilNextLocalMidnight(new Date(2026, 11, 31, 23, 0, 0))).toBe(3_600_000);
  });
});

describe('decodeFrame', () => {
  it('starts from the binary form and settles on the decimal form', () => {
    const lowBits = () => 0.9;
    expect(PROGRAMMERS_DAY_BINARY).toBe('10000000000');
    expect(decodeFrame(0, lowBits)).toBe(PROGRAMMERS_DAY_BINARY);
    expect(decodeFrame(DECODE_TOTAL_FRAMES, lowBits)).toBe(PROGRAMMERS_DAY_VALUE);
    expect(decodeFrame(DECODE_TOTAL_FRAMES + 5, lowBits)).toBe(PROGRAMMERS_DAY_VALUE);
  });

  it('keeps the scramble phase at binary width with a stable leading bit', () => {
    const flipEverything = () => 0;
    for (let frame = 0; frame < DECODE_SCRAMBLE_FRAMES; frame += 1) {
      const text = decodeFrame(frame, flipEverything);
      expect(text).toHaveLength(PROGRAMMERS_DAY_BINARY.length);
      expect(text[0]).toBe('1');
      expect(text).toMatch(/^[01]+$/);
    }
  });

  it('shrinks monotonically while locking decimal digits from the left', () => {
    let previousLength = PROGRAMMERS_DAY_BINARY.length;
    for (let frame = DECODE_SCRAMBLE_FRAMES; frame <= DECODE_TOTAL_FRAMES; frame += 1) {
      const text = decodeFrame(frame);
      expect(text.length).toBeLessThanOrEqual(previousLength);
      expect(text.length).toBeGreaterThanOrEqual(PROGRAMMERS_DAY_VALUE.length);
      const progress = (frame - DECODE_SCRAMBLE_FRAMES) / (DECODE_TOTAL_FRAMES - DECODE_SCRAMBLE_FRAMES);
      const locked = Math.floor(PROGRAMMERS_DAY_VALUE.length * progress);
      expect(text.slice(0, locked)).toBe(PROGRAMMERS_DAY_VALUE.slice(0, locked));
      previousLength = text.length;
    }
  });
});

describe('useIsProgrammersDay', () => {
  let container: HTMLDivElement;
  let root: Root;

  const Probe: React.FC = () => <span data-testid="probe">{useIsProgrammersDay() ? 'on' : 'off'}</span>;
  const probeText = () => container.querySelector('[data-testid="probe"]')?.textContent;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    vi.useRealTimers();
  });

  it('turns on at the local midnight that starts October 24 and off at the next one', () => {
    vi.setSystemTime(new Date(2026, 9, 23, 23, 59, 30));
    act(() => root.render(<Probe />));
    expect(probeText()).toBe('off');

    act(() => { vi.advanceTimersByTime(31_000); });
    expect(probeText()).toBe('on');

    act(() => { vi.advanceTimersByTime(24 * 60 * 60 * 1000); });
    expect(probeText()).toBe('off');
  });

  it('re-evaluates when the window regains focus after timers drifted', () => {
    vi.setSystemTime(new Date(2026, 9, 23, 12, 0, 0));
    act(() => root.render(<Probe />));
    expect(probeText()).toBe('off');

    vi.setSystemTime(new Date(2026, 9, 24, 9, 0, 0));
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(probeText()).toBe('on');

    vi.setSystemTime(new Date(2026, 9, 25, 9, 0, 0));
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(probeText()).toBe('off');
  });

  it('honors the development preview switch on any day', () => {
    vi.setSystemTime(new Date(2026, 2, 1, 12, 0, 0));
    localStorage.setItem(PROGRAMMERS_DAY_PREVIEW_STORAGE_KEY, '1');
    act(() => root.render(<Probe />));
    expect(probeText()).toBe('on');
  });

  it('releases its midnight timer on unmount', () => {
    vi.setSystemTime(new Date(2026, 9, 24, 12, 0, 0));
    act(() => root.render(<Probe />));
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});
