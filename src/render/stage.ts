// StageRenderer：把整个视觉舞台合成到一张 1920×1080 的 2D canvas。
// 预览与导出共用同一帧路径（无 React / 无 DOM 挂载），保证像素一致。
import type { LyricLine } from "@applemusic-like-lyrics/core";
import type { AdmMetadata } from "../types";
import { AtmosRenderer } from "../atmos/renderer";
import { findActiveLine, drawLyricLine } from "./lyric";

export interface StageMeta {
  title: string;
  artist: string;
  album?: string;
}

const W = 1920;
const H = 1080;

const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', 'Noto Sans SC', sans-serif";
const TITLE_FONT = `bold 34px ${FONT_STACK}`;
const ARTIST_FONT = `22px ${FONT_STACK}`;
const TIME_FONT = `18px ${FONT_STACK}`;
const LABEL_FONT = `16px ${FONT_STACK}`;
const EMPTY_FONT = `18px ${FONT_STACK}`;

const BADGE_TEXT = "DOLBY ATMOS";
const BADGE_GAP = 2; // 手动字距（px）

// 歌词入场动画时长：基于 timeMs，导出/预览同帧同结果
const LYRIC_ANIM_MS = 250;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

// roundRect 在旧浏览器缺失时的类型逃生口（不用 any）
type RoundRectFn = (x: number, y: number, w: number, h: number, radii?: number) => void;

type CoverSource = HTMLImageElement | HTMLVideoElement;

