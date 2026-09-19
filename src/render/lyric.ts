import type { LyricLine } from "@applemusic-like-lyrics/core";

// 单行歌词渲染：左下角锚定。
// 自定义布局，不使用 AMLL 的多行播放器组件；只画一行，调用方负责选行与动画进度。
// 填充规则：仅当一行真有多个已计时词（>1 个有效 box）时才逐词渐进填充；
// 单词语句（如 LRC 的 parseLrc 每行只产出一个词）整行保持基色，不做左到右擦除。
// 调用方可用 options.wordByWord 显式开关：false 强制关闭，true 在有可用渐变时启用，未传则自动。
// 动画对齐 AMLL DOM 播放器（遮罩 + Web Animations，无 Pixi）：羽化扫描、强调词白光、入场弹簧缩放。

type LyricWord = LyricLine["words"][number];

export interface LyricLayout {
  x: number;
  y: number;
  maxWidth: number;
}

const FONT_FAMILY =
  '-apple-system, "SF Pro Display", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
const BASE_SIZE = 64;
const MIN_SIZE = 34;
const BG_SIZE_RATIO = 0.7;
const TRANSLATION_SIZE = 28;
const TRANSLATION_OFFSET = 42;
const SLIDE_DISTANCE = 22;
const FADE_MS = 250;
const DIM = "rgba(255,255,255,0.42)";
const BG_BASE = "rgba(255,255,255,0.75)";
const WHITE = "#fff";
const TRANSLATION_COLOR = "rgba(255,255,255,0.62)";

// 扫描羽化带宽度（em，相对行字号）。AMLL wordFadeWidth 默认 0.5；
// 首词 1.5×、末词 0.5×，让整行扫描像一条连续光带。
const WORD_FADE_WIDTH = 0.5;
const FIRST_WORD_FADE_MULT = 1.5;
const LAST_WORD_FADE_MULT = 0.5;
const CLEAR = "rgba(255,255,255,0)";

// 基础可读性投影（黑）+ 强调词白晕
const SHADOW_COLOR = "rgba(0,0,0,0.55)";
const SHADOW_BLUR = 12;
const SHADOW_OFFSET_Y = 2;
const GLOW_BLUR = 0.6; // → min(0.3, blur*0.3) = 0.18em 白晕
const GLOW_PERIOD_MS = 700; // glowLevel 呼吸周期
const EMPHASIS_MIN_MS = 1000; // 强调门槛：词时长 ≥ 1000ms
const RE_CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

// 入场弹簧：AMLL 活跃行 0.97 → 1.0
const SPRING_POP = { mass: 2, damping: 25, stiffness: 100 };
const POP_FROM = 0.97;
const POP_TO = 1;

interface SpringConfig {
  mass: number;
  stiffness: number;
  damping: number;
}

// 闭式阻尼谐振子求解器（Spring）。
// 移植自 pushkine（https://github.com/pushkine/spring），MIT License；AMLL utils/spring.ts 同源。
// 返回 t 秒时的位置；无迭代、无状态。
function springValue(p: SpringConfig, from: number, to: number, velocity: number, t: number): number {
  const w0 = Math.sqrt(p.stiffness / p.mass); // 无阻尼角频率
  const zeta = p.damping / (2 * Math.sqrt(p.stiffness * p.mass)); // 阻尼比
  const d = from - to;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const a = d;
    const b = (velocity + zeta * w0 * d) / wd;
    return to + (a * Math.cos(wd * t) + b * Math.sin(wd * t)) * Math.exp(-zeta * w0 * t);
  }
  if (zeta === 1) {
    return to + (d + (velocity + w0 * d) * t) * Math.exp(-w0 * t);
  }
  const wd = w0 * Math.sqrt(zeta * zeta - 1);
  const a = d;
  const b = (velocity + zeta * w0 * d) / wd;
  return to + (a * Math.cosh(wd * t) + b * Math.sinh(wd * t)) * Math.exp(-zeta * w0 * t);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// 单字素判断：逐字 TTML / CJK 每个 box 都是一字素，字间不得插空格。
// ponytail: 用码点近似字素簇；组合字符 / ZWJ emoji 极罕见，最多差一个空格宽。
function isSingleGrapheme(s: string): boolean {
  return s.length > 0 && Array.from(s).length === 1;
}

