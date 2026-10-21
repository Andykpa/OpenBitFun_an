/**
 * Canvas 2D bit rain for the 10.24 title-bar easter egg.
 *
 * Colors and font come from the canvas element's computed style so the rain
 * follows the active appearance: `color` paints the trail and
 * `border-top-color` paints the bright drop heads. Canvas 2D keeps rendering
 * identical across WKWebView, WebView2, and WebKitGTK.
 */

const AMBIENT_INTENSITY = 0.1;
const BURST_STEP_MS = 45;
const AMBIENT_STEP_MS = 85;
const STYLE_REFRESH_MS = 1000;
/** Rain fades in over this many CSS pixels so it never collides with the controls on its left. */
const EDGE_FADE_PX = 48;
const CLEAR_ZONE_PADDING_PX = 6;
const CLEAR_ZONE_ALPHA = 0.2;
const HEAD_GLOW_BLUR_PX = 6;

export interface BitRainZone {
  left: number;
  right: number;
}

export interface BitRainOptions {
  random?: () => number;
  now?: () => number;
}

interface BitRainStyle {
  trail: string;
  head: string;
  glyphFont: string;
  fontSizePx: number;
}

interface Column {
  x: number;
  head: number;
  speed: number;
  trail: number;
  glyphs: string[];
}

export class BitRain {
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly random: () => number;
  private readonly now: () => number;
  private columns: Column[] = [];
  private width = 0;
  private height = 0;
  private dpr = 0;
  private rows = 0;
  private cell = 0;
  private intensity = AMBIENT_INTENSITY;
  private burstUntil = 0;
  private zone: BitRainZone | null = null;
  private style: BitRainStyle | null = null;
  private styleReadAt = Number.NEGATIVE_INFINITY;
  private frameId: number | null = null;
  private stepTimer: ReturnType<typeof setTimeout> | null = null;
  private paintedEmpty = false;

