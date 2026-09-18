// 最小自检：只验证格式探测，不依赖真实解析输出。
import { detectLyricFormat } from "./load";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`lyric self-check failed: ${msg}`);
}

export function runSelfCheck(): void {
  assert(detectLyricFormat("[00:01.00]hi") === "lrc", "lrc");
  assert(
    detectLyricFormat('<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"></tt>') ===
      "ttml",
    "ttml",
  );
  assert(detectLyricFormat("[1234,567]ab(0,100)cd(100,200)") === "yrc", "yrc");
}