// 强调词门槛：时长 ≥ 1000ms；非 CJK 还要求去空白后 1 < 长度 ≤ 7（与 AMLL 一致）
function isEmphasized(word: LyricWord, timeMs: number): boolean {
  if (timeMs < word.startTime || timeMs > word.endTime) return false;
  const dur = word.endTime - word.startTime;
  if (!Number.isFinite(dur) || dur < EMPHASIS_MIN_MS) return false;
  const text = word.word ?? "";
  const len = text.trim().length;
  if (len === 0) return false;
  if (RE_CJK.test(text)) return true;
  return len > 1 && len <= 7;
}

// 白晕呼吸：0.2..0.9
function glowLevelAt(timeMs: number): number {
  return 0.55 + 0.35 * Math.sin((timeMs / GLOW_PERIOD_MS) * Math.PI * 2);
}

export function findActiveLine(lines: LyricLine[], timeMs: number): number {
  let containing = -1;
  let lastStarted = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.words || line.words.length === 0) continue; // 空词行直接跳过
    if (line.startTime <= timeMs) {
      lastStarted = i;
      if (timeMs <= line.endTime) containing = i;
    }
  }
  return containing !== -1 ? containing : lastStarted;
}

interface WordBox {
  text: string;
  word: LyricWord;
  x: number;
  width: number;
}

// 依赖调用方已设置 ctx.font；按词左到右排布。
// 空格规则：仅当上一词未自带尾随空白、且两词不同时为单字素时，才补一个空格宽。
function layoutWords(
  ctx: CanvasRenderingContext2D,
  words: LyricLine["words"],
  x: number,
): { boxes: WordBox[]; total: number } {
  const boxes: WordBox[] = [];
  const spaceWidth = ctx.measureText(" ").width;
  let cursor = x;
  for (const word of words) {
    const raw = word.word ?? "";
    if (raw.trim().length === 0) continue; // 纯空白词不占位
    const text = boxes.length === 0 ? raw.replace(/^\s+/, "") : raw; // 跳过行首空格
    if (text.length === 0) continue;
    if (boxes.length > 0) {
      const prev = boxes[boxes.length - 1];
      // 尾随空白已写进文本（measureText 已计宽），再补一次会双重计宽。
      const prevEndsWS = /\s$/.test(prev.text);
      // 逐字 TTML / CJK 每个 box 都是一字素，字间靠格式自身空白，不再插空格。
      // 判字素前先 trim：分隔空格可能挂在任一侧（如 "I " + "a" + "m "），
      // 只比原始文本会把 "m " 误判为非单字素而多插一个空格。
      const perCharRun =
        isSingleGrapheme(prev.text.trim()) && isSingleGrapheme(text.trim());
      if (!prevEndsWS && !perCharRun) cursor += spaceWidth;
    }
    const width = ctx.measureText(text).width;
    boxes.push({ text, word, x: cursor, width });
    cursor += width;
  }
  return { boxes, total: cursor - x };
}

