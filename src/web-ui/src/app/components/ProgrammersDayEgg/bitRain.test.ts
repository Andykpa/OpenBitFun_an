// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BitRain } from './bitRain';

interface FillCall {
  glyph: string;
  x: number;
  y: number;
  alpha: number;
  fillStyle: string;
}

function createFakeContext() {
  const calls: FillCall[] = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    shadowColor: '',
    shadowBlur: 0,
    font: '',
    textBaseline: 'alphabetic',
    clears: 0,
    setTransform: vi.fn(),
    clearRect: vi.fn(() => { ctx.clears += 1; }),
    fillText: vi.fn((glyph: string, x: number, y: number) => {
      calls.push({ glyph, x, y, alpha: ctx.globalAlpha, fillStyle: ctx.fillStyle });
    }),
  };
  return { ctx, calls };
}

function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length];
}

describe('BitRain', () => {
  let canvas: HTMLCanvasElement;
  let fake: ReturnType<typeof createFakeContext>;
  let clock: number;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
    fake = createFakeContext();
    canvas = document.createElement('canvas');
    canvas.style.fontSize = '10px';
    canvas.style.fontFamily = 'monospace';
    canvas.style.color = 'rgb(0, 200, 120)';
    canvas.style.borderTopColor = 'rgb(240, 240, 240)';
    document.body.appendChild(canvas);
    vi.spyOn(canvas, 'getContext').mockReturnValue(fake.ctx as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    canvas.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const createRain = (random: () => number = () => 0) => new BitRain(canvas, { random, now: () => clock });

  it('sizes the backing store for the device pixel ratio and lays out columns', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const rain = createRain();
    rain.resize(180, 45);
    expect(canvas.width).toBe(360);
    expect(canvas.height).toBe(90);
    expect(fake.ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    expect(rain.activeDropCount).toBe(0);
    vi.unstubAllGlobals();
  });

  it('ignores resizes that keep the same geometry so in-flight drops survive', () => {
    const rain = createRain();
    rain.resize(180, 45);
    rain.burst(1000);
    rain.step();
    const drops = rain.activeDropCount;
    expect(drops).toBeGreaterThan(0);
    fake.ctx.setTransform.mockClear();
    rain.resize(180, 45);
    expect(fake.ctx.setTransform).not.toHaveBeenCalled();
    expect(rain.activeDropCount).toBe(drops);
    rain.resize(200, 45);
    expect(rain.activeDropCount).toBeGreaterThanOrEqual(drops);
  });

  it('rains densely during a burst and sparsely afterwards', () => {
    const burstRain = createRain(sequence([0.1, 0.9, 0.9, 0.9]));
    burstRain.resize(180, 45);
    burstRain.burst(500);
    for (let i = 0; i < 4; i += 1) burstRain.step();
    const burstDrops = burstRain.activeDropCount;

    const ambientRain = createRain(sequence([0.1, 0.9, 0.9, 0.9]));
    ambientRain.resize(180, 45);
    for (let i = 0; i < 4; i += 1) ambientRain.step();

    expect(burstDrops).toBeGreaterThan(ambientRain.activeDropCount);
  });

  it('paints bright heads with the head color and fading trails with the trail color', () => {
    const rain = createRain(() => 0);
    rain.resize(180, 45);
    rain.burst(1000);
    for (let i = 0; i < 4; i += 1) rain.step();
    fake.calls.length = 0;
    rain.draw();

    expect(fake.calls.length).toBeGreaterThan(0);
    fake.calls.forEach(call => expect(call.glyph).toMatch(/^[01]$/));
    const heads = fake.calls.filter(call => call.fillStyle === 'rgb(240, 240, 240)');
    const trails = fake.calls.filter(call => call.fillStyle === 'rgb(0, 200, 120)');
    expect(heads.length).toBeGreaterThan(0);
    expect(trails.length).toBeGreaterThan(0);
    const farRightHead = heads.filter(call => call.x > 100).map(call => call.alpha);
    const farRightTrail = trails.filter(call => call.x > 100).map(call => call.alpha);
    expect(Math.min(...farRightHead)).toBeGreaterThan(Math.max(...farRightTrail));
  });

  it('fades in from the left edge and attenuates rain behind the badge', () => {
    const rain = createRain();
    rain.resize(180, 45);
    expect(rain.positionAlpha(0)).toBe(0);
    expect(rain.positionAlpha(24)).toBeCloseTo(0.5);
    expect(rain.positionAlpha(100)).toBe(1);

    rain.setClearZone({ left: 120, right: 170 });
    expect(rain.positionAlpha(140)).toBeLessThan(0.5);
    expect(rain.positionAlpha(80)).toBe(1);
  });

  it('skips repainting an already empty canvas', () => {
    const rain = createRain(() => 0.99);
    rain.resize(180, 45);
    const clearsAfterResize = fake.ctx.clears;
    rain.draw();
    rain.draw();
    expect(fake.ctx.clears).toBe(clearsAfterResize);
  });

  it('wakes once per step and stops without leaving timers or frames behind', () => {
    const rain = createRain(() => 0);
    rain.resize(180, 45);
    rain.start();
    expect(rain.isRunning).toBe(true);

    fake.calls.length = 0;
    clock += 100;
    vi.advanceTimersByTime(200);
    expect(fake.calls.length).toBeGreaterThan(0);

    rain.stop();
    expect(rain.isRunning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    rain.start();
    rain.destroy();
    expect(rain.isRunning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stays inert when the canvas has no 2D context', () => {
    vi.spyOn(canvas, 'getContext').mockReturnValue(null);
    const rain = createRain();
    rain.resize(180, 45);
    rain.start();
    expect(rain.isRunning).toBe(false);
    expect(() => rain.draw()).not.toThrow();
  });
});
