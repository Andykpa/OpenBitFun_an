// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/infrastructure/i18n', async () => {
  const { createTestI18nT } = await import('@/test/i18nTestUtils');
  return { useI18n: () => ({ t: createTestI18nT('common') }) };
});

import ProgrammersDayEgg from './ProgrammersDayEgg';
import { DECODE_TOTAL_FRAMES, PROGRAMMERS_DAY_BINARY } from './programmersDay';

describe('ProgrammersDayEgg', () => {
  let container: HTMLDivElement;
  let root: Root;

  const egg = () => container.querySelector<HTMLElement>('[data-testid="programmers-day-egg"]');
  const badge = () => container.querySelector<HTMLButtonElement>('[data-testid="programmers-day-egg-badge"]');
  const value = () => container.querySelector<HTMLElement>('[data-testid="programmers-day-egg-value"]');
  const cursor = () => container.querySelector<HTMLElement>('[data-openbitfun-part="cursor"]');
  const rain = () => container.querySelector('[data-testid="programmers-day-egg-rain"]');
  const particles = () => container.querySelectorAll('[data-openbitfun-part="particle"]');
  const settleDecode = () => act(() => { vi.advanceTimersByTime(60 * (DECODE_TOTAL_FRAMES + 1)); });
  const renderOn = (date: Date) => {
    vi.setSystemTime(date);
    act(() => root.render(<ProgrammersDayEgg />));
  };
  const stubReducedMotion = () => vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('renders nothing outside October 24', () => {
    renderOn(new Date(2026, 9, 23, 18, 0, 0));
    expect(egg()).toBeNull();
  });

  it('decodes the binary form into a phosphor 1024 over the bit rain on October 24', () => {
    renderOn(new Date(2026, 9, 24, 9, 0, 0));

    expect(rain()).not.toBeNull();
    expect(rain()?.getAttribute('aria-hidden')).toBe('true');
    expect(egg()?.dataset.openbitfunState).toContain('decoding');
    expect(value()?.textContent).toHaveLength(PROGRAMMERS_DAY_BINARY.length);
    expect(badge()?.getAttribute('aria-label')).toBe('Happy Programmer\'s Day (1024)');

    settleDecode();
    expect(value()?.textContent).toBe('1024');
    expect(value()?.dataset.text).toBe('1024');
    expect(egg()?.dataset.openbitfunState).toBeUndefined();
  });

  it('blinks the terminal cursor without re-rendering the badge', () => {
    renderOn(new Date(2026, 9, 24, 9, 0, 0));
    settleDecode();
    const badgeNode = badge();
    const initial = cursor()?.dataset.blink;

    act(() => { vi.advanceTimersByTime(530); });
    const afterOne = cursor()?.dataset.blink;
    act(() => { vi.advanceTimersByTime(530); });
    const afterTwo = cursor()?.dataset.blink;

    expect(afterOne).not.toBe(initial);
    expect(afterTwo).not.toBe(afterOne);
    expect(badge()).toBe(badgeNode);
  });

  it('glitches briefly when hovered', () => {
    renderOn(new Date(2026, 9, 24, 9, 0, 0));
    settleDecode();

    act(() => {
      badge()!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    });
    expect(egg()?.dataset.openbitfunState).toContain('glitching');

    act(() => { vi.advanceTimersByTime(400); });
    expect(egg()?.dataset.openbitfunState ?? '').not.toContain('glitching');
  });

  it('glitches on its own every so often while idle', () => {
    renderOn(new Date(2026, 9, 24, 9, 0, 0));
    settleDecode();
    let sawGlitch = false;
    for (let elapsed = 0; elapsed < 14_000 && !sawGlitch; elapsed += 100) {
      act(() => { vi.advanceTimersByTime(100); });
      sawGlitch = Boolean(egg()?.dataset.openbitfunState?.includes('glitching'));
    }
    expect(sawGlitch).toBe(true);
  });

  it('replays the decode with a transient bit burst on click', () => {
    renderOn(new Date(2026, 9, 24, 9, 0, 0));
    settleDecode();

    act(() => badge()!.click());
    expect(value()?.textContent).toHaveLength(PROGRAMMERS_DAY_BINARY.length);
    expect(particles()).toHaveLength(8);
    particles().forEach(particle => expect(particle.textContent).toMatch(/^[01]$/));

    act(() => { vi.advanceTimersByTime(1000); });
    expect(particles()).toHaveLength(0);
    expect(value()?.textContent).toBe('1024');
  });

  it('drops the rain, blink, glitch, and burst when reduced motion is preferred', () => {
    stubReducedMotion();
    renderOn(new Date(2026, 9, 24, 9, 0, 0));
    expect(value()?.textContent).toBe('1024');
    expect(rain()).toBeNull();

    act(() => { vi.advanceTimersByTime(20_000); });
    expect(cursor()?.dataset.blink).toBeUndefined();
    expect(egg()?.dataset.openbitfunState).toBeUndefined();

    act(() => badge()!.click());
    expect(value()?.textContent).toBe('1024');
    expect(particles()).toHaveLength(0);
  });

  it('disappears at the local midnight that ends October 24', () => {
    renderOn(new Date(2026, 9, 24, 23, 59, 0));
    expect(egg()).not.toBeNull();

    act(() => { vi.advanceTimersByTime(61_000); });
    expect(egg()).toBeNull();
  });
});