export function drawLyricLine(
  ctx: CanvasRenderingContext2D,
  line: LyricLine | null,
  timeMs: number,
  layout: LyricLayout,
  anim: { progress: number },
  options?: { wordByWord?: boolean },
): void {
  if (!line) return;

  const progress = clamp01(anim.progress);
  const isBG = line.isBG === true;
  const baseColor = isBG ? BG_BASE : WHITE;
  const baseSize = BASE_SIZE * (isBG ? BG_SIZE_RATIO : 1);
  const words = line.words ?? [];

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // 两次测量：先按基准字号量总宽，超宽再等比缩字号（下限 MIN_SIZE），永不换行。
  ctx.font = `bold ${baseSize}px ${FONT_FAMILY}`;
  const measured = layoutWords(ctx, words, layout.x);
  let finalSize = baseSize;
  if (measured.total > layout.maxWidth && measured.total > 0) {
    finalSize = Math.max(MIN_SIZE, baseSize * (layout.maxWidth / measured.total));
  }
  ctx.font = `bold ${finalSize}px ${FONT_FAMILY}`;
  const { boxes } = layoutWords(ctx, words, layout.x);

  // 逐词填充开关：显式 options 优先，否则仅在多词行自动启用。
  const perWord = boxes.length > 1;
  const progressive = options?.wordByWord ?? perWord;

  // 行末 250ms 淡出。
  // ponytail: drawLyricLine 只拿到单行，无法判断“是否最后一行”；用 endTime === Infinity 近似
  // （Infinity 时该判断自然为 false，不淡出）。需要精确区分时由调用方在外部再压一层 alpha。
  const fade = timeMs > line.endTime - FADE_MS ? clamp01((line.endTime - timeMs) / FADE_MS) : 1;
  const slide = (1 - progress) * SLIDE_DISTANCE;
  const baseline = layout.y + slide;

  // 单盒绘制：非渐进整行基色；渐进时先铺暗底，再用羽化波段渐变盖住已唱部分。
  const paintBox = (box: WordBox, index: number): void => {
    const word = box.word;
    if (!progressive) {
      ctx.fillStyle = baseColor;
      ctx.fillText(box.text, box.x, baseline);
      return;
    }
    const dur = word.endTime - word.startTime;
    // 零长 / 非数时长 → 视为已唱完，避免除零
    const f = !Number.isFinite(dur) || dur <= 0 ? 1 : clamp01((timeMs - word.startTime) / dur);
    if (f >= 1) {
      ctx.fillStyle = baseColor;
      ctx.fillText(box.text, box.x, baseline);
      return;
    }
    if (f <= 0 || box.width <= 0) {
      ctx.fillStyle = DIM;
      ctx.fillText(box.text, box.x, baseline);
      return;
    }

    // 第一遍：整词暗底。
    ctx.fillStyle = DIM;
    ctx.fillText(box.text, box.x, baseline);

    // 第二遍：亮度梯度（亮部在左、暗部在右），中间 band 线性羽化。
    // 扫描前沿严格线性于时间（f 未加缓动），词间间隙停在原处，不逐词重置。
    const mult =
      index === 0
        ? FIRST_WORD_FADE_MULT
        : index === boxes.length - 1
          ? LAST_WORD_FADE_MULT
          : 1;
    const band = finalSize * WORD_FADE_WIDTH * mult;
    const front = box.x + f * box.width;
    const litEnd = clamp01((front - band - box.x) / box.width); // 亮区结束
    const dimStart = clamp01((front - box.x) / box.width); // 暗区开始
    const g = ctx.createLinearGradient(box.x, 0, box.x + box.width, 0);
    g.addColorStop(0, baseColor);
    if (litEnd > 0) g.addColorStop(litEnd, baseColor);
    g.addColorStop(dimStart, CLEAR);
    g.addColorStop(1, CLEAR);
    ctx.fillStyle = g;
    ctx.fillText(box.text, box.x, baseline);
    ctx.fillStyle = baseColor; // 复位，避免渐变泄漏到下一词
  };

  // 入场弹簧缩放（0.97 → 1.0）：以时间线性解，无补间状态。
  const anchorMs = Number.isFinite(line.startTime) ? line.startTime : timeMs;
  const elapsedSec = Math.max(0, (timeMs - anchorMs) / 1000);
  const scale = springValue(SPRING_POP, POP_FROM, POP_TO, 0, elapsedSec);

  ctx.save();
  ctx.globalAlpha = progress * fade;
  ctx.shadowColor = SHADOW_COLOR;
  ctx.shadowBlur = SHADOW_BLUR;
  ctx.shadowOffsetY = SHADOW_OFFSET_Y;
  // 以左下锚点为原点缩放：字顶轻抬，行尾不漂移。
  ctx.translate(layout.x, baseline);
  ctx.scale(scale, scale);
  ctx.translate(-layout.x, -baseline);

  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i];
    paintBox(box, i);

    // 强调词白光：同色重绘一遍，只多出一圈白晕；黑色投影仍作基础可读性保障。
    if (progressive && isEmphasized(box.word, timeMs)) {
      ctx.shadowColor = `rgba(255,255,255,${glowLevelAt(timeMs)})`;
      ctx.shadowBlur = Math.min(0.3, GLOW_BLUR * 0.3) * finalSize;
      ctx.shadowOffsetY = 0;
      paintBox(box, i);
      ctx.shadowColor = SHADOW_COLOR;
      ctx.shadowBlur = SHADOW_BLUR;
      ctx.shadowOffsetY = SHADOW_OFFSET_Y;
    }
  }

  const translation = line.translatedLyric;
  if (translation && translation.length > 0) {
    ctx.font = `normal ${TRANSLATION_SIZE}px ${FONT_FAMILY}`;
    ctx.fillStyle = TRANSLATION_COLOR;
    ctx.fillText(translation, layout.x, layout.y + TRANSLATION_OFFSET + slide);
  }

  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}
