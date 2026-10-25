// 对象发声活动门控（纯逻辑，无 DOM，可在 Node 自检）：
// 输入是解码期产出的逐声道活动位图（wav.ts，100ms 一窗，见 types.ACTIVITY_WINDOW_MS），
// 输出是“此刻该对象可见度 0..1”。时间线只读，「最后活动窗」推导表按时间线缓存（WeakMap）。

import { ACTIVITY_WINDOW_MS } from "../types";

// 停止发声后的淡出时长：延迟到期不至于让对象啪一下消失
export const ACTIVITY_FADE_MS = 300;

// lastActiveIdx[i] = ≤ i 的最后一个活动窗下标（无则 -1）；每条时间线只推导一次
const lastActiveCache = new WeakMap<Uint8Array, Int32Array>();

function lastActiveIndexTable(timeline: Uint8Array): Int32Array {
  const cached = lastActiveCache.get(timeline);
  if (cached) return cached;
  const table = new Int32Array(timeline.length);
  let last = -1;
  for (let i = 0; i < timeline.length; i += 1) {
    // 时间线是量化强度（0..255），非零即发声
    if (timeline[i] > 0) last = i;
    table[i] = last;
  }
  lastActiveCache.set(timeline, table);
  return table;
}

/** 时间线在 tMs 所在窗是否发声；越界按末窗钳制（音频结束后维持最后状态）。 */
export function isActiveAt(
  timeline: Uint8Array,
  tMs: number,
  windowMs: number = ACTIVITY_WINDOW_MS,
): boolean {
  const i = Math.min(Math.max(Math.floor(tMs / windowMs), 0), timeline.length - 1);
  return timeline[i] > 0;
}

/** 可见度 0..1：发声 → 1；停止发声后 delayMs 内保持 1，随后 ACTIVITY_FADE_MS 线性淡出；
 *  从未发声 → 0；无时间线（绑定未知 / 门控关闭）→ 1。 */
export function visibilityAt(
  timeline: Uint8Array | null,
  tMs: number,
  delayMs: number,
  windowMs: number = ACTIVITY_WINDOW_MS,
): number {
  if (!timeline || timeline.length === 0) return 1;
  const i = Math.min(Math.max(Math.floor(tMs / windowMs), 0), timeline.length - 1);
  if (timeline[i] > 0) return 1;
  const last = lastActiveIndexTable(timeline)[i];
  if (last < 0) return 0; // 从未发声
  const silenceMs = tMs - (last + 1) * windowMs;
  if (silenceMs <= delayMs) return 1;
  const faded = 1 - (silenceMs - delayMs) / ACTIVITY_FADE_MS;
  return faded <= 0 ? 0 : faded >= 1 ? 1 : faded;
}

/**
 * 发声强度 0..1：时间线里每个窗存的是量化 RMS（wav.ts），不是二值。
 * 没有时间线（非 ADM / 未知声道）时返回 1，调用方据此做成静态外观。
 * 只读当前窗，不做跨窗插值——仍是 timeMs 的纯函数。
 */
export function levelAt(
  timeline: Uint8Array | null,
  tMs: number,
  windowMs: number = ACTIVITY_WINDOW_MS,
): number {
  if (!timeline || timeline.length === 0) return 1;
  const i = Math.min(Math.max(Math.floor(tMs / windowMs), 0), timeline.length - 1);
  return timeline[i] / 255;
}