export class StageRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly bgCanvas: HTMLCanvasElement;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly atmos: AtmosRenderer;

  private cover: CoverSource | null = null;
  private lines: LyricLine[] = [];
  private adm: AdmMetadata | null = null;
  private title = "";
  private artist = "";
  private timeMs = 0;
  private durationMs = 0;
  private playing = false;

  // 歌词动画状态：索引变化时以 timeMs 重置，保证确定性
  private lastLineIndex = -1;
  private lineChangeMs = 0;

  // AMLL 流体背景画布：找到后缓存，未找到时最多每秒重试一次
  private bgEl: HTMLCanvasElement | null = null;
  private lastBgLookup = Number.NEGATIVE_INFINITY;

  // 静态资源缓存（跨帧复用）
  private readonly darkGradient: CanvasGradient;
  private readonly badgeMetrics = new Map<string, { widths: number[]; total: number }>();
  private titleWidth = 0;

  // 懒解析的圆角矩形路径能力
  private roundRectFn: RoundRectFn | null = null;
  private roundRectResolved = false;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = W;
    this.canvas.height = H;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("StageRenderer: 2D canvas context unavailable");
    this.ctx = ctx;

    this.bgCanvas = document.createElement("canvas");
    this.bgCanvas.width = W;
    this.bgCanvas.height = H;

    this.atmos = new AtmosRenderer(640, 520);

    this.darkGradient = ctx.createLinearGradient(0, 0, 0, H);
    this.darkGradient.addColorStop(0, "#1a1a1f");
    this.darkGradient.addColorStop(1, "#0a0a0d");
  }

  setCover(img: CoverSource | null): void {
    this.cover = img;
  }

  setLyricLines(lines: LyricLine[]): void {
    this.lines = lines;
  }

  setAdm(meta: AdmMetadata | null): void {
    this.adm = meta;
    this.atmos.setObjects(meta ? meta.objects : []);
  }

  setMeta(meta: StageMeta): void {
    this.title = meta.title ?? "";
    this.artist = meta.artist ?? "";
    // 标题宽度只随标题变化：缓存，供徽标定位复用
    const ctx = this.ctx;
    ctx.save();
    ctx.font = TITLE_FONT;
    this.titleWidth = ctx.measureText(this.title).width;
    ctx.restore();
  }

  setTime(currentTimeMs: number): void {
    this.timeMs = currentTimeMs;
    this.atmos.setTime(currentTimeMs);
  }

  setPlaying(playing: boolean): void {
    // v1 不驱动补间；仅记录，暂停时 render() 仍输出正确静态帧
    this.playing = playing;
  }

  setDuration(ms: number): void {
    this.durationMs = ms;
  }

  render(): void {
    const ctx = this.ctx;
    const timeMs = this.timeMs;

    this.drawBackground(ctx);
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(0, 0, W, H);

    this.drawCover(ctx);

    const idx = findActiveLine(this.lines, timeMs);
    if (idx !== this.lastLineIndex) {
      this.lastLineIndex = idx;
      this.lineChangeMs = timeMs;
    }
    const progress = clamp((timeMs - this.lineChangeMs) / LYRIC_ANIM_MS, 0, 1);
    drawLyricLine(
      ctx,
      idx >= 0 ? this.lines[idx] : null,
      timeMs,
      { x: 110, y: 830, maxWidth: 900 },
      { progress },
    );

    this.drawAtmosPanel(ctx);

    // 5a 封面下
    this.drawAtmosBadge(ctx, 110, 580, "left");
    // 5b 标题块右侧（小号，视觉中心对齐标题基线）
    this.drawAtmosBadge(ctx, 110 + this.titleWidth + 18, 884, "left", 12);
    // 5c 进度条下（右对齐，让开右下角总时长文本）
    this.drawAtmosBadge(ctx, 1700, 1008, "right");

    this.drawInfoBar(ctx);
  }

  dispose(): void {
    this.atmos.dispose();
    this.cover = null;
    this.lines = [];
    this.adm = null;
    this.bgEl = null;
  }

  // ---- 绘制分块 ----

  private drawBackground(ctx: CanvasRenderingContext2D): void {
    const bg = this.findBgCanvas();
    if (bg) {
      ctx.drawImage(bg, 0, 0, W, H);
      return;
    }

    const cover = this.cover;
    if (cover && this.coverReady(cover)) {
      ctx.save();
      ctx.filter = "blur(80px)";
      ctx.drawImage(cover, -60, -60, W + 120, H + 120);
      ctx.restore();
      ctx.filter = "none";
      return;
    }

    ctx.fillStyle = this.darkGradient;
    ctx.fillRect(0, 0, W, H);
  }

  private drawCover(ctx: CanvasRenderingContext2D): void {
    const x = 110;
    const y = 210;
    const size = 340;
    const radius = 24;
    const cover = this.cover;
    const ready = cover !== null && this.coverReady(cover);

    // 阴影 + 底：无封面时这里就是最终外观
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 18;
    ctx.fillStyle = ready ? "#000000" : "rgba(255,255,255,0.10)";
    ctx.beginPath();
    this.roundRectPath(x, y, size, size, radius);
    ctx.fill();
    ctx.restore();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowColor = "rgba(0,0,0,0)";

    if (!ready || !cover) return;

    ctx.save();
    ctx.beginPath();
    this.roundRectPath(x, y, size, size, radius);
    ctx.clip();
    const src = this.coverSourceRect(cover);
    ctx.drawImage(cover, src.sx, src.sy, src.sw, src.sh, x, y, size, size);
    ctx.restore();
  }

  private drawAtmosPanel(ctx: CanvasRenderingContext2D): void {
    const x = 1120;
    const y = 250;
    const w = 680;
    const h = 560;
    const radius = 20;

    ctx.save();
    ctx.beginPath();
    this.roundRectPath(x, y, w, h, radius);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.font = LABEL_FONT;
    ctx.fillText("Dolby Atmos 空间摆位", 1140, 285);

    if (this.adm) {
      ctx.beginPath();
      this.roundRectPath(x, y, w, h, radius);
      ctx.clip();
      this.atmos.render();
      ctx.drawImage(this.atmos.canvas, 1140, 310, 640, 520);
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.font = EMPTY_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("未检测到 ADM 空间音频", x + w / 2, y + h / 2);
    }
    ctx.restore();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  private drawInfoBar(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";

    ctx.fillStyle = "#ffffff";
    ctx.font = TITLE_FONT;
    ctx.fillText(this.title, 110, 880);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = ARTIST_FONT;
    ctx.fillText(this.artist, 110, 912);

    const duration = this.effectiveDuration();
    const ratio = duration > 0 ? clamp(this.timeMs / duration, 0, 1) : 0;
    const trackX = 110;
    const trackW = 1700; // 110 → 1810
    const trackY = 980;
    const trackH = 4;

    ctx.fillStyle = "rgba(255,255,255,0.2)";
    this.fillRoundBar(ctx, trackX, trackY, trackW, trackH);
    if (ratio > 0) {
      ctx.fillStyle = "#ffffff";
      this.fillRoundBar(ctx, trackX, trackY, Math.max(trackH, trackW * ratio), trackH);
    }

    ctx.font = TIME_FONT;
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.textAlign = "left";
    ctx.fillText(formatTime(this.timeMs), 110, 1008);
    ctx.textAlign = "right";
    ctx.fillText(duration > 0 ? formatTime(duration) : "--:--", 1810, 1008);
    ctx.restore();
    ctx.textAlign = "left";
  }

  // letterspaced "DOLBY ATMOS"（可选双 D 标记）。align 决定 x 是左缘还是右缘。
  private drawAtmosBadge(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    align: "left" | "right",
    size = 14,
  ): void {
    const font = `bold ${size}px ${FONT_STACK}`;
    const metrics = this.measureBadge(ctx, font);
    const markH = size * 0.72;
    const markW = markH * 2;
    const markGap = size * 0.5;
    const totalW = markW + markGap + metrics.total;
    const startX = align === "right" ? x - totalW : x;

    ctx.save();
    ctx.font = font;
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    this.drawDoubleD(ctx, startX, y - markH, markH);

    let cursor = startX + markW + markGap;
    for (let i = 0; i < BADGE_TEXT.length; i += 1) {
      ctx.fillText(BADGE_TEXT[i], cursor, y);
      cursor += metrics.widths[i] + BADGE_GAP;
    }
    ctx.restore();
  }

  // 双 D 标记：两段相背的半圆弧描边（极简示意）
  private drawDoubleD(ctx: CanvasRenderingContext2D, x: number, top: number, h: number): void {
    const r = h / 2;
    const cy = top + r;
    ctx.save();
    ctx.lineWidth = Math.max(1, h * 0.16);
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.beginPath();
    ctx.arc(x + r, cy, r, Math.PI / 2, Math.PI * 1.5, false);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + r * 3, cy, r, -Math.PI / 2, Math.PI / 2, false);
    ctx.stroke();
    ctx.restore();
  }

  // ---- 小工具 ----

  private findBgCanvas(): HTMLCanvasElement | null {
    if (this.bgEl && this.bgEl.isConnected) return this.bgEl;
    const now = performance.now();
    if (now - this.lastBgLookup < 1000) return this.bgEl;
    this.lastBgLookup = now;
    // ponytail: AMLL 背景画布靠 DOM 查询获取；React 重挂载后会命中缓存/重查
    this.bgEl = this.bgCanvas.parentElement?.querySelector("canvas") ?? null;
    return this.bgEl;
  }

  private coverReady(cover: CoverSource): boolean {
    const w = cover instanceof HTMLVideoElement ? cover.videoWidth : cover.naturalWidth;
    const h = cover instanceof HTMLVideoElement ? cover.videoHeight : cover.naturalHeight;
    return w > 0 && h > 0;
  }

  private coverSourceRect(cover: CoverSource): { sx: number; sy: number; sw: number; sh: number } {
    const w = cover instanceof HTMLVideoElement ? cover.videoWidth : cover.naturalWidth;
    const h = cover instanceof HTMLVideoElement ? cover.videoHeight : cover.naturalHeight;
    const side = Math.min(w, h);
    return { sx: (w - side) / 2, sy: (h - side) / 2, sw: side, sh: side };
  }

  private effectiveDuration(): number {
    if (this.durationMs > 0) return this.durationMs;
    const last = this.lines[this.lines.length - 1];
    return last && last.endTime > 0 ? last.endTime : 0;
  }

  private measureBadge(
    ctx: CanvasRenderingContext2D,
    font: string,
  ): { widths: number[]; total: number } {
    const cached = this.badgeMetrics.get(font);
    if (cached) return cached;
    ctx.save();
    ctx.font = font;
    const widths = Array.from(BADGE_TEXT, (ch) => ctx.measureText(ch).width);
    ctx.restore();
    const total = widths.reduce((a, b) => a + b, 0) + BADGE_GAP * (BADGE_TEXT.length - 1);
    const metrics = { widths, total };
    this.badgeMetrics.set(font, metrics);
    return metrics;
  }

  private fillRoundBar(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    ctx.beginPath();
    this.roundRectPath(x, y, w, h, h / 2);
    ctx.fill();
  }

  // 圆角矩形路径：优先原生 roundRect，缺失时用 arcTo 手绘。
  // 调用方负责先 beginPath()。
  private roundRectPath(x: number, y: number, w: number, h: number, r: number): void {
    if (!this.roundRectResolved) {
      this.roundRectResolved = true;
      const native = (this.ctx as unknown as { roundRect?: RoundRectFn }).roundRect;
      this.roundRectFn = typeof native === "function" ? native.bind(this.ctx) : null;
    }
    if (this.roundRectFn) {
      this.roundRectFn(x, y, w, h, r);
      return;
    }
    const ctx = this.ctx;
    const rad = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }
}
