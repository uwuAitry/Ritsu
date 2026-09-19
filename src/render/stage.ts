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
const EMPTY_FONT = `18px ${FONT_STACK}`;

// ---- 构图常量（1920×1080）----
// 封面：左对齐 110–450，上缘 210 / 下缘 550。
// 下缘 550 距歌词字顶（约 784）留出阴影尾巴空间，且让开右侧空间面板。
const COVER_SIZE = 340;
const COVER_X = 110;
const COVER_Y = 210;
const COVER_RADIUS = 24;

// 空间视图离屏尺寸：与面板内的绘制区域（640×520）一致，drawImage 无变形
const ATMOS_W = 640;
const ATMOS_H = 520;

// 空间面板位置：横向靠右；纵向与封面中线对齐（380），面板自身也居中于此
const ATMOS_X = 1140;
const ATMOS_Y = COVER_Y + COVER_SIZE / 2 - ATMOS_H / 2; // 380 - 260 = 120

// 无 ADM 时的静默提示：画在空间面板正中
const EMPTY_TEXT = "未检测到 ADM 空间音频";

// 唯一 Dolby Atmos 徽标：信息条右端，与标题/歌手块同高（右侧留白，不压进度条）
const BADGE_URL =
  "https://d21buns5ku92am.cloudfront.net/68644/images/413934-Dolby%20Atmos%20Horizontal-015e44-large-1641853769.png";
