// 摆位视图最小自检：无测试框架，assert 抛错即失败。
// 覆盖三块纯逻辑：chna chunk 解析（声道绑定）、visibilityAt（可见度谓词）、
// geometry（房间线框 / 取景 / 标记尺寸 / 轨迹采样 / 粒子）。
// 均不触碰 DOM，也不 import three，可在 CI 的裸 Node 下运行。

import { parseChnaChunk } from "../adm/parse";
import type { AdmKeyframe } from "../types";
import { visibilityAt } from "./activity";
import {
  boxRoomLines,
  boxRoomPoints,
  depthDimAt,
  fillParticles,
  fitDistanceForPoints,
  fitDistanceForRadius,
  isMovingTrack,
  markerWorldRadius,
  ndcExtent,
  sampleTrackAt,
  sphereRoomLines,
  sphereRoomPoints,
  trailSampleOffsets,
  trailWindowStart,
  updateParticles,
} from "./geometry";

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
  // ── chna 绑定：UID → 0 基声道号 ──
  const chna = buildChna();
  const map = parseChnaChunk(chna, 0, chna.byteLength);
  assert(map.get("ATU_00000001") === 0, "chna ATU_00000001 → ch0");
  assert(map.get("ATU_00000003") === 2, "chna ATU_00000003 → ch2");
  assert(!map.has("ATU_00000002"), "chna 未列出的 UID 不存在");
  // 截断声明：numTrackUIDs=99 但数据只有 2 条 → 空 Map（软失败回落 trackIndex）
  const dv = new DataView(chna);
  dv.setUint16(2, 99, true);
  assert(parseChnaChunk(chna, 0, chna.byteLength).size === 0, "chna 截断 → 空 Map");

  // ── 可见度谓词：窗长 100ms；时间线 = 发声 1 窗后静音（stopMs = 100） ──
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

  // ── 房间线框 ──
  const W = 1.75;
  const D = 1.5;
  const FLOOR = -1;
  const TOP = 1;
  const HALF_H = (TOP - FLOOR) / 2;
  const box = boxRoomLines(W, D, 7, 6, FLOOR, TOP);
  // 地板：8 条沿 x 的竖线 + 7 条沿 z 的横线；墙：5 段 → 共 20 段
  assert(box.length === 20 * 6, "盒形线框段数 = 8 + 7 + 5 = 20");
  let boxHeightsOk = true;
  for (let i = 1; i < box.length; i += 3) {
    if (box[i] !== FLOOR && box[i] !== TOP) boxHeightsOk = false;
  }
  assert(boxHeightsOk, "盒形线框只落在两个高度上（地板 / 顶边）");
  let boxOnGrid = true;
  for (let i = 0; i < box.length; i += 3) {
    const gi = (box[i] + W) / ((2 * W) / 7);
    if (Math.abs(gi - Math.round(gi)) > 1e-9) boxOnGrid = false;
  }
  assert(boxOnGrid, "盒形线框 x 落在 7 等分格线上");

  const corners = boxRoomPoints(W, D, FLOOR, TOP);
  assert(corners.length === 24, "盒形取景点 = 8 角点");
  const cornerR = Math.hypot(W, HALF_H, D);
  let cornersOk = true;
  for (let i = 0; i < corners.length; i += 3) {
    if (!approx(Math.hypot(corners[i], corners[i + 1], corners[i + 2]), cornerR, 1e-9)) {
      cornersOk = false;
    }
  }
  assert(cornersOk, "角点到原点距离 = √(w²+h²+d²)");

  const R = 1.8;
  const globe = sphereRoomLines(R, 8, 3);
  assert(globe.lines.length > 0 && globe.lines.length % 6 === 0, "球形线框成对端点");
  let onSphere = true;
  for (let i = 0; i < globe.lines.length; i += 3) {
    if (!approx(Math.hypot(globe.lines[i], globe.lines[i + 1], globe.lines[i + 2]), R, 1e-9)) {
      onSphere = false;
    }
  }
  assert(onSphere, "球形线框顶点全部落在球面上");
  assert(globe.equator.length > 0, "赤道单独成组");
  let equatorOk = true;
  for (let i = 1; i < globe.equator.length; i += 3) {
    if (!approx(globe.equator[i], 0, 1e-9)) equatorOk = false;
  }
  assert(equatorOk, "赤道顶点 y = 0（听者平面）");

  // ── 取景：入镜且紧凑（不再按外接球保守留白） ──
  const aspect = 720 / 585;
  const raw = [-0.47, 0.342, 0.814];
  const rawLen = Math.hypot(raw[0], raw[1], raw[2]);
  const dx = raw[0] / rawLen;
  const dy = raw[1] / rawLen;
  const dz = raw[2] / rawLen;
  const targetY = 0.05;

  const boxDist = fitDistanceForPoints(corners, dx, dy, dz, 0, targetY, 0, 40, aspect, 1.02);
  const boxExtent = ndcExtent(corners, dx * boxDist, dy * boxDist, dz * boxDist, 0, targetY, 0, 40, aspect);
  assert(boxExtent <= 1.01, "盒形取景：全部角点入镜（含 1% 收敛余量）");
  assert(boxExtent >= 0.9, "盒形取景足够紧凑（外接球留白已消除）");

  const sphereDist = fitDistanceForRadius(R, 40, aspect, 1.02);
  const sphereExtent = ndcExtent(
    sphereRoomPoints(R, 8, 4),
    dx * sphereDist,
    dy * sphereDist,
    dz * sphereDist,
    0,
    targetY,
    0,
    40,
    aspect,
  );
  assert(sphereExtent <= 1.0000001, "球形取景：球面点全部入镜");
  assert(sphereExtent > 0.8, "球形取景不过度留白");

  // ── 标记尺寸：恒定在画面上的大小 ──
  const frac = 0.019;
  const r5 = markerWorldRadius(frac, 40, 5);
  const r10 = markerWorldRadius(frac, 40, 10);
  assert(approx(r10, r5 * 2, 1e-9), "距离翻倍 → 世界半径翻倍（屏幕尺寸恒定）");
  const tanHalf = Math.tan((40 * Math.PI) / 360);
  assert(approx(r5 / (2 * tanHalf * 5), frac, 1e-12), "屏幕半径 / 视口高 = 目标比例");

  // ── 深度明暗：近亮远暗，覆盖全幅 ──
  assert(approx(depthDimAt(3, 5, 2, 0.62), 1, 1e-9), "深度明暗：近端 = 1");
  assert(approx(depthDimAt(7, 5, 2, 0.62), 0.62, 1e-9), "深度明暗：远端 = dimFar");
  assert(approx(depthDimAt(5, 5, 2, 0.62), 1 + (0.62 - 1) * 0.5, 1e-9), "深度明暗：中心取中值");
  assert(approx(depthDimAt(5, 5, 0, 0.62), 1, 1e-9), "span = 0 → 不做明暗");

  // ── 轨迹采样 ──
  const offsets = trailSampleOffsets(500, 6);
  assert(offsets.length === 6, "轨迹采样点数");
  assert(offsets[0] === 0 && approx(offsets[5], -500, 1e-9), "轨迹采样：head 0 → tail -trailMs");
  let monotonic = true;
  for (let i = 1; i < offsets.length; i += 1) {
    if (offsets[i] >= offsets[i - 1]) monotonic = false;
  }
  assert(monotonic, "轨迹采样偏移单调递减");

  const track: AdmKeyframe[] = [
    { timeMs: 0, x: -0.5, y: 0, z: 0, jump: false },
    { timeMs: 1000, x: 0.5, y: 0.2, z: -0.1, jump: false },
    { timeMs: 2000, x: 0.5, y: 0.2, z: -0.1, jump: true },
  ];
  assert(approx(trailWindowStart(track, 1500, 500), 1000, 1e-9), "轨迹窗口：不早于 tMs - trailMs");
  assert(approx(trailWindowStart(track, 2200, 800), 2000, 1e-9), "轨迹窗口：遇 jump 截断（不画假轨迹）");
  assert(approx(trailWindowStart(track, 2500, 150), 2350, 1e-9), "轨迹窗口：窗口内无 jump 时不截断");
  assert(isMovingTrack(track), "关键帧在动 → 需要拖尾");
  assert(
    !isMovingTrack([
      { timeMs: 0, x: 1, y: 0, z: 0, jump: false },
      { timeMs: 100, x: 1, y: 0, z: 0, jump: false },
    ]),
    "全同位置 → 静态，不建拖尾",
  );
  assert(!isMovingTrack(undefined), "无轨迹 → 静态");

  const out = { x: 0, y: 0, z: 0 };
  sampleTrackAt(track, 500, out);
  assert(
    approx(out.x, 0, 1e-9) && approx(out.y, 0.1, 1e-9) && approx(out.z, -0.05, 1e-9),
    "插值中点",
  );
  sampleTrackAt(track, 1500, out);
  assert(approx(out.x, 0.5, 1e-9) && approx(out.y, 0.2, 1e-9), "jump 保持前一块位置直到本块 rtime");
  sampleTrackAt(track, 2000, out);
  assert(approx(out.x, 0.5, 1e-9) && approx(out.z, -0.1, 1e-9), "jump 时刻本身取新位置");
  sampleTrackAt(track, 3000, out);
  assert(approx(out.x, 0.5, 1e-9), "超过末关键帧 → 末值");
  sampleTrackAt(track, -100, out);
  assert(approx(out.x, -0.5, 1e-9), "早于首关键帧 → 首值");

  // ── 粒子：确定性 + 落在体积内 + 漂移受限 ──
  const N = 24;
  const baseA = new Float32Array(N * 3);
  const parA = new Float32Array(N * 3);
  const baseB = new Float32Array(N * 3);
  const parB = new Float32Array(N * 3);
  fillParticles(N, "box", W, D, HALF_H, R, 42, baseA, parA);
  fillParticles(N, "box", W, D, HALF_H, R, 42, baseB, parB);
  let identical = true;
  for (let i = 0; i < N * 3; i += 1) {
    if (baseA[i] !== baseB[i] || parA[i] !== parB[i]) identical = false;
  }
  assert(identical, "同 seed → 粒子布局逐粒相同（预览与导出一致）");

  let inBox = true;
  for (let i = 0; i < N; i += 1) {
    if (
      Math.abs(baseA[i * 3]) > W ||
      Math.abs(baseA[i * 3 + 1]) > HALF_H ||
      Math.abs(baseA[i * 3 + 2]) > D
    ) {
      inBox = false;
    }
  }
  assert(inBox, "盒形粒子落在盒体积内");

  const sBase = new Float32Array(N * 3);
  const sPar = new Float32Array(N * 3);
  fillParticles(N, "sphere", W, D, HALF_H, R, 7, sBase, sPar);
  let inSphere = true;
  for (let i = 0; i < N; i += 1) {
    if (Math.hypot(sBase[i * 3], sBase[i * 3 + 1], sBase[i * 3 + 2]) > R) inSphere = false;
  }
  assert(inSphere, "球形粒子落在球体积内");

  const posA = new Float32Array(N * 3);
  const posB = new Float32Array(N * 3);
  updateParticles(baseA, parA, N, 12345, posA);
  updateParticles(baseA, parA, N, 12345, posB);
  let driftSame = true;
  let driftBounded = true;
  for (let i = 0; i < N * 3; i += 1) {
    if (posA[i] !== posB[i]) driftSame = false;
    const amp = parA[Math.floor(i / 3) * 3];
    if (Math.abs(posA[i] - baseA[i]) > amp + 1e-9) driftBounded = false;
  }
  assert(driftSame, "同一 timeMs → 粒子位置完全相同（timeMs 的纯函数）");
  assert(driftBounded, "漂移不超过设定幅度");
}