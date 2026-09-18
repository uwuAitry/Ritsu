import type { LyricLine } from "@applemusic-like-lyrics/core";

// 单行歌词渲染：左下角锚定、逐词渐进填充。
// 自定义布局，不使用 AMLL 的多行播放器组件；只画一行，调用方负责选行与动画进度。

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

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
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

// 依赖调用方已设置 ctx.font；按词左到右排布，词间仅一个空格宽。
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
    if (boxes.length > 0) cursor += spaceWidth;
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

  // 行末 250ms 淡出。
  // ponytail: drawLyricLine 只拿到单行，无法判断“是否最后一行”；用 endTime === Infinity 近似
  // （Infinity 时该判断自然为 false，不淡出）。需要精确区分时由调用方在外部再压一层 alpha。
  const fade = timeMs > line.endTime - FADE_MS ? clamp01((line.endTime - timeMs) / FADE_MS) : 1;
  const slide = (1 - progress) * SLIDE_DISTANCE;
  const baseline = layout.y + slide;

  ctx.globalAlpha = progress * fade;
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 2;

  for (const box of boxes) {
    const word = box.word;
    const dur = word.endTime - word.startTime;
    // 零长 / 非数时长 → 视为已唱完，避免除零
    const f = !Number.isFinite(dur) || dur <= 0 ? 1 : clamp01((timeMs - word.startTime) / dur);

    if (f >= 1) {
      ctx.fillStyle = baseColor;
      ctx.fillText(box.text, box.x, baseline);
    } else if (f <= 0) {
      ctx.fillStyle = DIM;
      ctx.fillText(box.text, box.x, baseline);
    } else {
      // 先画暗底，再用硬停渐变盖住已唱部分
      ctx.fillStyle = DIM;
      ctx.fillText(box.text, box.x, baseline);
      if (box.width > 0) {
        const g = ctx.createLinearGradient(box.x, 0, box.x + box.width, 0);
        g.addColorStop(clamp01(f - 0.001), DIM);
        g.addColorStop(clamp01(f + 0.001), baseColor);
        ctx.fillStyle = g;
        ctx.fillText(box.text, box.x, baseline);
      }
      ctx.fillStyle = baseColor; // 复位，避免渐变泄漏到下一词
    }
  }

  const translation = line.translatedLyric;
  if (translation && translation.length > 0) {
    ctx.font = `normal ${TRANSLATION_SIZE}px ${FONT_FAMILY}`;
    ctx.fillStyle = TRANSLATION_COLOR;
    ctx.fillText(translation, layout.x, layout.y + TRANSLATION_OFFSET + slide);
  }

  ctx.globalAlpha = 1;
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}