  constructor(private readonly canvas: HTMLCanvasElement, options: BitRainOptions = {}) {
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => globalThis.performance?.now() ?? Date.now());
    this.ctx = canvas.getContext('2d');
  }

  get isRunning(): boolean {
    return this.frameId !== null || this.stepTimer !== null;
  }

  get activeDropCount(): number {
    return this.columns.filter(column => column.head >= 0).length;
  }

  resize(width: number, height: number): void {
    const dpr = globalThis.devicePixelRatio || 1;
    const nextWidth = Math.max(0, width);
    const nextHeight = Math.max(0, height);
    if (nextWidth === this.width && nextHeight === this.height && dpr === this.dpr) return;
    this.width = nextWidth;
    this.height = nextHeight;
    this.dpr = dpr;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.refreshStyle(true);
    this.layoutColumns();
    this.paintedEmpty = false;
    this.draw();
  }

  /** Attenuates the rain behind the badge so the settled value stays readable. */
  setClearZone(zone: BitRainZone | null): void {
    this.zone = zone;
  }

  burst(durationMs: number): void {
    this.burstUntil = Math.max(this.burstUntil, this.now() + durationMs);
  }

  /**
   * Wakes once per simulation step and requests a single frame for it, so the
   * ambient rain does not keep the renderer ticking at the display rate.
   */
  start(): void {
    if (this.isRunning || !this.ctx) return;
    this.scheduleStep();
  }

  stop(): void {
    if (this.stepTimer !== null) clearTimeout(this.stepTimer);
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.stepTimer = null;
    this.frameId = null;
  }

  private scheduleStep(): void {
    const interval = this.intensity > 0.5 ? BURST_STEP_MS : AMBIENT_STEP_MS;
    this.stepTimer = setTimeout(() => {
      this.stepTimer = null;
      this.frameId = requestAnimationFrame(() => {
        this.frameId = null;
        this.step();
        this.draw();
        this.scheduleStep();
      });
    }, interval);
  }

  destroy(): void {
    this.stop();
    this.ctx?.clearRect(0, 0, this.width, this.height);
    this.columns = [];
  }

  /** Advances the simulation by one discrete step. Exposed for deterministic tests. */
  step(): void {
    this.refreshStyle(false);
    const target = this.now() < this.burstUntil ? 1 : AMBIENT_INTENSITY;
    this.intensity += (target - this.intensity) * 0.2;
    const spawnChance = 0.004 + 0.26 * this.intensity;

    for (const column of this.columns) {
      if (column.head < 0) {
        if (this.random() < spawnChance) {
          column.head = 0;
          column.trail = 2 + Math.floor(this.random() * 4);
          column.speed = this.random() < 0.5 ? 1 : 0.6;
        }
        continue;
      }
      column.head += column.speed;
      if (column.head - column.trail > this.rows) column.head = -1;
      if (this.random() < 0.25) {
        column.glyphs[Math.floor(this.random() * column.glyphs.length)] = this.randomBit();
      }
    }
  }

  /** Paints the current simulation state. Exposed for deterministic tests. */
  draw(): void {
    const ctx = this.ctx;
    const style = this.style;
    if (!ctx || !style) return;
    const hasDrops = this.columns.some(column => column.head >= 0);
    if (!hasDrops && this.paintedEmpty) return;
    this.paintedEmpty = !hasDrops;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.font = style.glyphFont;
    ctx.textBaseline = 'top';

    for (const column of this.columns) {
      if (column.head < 0) continue;
      const positionAlpha = this.positionAlpha(column.x);
      if (positionAlpha <= 0) continue;
      const headRow = Math.floor(column.head);
      for (let offset = 0; offset <= column.trail; offset += 1) {
        const row = headRow - offset;
        if (row < 0 || row >= this.rows) continue;
        const isHead = offset === 0;
        const alpha = (isHead ? 1 : (1 - offset / (column.trail + 1)) * 0.7) * positionAlpha;
        if (alpha < 0.02) continue;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = isHead ? style.head : style.trail;
        ctx.shadowColor = style.trail;
        ctx.shadowBlur = isHead ? HEAD_GLOW_BLUR_PX : 0;
        ctx.fillText(column.glyphs[row % column.glyphs.length], column.x, row * this.cell);
      }
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  positionAlpha(x: number): number {
    const edge = Math.min(1, Math.max(0, x / EDGE_FADE_PX));
    const zone = this.zone;
    const inZone = zone
      && x >= zone.left - CLEAR_ZONE_PADDING_PX
      && x <= zone.right + CLEAR_ZONE_PADDING_PX;
    return edge * (inZone ? CLEAR_ZONE_ALPHA : 1);
  }

  private randomBit(): string {
    return this.random() < 0.5 ? '0' : '1';
  }

  private refreshStyle(force: boolean): void {
    const now = this.now();
    if (!force && now - this.styleReadAt < STYLE_REFRESH_MS) return;
    this.styleReadAt = now;
    const computed = this.canvas.ownerDocument.defaultView?.getComputedStyle(this.canvas);
    if (!computed) return;
    const fontSizePx = Number.parseFloat(computed.fontSize) || 0;
    const previousFontSize = this.style?.fontSizePx;
    this.style = {
      trail: computed.color,
      head: computed.borderTopColor || computed.color,
      glyphFont: `${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`,
      fontSizePx,
    };
    if (!force && previousFontSize !== fontSizePx) this.layoutColumns();
  }

  /** Keeps in-flight drops when the region resizes, e.g. while the badge decodes. */
  private layoutColumns(): void {
    const fontSizePx = this.style?.fontSizePx ?? 0;
    if (fontSizePx <= 0 || this.width <= 0 || this.height <= 0) {
      this.columns = [];
      this.rows = 0;
      return;
    }
    this.cell = fontSizePx * 1.05;
    this.rows = Math.ceil(this.height / this.cell);
    const columnWidth = fontSizePx * 0.9;
    const count = Math.max(1, Math.floor(this.width / columnWidth));
    const glyphCount = this.rows + 1;
    const previous = this.columns;
    this.columns = Array.from({ length: count }, (_, index) => {
      const existing = previous[index];
      if (existing && existing.glyphs.length === glyphCount) {
        existing.x = index * columnWidth;
        return existing;
      }
      return {
        x: index * columnWidth,
        head: -1,
        speed: 1,
        trail: 3,
        glyphs: Array.from({ length: glyphCount }, () => this.randomBit()),
      };
    });
  }
}