const BADGE_W = 220;
const BADGE_RIGHT_X = 1810;
const BADGE_MID_Y = 886;

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

  // 远程徽标：只加载一次；badgeArt 非空即就绪
  private readonly badgeImg: HTMLImageElement;
  private badgeArt: HTMLCanvasElement | null = null;

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

    this.atmos = new AtmosRenderer(ATMOS_W, ATMOS_H);

    this.darkGradient = ctx.createLinearGradient(0, 0, 0, H);
    this.darkGradient.addColorStop(0, "#1a1a1f");
    this.darkGradient.addColorStop(1, "#0a0a0d");

    // 徽标：构造时发起一次（非阻塞，首帧不等它）。
    // crossOrigin 必带：CDN 返回 Access-Control-Allow-Origin: *，canvas 不被污染，captureStream 导出可用。
    const badge = new Image();
    badge.crossOrigin = "anonymous";
    badge.onload = () => this.bakeBadge(badge);
    badge.src = BADGE_URL;
    this.badgeImg = badge;
  }

  setCover(img: CoverSource | null): void {
    this.cover = img;
  }

  setLyricLines(lines: LyricLine[]): void {
    this.lines = lines;
  }

  setAdm(meta: AdmMetadata | null, channelActivity?: Uint8Array[] | null): void {
    this.adm = meta;
    this.atmos.setObjects(meta ? meta.objects : [], channelActivity);
  }

  /** 摆位对象活动门控：开关 + 消失延迟（透传 atmos；重绘由调用方负责） */
  setActivityOptions(opts: { enabled?: boolean; delayMs?: number }): void {
    this.atmos.setActivityOptions(opts);
  }

  setMeta(meta: StageMeta): void {
    this.title = meta.title ?? "";
    this.artist = meta.artist ?? "";
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

    // 背景栈：流体/模糊底 → 统一压暗的 scrim → 封面/歌词/空间面板/徽标/信息条
    // （空间面板画在 scrim 之上，对象不被压暗）
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
    this.drawBadge(ctx); // 保持单枚徽标

    this.drawInfoBar(ctx);
  }

  dispose(): void {
    this.atmos.dispose();
    this.cover = null;
    this.lines = [];
    this.adm = null;
    this.bgEl = null;
    // 卸载后图片才到货时不重绘（atmos 上下文已释放）；加载失败则一直走矢量兜底
    this.badgeImg.onload = null;
  }

  // ---- 绘制分块 ----

  private drawBackground(ctx: CanvasRenderingContext2D): void {
    // 背景全程涉及缩放（流体底充满画布 / 封面放大 + 模糊），统一走高质量重采样，
    // 退出时 restore 还原（ctx 跨帧复用，不能让状态泄漏到其它绘制）。
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    const bg = this.findBgCanvas();
    if (bg) {
      ctx.drawImage(bg, 0, 0, W, H);
      ctx.restore();
      return;
    }

    const cover = this.cover;
    if (cover && this.coverReady(cover)) {
      ctx.filter = "blur(80px)";
      ctx.drawImage(cover, -60, -60, W + 120, H + 120);
      ctx.restore();
      return;
    }

    ctx.fillStyle = this.darkGradient;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  private drawCover(ctx: CanvasRenderingContext2D): void {
    const x = COVER_X;
    const y = COVER_Y;
    const size = COVER_SIZE;
    const radius = COVER_RADIUS;
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
    // 封面按中心方裁后缩放；高质量重采样，restore 一并还原
    // ponytail: 源图 < 340px 时这里仍是放大，必然发软；接入上传校验/多档预缩放后再处理
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const src = this.coverSourceRect(cover);
    ctx.drawImage(cover, src.sx, src.sy, src.sw, src.sh, x, y, size, size);
    ctx.restore();
  }

  // 空间面板：无边框、无标签、无底色——摆位视图直接浮在流体背景上。
  // 不裁剪也不画圆角：Atmos 画布整幅透明（clearColor alpha=0）且对象远在边缘之内，
  // 圆角裁剪只会切到透明像素；边框没了，也没有需要圆角对齐的框。
  private drawAtmosPanel(ctx: CanvasRenderingContext2D): void {
    if (this.adm) {
      this.atmos.render();
      ctx.drawImage(this.atmos.canvas, ATMOS_X, ATMOS_Y, ATMOS_W, ATMOS_H);
      return;
    }

    // 无 ADM 时的静默提示：居中于摆位视图区域（ATMOS_X,ATMOS_Y 起 640×520）
    // 0.35 → 0.6：合成后约 6.4:1；0.35 在纯黑底上只有约 3:1，低于 AA
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = EMPTY_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(EMPTY_TEXT, ATMOS_X + ATMOS_W / 2, ATMOS_Y + ATMOS_H / 2);
    ctx.restore();
  }

  // 唯一徽标：远程 PNG，按原始比例绘制；未就绪的帧不画
  private drawBadge(ctx: CanvasRenderingContext2D): void {
    const art = this.badgeArt;
    if (!art) return;
    // art 已按显示尺寸烘焙，这里 1:1 落图（不再经过低质 3× 缩小）
    const h = BADGE_W * (art.height / art.width);
    ctx.drawImage(art, BADGE_RIGHT_X - BADGE_W, BADGE_MID_Y - h / 2, BADGE_W, h);
  }

  // 远程 PNG 是纯黑字形 + 透明底（浅色背景版本），直接画在暗舞台上等于隐形：
  // 就绪后一次性烘焙成白色剪影（source-in 只保留 alpha），原始字形与比例不变。
  // 关键：在这里就降到 drawBadge 实际使用的尺寸，让最终 drawImage 变成 1:1。
  // 若保留原始 665×95 再在 drawBadge 缩到 220 宽，等于每帧走一次 3× 低质缩放 → 徽标发糊。
  private bakeBadge(img: HTMLImageElement): void {
    const w = BADGE_W;
    // 与 drawBadge 的 h = BADGE_W * (h / w) 同一套比例，烘焙后公式依旧成立
    const h = Math.round(w * (img.naturalHeight / img.naturalWidth));
    if (img.naturalWidth === 0 || img.naturalHeight === 0 || h === 0) return;
    const art = document.createElement("canvas");
    art.width = w;
    art.height = h;
    const g = art.getContext("2d");
    if (!g) return;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(img, 0, 0, w, h);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, w, h);
    this.badgeArt = art;
    this.render(); // 就绪后立即重绘，不必等下一次状态变化
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
