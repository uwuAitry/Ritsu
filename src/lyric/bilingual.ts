// 双语 LRC 合并：把「同一时间戳、文本不同」的相邻两行识别为 原词 + 翻译，
// 后一行写进前一行的 translatedLyric，交给渲染层（src/render/lyric.ts）显示。
// QQ/网易云导出的双语歌词与手传双语 LRC 都是这种「一行原词、一行译文、时间戳相同」的写法。
// AMLL TTML 自带 <translation>，不经这里。
//
// 本模块刻意不 import 任何运行时依赖（LyricLine 仅 import type，编译后擦除），
// 因此能在 Node CommonJS 下自检——src/lyric/load.ts 顶层引 AMLL 的 ESM 包，无法在 Node 跑。
import type { LyricLine } from "@applemusic-like-lyrics/core";

function lineText(line: LyricLine): string {
  return (line.words ?? []).map((w) => w.word ?? "").join("").trim();
}

// ponytail: 只按「同一时间戳 + 文本不同 + 上一行尚无译文」判定，不辨语种。
// 若某 LRC 真的在同一时刻排了两句原词（罕见，如合唱），会被误并成译文——可接受。
export function mergeBilingualLrc(lines: LyricLine[]): LyricLine[] {
  const out: LyricLine[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const cur = lineText(line);
    if (
      prev &&
      line.startTime === prev.startTime &&
      cur.length > 0 &&
      cur !== lineText(prev) &&
      !prev.translatedLyric
    ) {
      prev.translatedLyric = cur;
      continue;
    }
    out.push(line);
  }

  // 合并会删掉一行，重算 endTime：每行到下一行开始为止，末行保持原末尾（parseLrc 末行是 MAX）。
  // 不重算的话，被合并的译文行会把上一行 endTime 压成 0 时长，导致原词几乎不显示。
  let tailEnd = 0;
  for (const line of lines) if (Number.isFinite(line.endTime)) tailEnd = Math.max(tailEnd, line.endTime);
  for (let i = 0; i < out.length; i += 1) {
    const next = out[i + 1];
    const end = next ? next.startTime : tailEnd;
    if (end > out[i].startTime) {
      out[i].endTime = end;
      for (const w of out[i].words ?? []) if (w.endTime < end) w.endTime = end;
    }
  }
  return out;
}

export function runSelfCheck(): void {
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(`bilingual self-check failed: ${msg}`);
  };
  const ln = (t: number, text: string): LyricLine =>
    ({
      startTime: t,
      endTime: t,
      words: [{ word: text, startTime: t, endTime: t }],
      translatedLyric: "",
      romanLyric: "",
      isBG: false,
      isDuet: false,
    }) as LyricLine;

  // 1) 双语：同时间戳两行合并，行数减半，译文进 translatedLyric，endTime 重算正确
  const bi = mergeBilingualLrc([ln(0, "Hello"), ln(0, "你好"), ln(5000, "World"), ln(5000, "世界")]);
  assert(bi.length === 2, "bilingual row count");
  assert(bi[0].translatedLyric === "你好", "line0 translation");
  assert(bi[1].translatedLyric === "世界", "line1 translation");
  assert(bi[0].endTime === 5000, "line0 endTime recomputed");
  assert(bi[1].endTime === 5000, "line1 endTime kept");

  // 2) 普通 LRC（时间戳唯一）无副作用
  const mono = mergeBilingualLrc([ln(0, "a"), ln(1000, "b")]);
  assert(mono.length === 2 && !mono[0].translatedLyric && !mono[1].translatedLyric, "mono untouched");
  assert(mono[0].endTime === 1000, "mono endTime");

  // 3) 只差一行：原文 + 末行译文（译文是最后一行）
  const tail = mergeBilingualLrc([ln(0, "Hi"), ln(0, "嗨"), ln(3000, "Bye")]);
  assert(tail.length === 2 && tail[0].translatedLyric === "嗨", "tail translation");
  assert(tail[1].endTime === 3000 && !tail[1].translatedLyric, "tail last untouched");
}
