// 歌词逐词布局最小自检：无测试框架，assert 抛错即失败。
// 运行方式（浏览器控制台 / Node>=18）：
//   import { runSelfCheck } from "./src/render/selfcheck"; runSelfCheck();
// 只驱动 layoutWords 纯排版逻辑；render/lyric 对 AMLL 的引用是 import type，编译后不留运行时依赖。

import { layoutWords } from "./lyric";

// 从 layoutWords 签名推导词类型，免去引入 AMLL 包。
type LyricWord = Parameters<typeof layoutWords>[1][number];

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("render lyric selfcheck failed: " + msg);
}

// 桩 2D 上下文：measureText 返回文本长度，空格恰为 1 单位，缺/多一个 gap 都能一眼看出。
function stubCtx(): CanvasRenderingContext2D {
  return {
    measureText: (t: string) => ({ width: t.length }),
  } as unknown as CanvasRenderingContext2D;
}

function word(text: string): LyricWord {
  return { word: text, startTime: 0, endTime: 0 };
}

// 各 box 文本从左到右拼接，验证整行“读起来”的文本。
function joined(res: ReturnType<typeof layoutWords>): string {
  return res.boxes.map((b) => b.text).join("");
}

// 相邻 box 实际间隙（本 box.x − 上一 box 右缘）；0 即无合成空格。
function gap(boxes: { x: number; width: number }[], i: number): number {
  return boxes[i].x - (boxes[i - 1].x + boxes[i - 1].width);
}

export function runSelfCheck(): void {
  const ctx = stubCtx();

  // 1. TTML 词级：尾随空格已写进文本，不得再补（否则双重计宽）。
  //    "Hello " 宽 6（含空格），"world" 紧跟其后，推进量 = 文本自身宽度，无额外 gap。
  const wordLevel = layoutWords(ctx, [word("Hello "), word("world")], 0);
  assert(wordLevel.boxes[0].text === "Hello ", "word-level box0 text");
  assert(wordLevel.boxes[0].x === 0, "word-level box0 x");
  assert(wordLevel.boxes[1].text === "world", "word-level box1 text");
  assert(wordLevel.boxes[1].x === 6, `word-level box1 x=${wordLevel.boxes[1].x}, want 6`);
  assert(
    wordLevel.boxes[1].x === wordLevel.boxes[0].width,
    "word-level advance = own text width, no extra gap",
  );
  assert(wordLevel.total === 11, `word-level total=${wordLevel.total}, want 11`);

  // 2. TTML 逐字：相邻单字素不插空格，整行读作 "Hello world"（不是 "H e l l o  w..."）。
  const perChar = layoutWords(
    ctx,
    ["H", "e", "l", "l", "o ", "w", "o", "r", "l", "d"].map(word),
    0,
  );
  assert(perChar.boxes[0].x === 0, "per-char box0 x");
  for (let i = 1; i < perChar.boxes.length; i += 1) {
    assert(gap(perChar.boxes, i) === 0, `per-char gap before box ${i} should be 0`);
  }
  assert(joined(perChar) === "Hello world", `per-char joined="${joined(perChar)}"`);

  // 3. TTML 逐字 + 短词：分隔空格挂在 box 文本里（"I " / "m "），去空白后仍是单字素。
  const shortWord = layoutWords(ctx, ["I ", "a", "m ", "h", "e", "r", "e"].map(word), 0);
  for (let i = 1; i < shortWord.boxes.length; i += 1) {
    assert(gap(shortWord.boxes, i) === 0, `short-word gap before box ${i} should be 0`);
  }
  assert(joined(shortWord) === "I am here", `short-word joined="${joined(shortWord)}"`);

  // 4. CJK 逐字：任意相邻单字素之间都不插空格。
  const cjk = layoutWords(ctx, ["你", "好", "世"].map(word), 0);
  for (let i = 1; i < cjk.boxes.length; i += 1) {
    assert(gap(cjk.boxes, i) === 0, `cjk gap before box ${i} should be 0`);
  }
  assert(joined(cjk) === "你好世", `cjk joined="${joined(cjk)}"`);

  // 5. 词级无尾随空格（YRC / ESLrc 无空格形态）：合成一个空格宽仍要保留，不得回归。
  const noTrailing = layoutWords(ctx, [word("Hello"), word("world")], 0);
  assert(noTrailing.boxes[1].x === 6, `no-trailing box1 x=${noTrailing.boxes[1].x}, want 6`);
  assert(
    noTrailing.boxes[1].x === noTrailing.boxes[0].width + 1,
    "no-trailing must insert exactly one space-width gap",
  );

  // 6. 单 box（普通 LRC 形态）：贴住起点，不涉及任何 gap 逻辑。
  const single = layoutWords(ctx, [word("alone")], 0);
  assert(single.boxes.length === 1, "single box count");
  assert(single.boxes[0].x === 0, "single box x");
  assert(single.total === 5, `single total=${single.total}, want 5`);
}
