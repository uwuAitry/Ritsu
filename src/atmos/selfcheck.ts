// 摆位活动门控最小自检：无测试框架，assert 抛错即失败。
// 覆盖两块纯逻辑：chna chunk 解析（声道绑定）与 visibilityAt（可见度谓词）。
// 均不触碰 DOM，可在 CI 的裸 Node 下运行。

import { parseChnaChunk } from "../adm/parse";
import { visibilityAt } from "./activity";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("atmos selfcheck failed: " + msg);
}

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

// 合成 chna：ADMType=1 / numTrackUIDs=2 / numTracks=12 / numProgrammes=1，
// 条目 0：trackIndex=1 + "ATU_00000001"；条目 1：trackIndex=3 + "ATU_00000003"
function buildChna(): ArrayBuffer {
  const entrySize = 2 + 32 * 3;
  const bytes = new Uint8Array(8 + 2 * entrySize);
  const dv = new DataView(bytes.buffer);
  dv.setUint16(0, 1, true);
  dv.setUint16(2, 2, true);
  dv.setUint16(4, 12, true);
  dv.setUint16(6, 1, true);
  const put = (slot: number, trackIndex: number, uid: string): void => {
    const base = 8 + slot * entrySize;
    dv.setUint16(base, trackIndex, true);
    for (let k = 0; k < uid.length; k++) bytes[base + 2 + k] = uid.charCodeAt(k);
  };
  put(0, 1, "ATU_00000001");
  put(1, 3, "ATU_00000003");
  return bytes.buffer;
}

export function runSelfCheck(): void {
  // chna 绑定：UID → 0 基声道号
  const chna = buildChna();
  const map = parseChnaChunk(chna, 0, chna.byteLength);
  assert(map.get("ATU_00000001") === 0, "chna ATU_00000001 → ch0");
  assert(map.get("ATU_00000003") === 2, "chna ATU_00000003 → ch2");
  assert(!map.has("ATU_00000002"), "chna 未列出的 UID 不存在");
  // 截断声明：numTrackUIDs=99 但数据只有 2 条 → 空 Map（软失败回落 trackIndex）
  const dv = new DataView(chna);
  dv.setUint16(2, 99, true);
  assert(parseChnaChunk(chna, 0, chna.byteLength).size === 0, "chna 截断 → 空 Map");

  // 可见度谓词：窗长 100ms；时间线 = 发声 1 窗后静音（stopMs = 100）
  const tl = new Uint8Array([1, 0, 0, 0, 0]);
  assert(visibilityAt(null, 12345, 2000) === 1, "无时间线 → 始终可见");
  assert(visibilityAt(tl, 50, 2000) === 1, "发声中 → 1");
  assert(visibilityAt(tl, 250, 2000) === 1, "静音未满延迟 → 1");
  assert(approx(visibilityAt(tl, 250, 100), 1 - 50 / 300), "静音超过延迟 → 淡出中");
  assert(visibilityAt(tl, 1000, 100) === 0, "淡出完成 → 0");
  assert(approx(visibilityAt(tl, 250, 0), 1 - 150 / 300), "延迟 0：静音当帧进入淡出带");
  assert(visibilityAt(tl, 400, 0) === 0, "延迟 0：淡出带末端 → 0");

  // 从未发声：整条时间线全 0
  const never = new Uint8Array([0, 0, 0]);
  assert(visibilityAt(never, 100, 2000) === 0, "从未发声 → 0");

  // 重新发声立即恢复（无视前一窗的淡出进度）
  const re = new Uint8Array([1, 0, 1, 0]);
  assert(visibilityAt(re, 250, 0) === 1, "重新发声立即 → 1");

  // 越界时间按末窗钳制（音频结束后维持最后状态）
  assert(visibilityAt(tl, 99999, 100) === 0, "越界钳制末窗静音 → 0");
  const tailActive = new Uint8Array([0, 1]);
  assert(visibilityAt(tailActive, 99999, 0) === 1, "越界钳制末窗发声 → 1");
}
