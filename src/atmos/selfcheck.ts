// 摆位视图最小自检：无测试框架，assert 抛错即失败。
// 覆盖三块纯逻辑：chna chunk 解析（声道绑定）、visibilityAt（可见度谓词）、
// geometry（粒子云 / 取景 / 标记尺寸 / 轨迹采样 / 球壳鼓包）。
// 均不触碰 DOM，也不 import three，可在 CI 的裸 Node 下运行。

import { parseChnaChunk } from "../adm/parse";
import type { AdmKeyframe } from "../types";
import { visibilityAt } from "./activity";
import {
  fillCloudParticles,
  fitDistanceForRadius,
  isMovingTrack,
  markerWorldRadius,
  paleTint,
  pulsePhase,
  sampleTrackAt,
  SHELL_LOBE_POW_MIN,
  shellPush,
  trailSampleOffsets,
  trailWindowStart,
} from "./geometry";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("atmos selfcheck failed: " + msg);
}

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

// 合成 chna（BS.2088）：头 4 字节 = numTrackUIDs / numTracks，
// 随后每项 40 字节 = trackIndex(2) + UID(12) + trackFormatIDRef(14) + packFormatIDRef(11) + 补(1)。
// 条目 0：trackIndex=1 + "ATU_00000001"；条目 1：trackIndex=3 + "ATU_00000003"
function buildChna(): ArrayBuffer {
  const entrySize = 40;
  const bytes = new Uint8Array(4 + 2 * entrySize);
  const dv = new DataView(bytes.buffer);
  dv.setUint16(0, 2, true); // numTrackUIDs
  dv.setUint16(2, 12, true); // numTracks
  const put = (slot: number, trackIndex: number, uid: string): void => {
    const base = 4 + slot * entrySize;
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
  dv.setUint16(0, 99, true);
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

  // ── 取景：球形解析解（offset=0 时 d = r / sin(half)） ──
  const aspect = 720 / 585;
  const halfV = (40 * Math.PI) / 360;
  const half = Math.min(halfV, Math.atan(Math.tan(halfV) * aspect));
  const d0 = fitDistanceForRadius(2, 40, aspect, 1);
  assert(approx(d0, 2 / Math.sin(half), 1e-9), "正对球心：d = r / sin(half)");
  const dOffset = fitDistanceForRadius(2, 40, aspect, 1, 0.2);
  assert(dOffset > d0, "目标横向偏移时相机需要更远");

  // ── 屏幕尺寸换算：世界半径 = frac × 2·tan(fov/2) × 距离（粒子与拖尾按它换算） ──
  const frac = 0.019;
  const r5 = markerWorldRadius(frac, 40, 5);
  const r10 = markerWorldRadius(frac, 40, 10);
  assert(approx(r10, r5 * 2, 1e-9), "距离翻倍 → 世界半径翻倍（屏幕尺寸恒定）");
  const tanHalf = Math.tan((40 * Math.PI) / 360);
  assert(approx(r5 / (2 * tanHalf * 5), frac, 1e-12), "屏幕半径 / 视口高 = 目标比例");

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

  // ── 粒子云：确定性 + 壳层/雾层半径 + 属性范围 ──
  const N = 64;
  const R = 1.1;
  const posA = new Float32Array(N * 3);
  const sizeA = new Float32Array(N);
  const alphaA = new Float32Array(N);
  const phaseA = new Float32Array(N);
  const posB = new Float32Array(N * 3);
  const sizeB = new Float32Array(N);
  const alphaB = new Float32Array(N);
  const phaseB = new Float32Array(N);
  fillCloudParticles(N, R, 42, posA, sizeA, alphaA, phaseA);
  fillCloudParticles(N, R, 42, posB, sizeB, alphaB, phaseB);
  let identical = true;
  for (let i = 0; i < N * 3; i += 1) if (posA[i] !== posB[i]) identical = false;
  for (let i = 0; i < N; i += 1) {
    if (sizeA[i] !== sizeB[i] || alphaA[i] !== alphaB[i] || phaseA[i] !== phaseB[i]) identical = false;
  }
  assert(identical, "同 seed → 粒子布局逐粒相同（预览与导出一致）");

  const shellCount = Math.floor(N * 0.78);
  let radiiOk = true;
  let propsOk = true;
  let north = false;
  let south = false;
  for (let i = 0; i < N; i += 1) {
    const r = Math.hypot(posA[i * 3], posA[i * 3 + 1], posA[i * 3 + 2]);
    if (i < shellCount) {
      if (r < R * 0.96 - 1e-9 || r > R * 1.04 + 1e-9) radiiOk = false;
      if (posA[i * 3 + 1] > R * 0.8) north = true;
      if (posA[i * 3 + 1] < -R * 0.8) south = true;
    } else if (r < R * 0.25 - 1e-9 || r > R * 0.9 + 1e-9) {
      radiiOk = false;
    }
    if (!(sizeA[i] > 0) || alphaA[i] < 0 || alphaA[i] > 1) propsOk = false;
  }
  assert(radiiOk, "粒子云：壳层 0.96–1.04R，雾层 0.25–0.90R");
  assert(north && south, "壳层覆盖南北极（不是只铺北半球）");
  assert(propsOk, "粒子尺寸为正、透明度在 0..1");

  // ── 云色：背景色向冷白混合后仍保留色相倾向 ──
  const warm = paleTint(200, 40, 40, 0.7);
  assert(warm[0] > warm[1] && warm[2] > warm[1], "背景色映射保留暖色相（红通道最高）");
  assert(warm.every((c) => c >= 0 && c <= 1), "云色分量在 0..1");
  const dark = paleTint(10, 10, 10, 0.8);
  assert(dark[2] >= dark[0], "暗背景 → 冷白（蓝通道不低于红）");

  // ── 球壳鼓包：方向必须真的体现在形状上 ──────────────────
  // 峰值不再按「相对最响」归一，而是用绝对能量；靠较宽的方向瓣（基准 7、扩散时 5）
  // 把六个同时发声的源压成六座圆缓山包，而不是整个球均匀胀大。这里同时验证单源的峰/谷和六源同响时的方向性。
  {
    const dirs = new Float32Array([0, 0, 1]); // 正前方（three 里 +z 朝听者背后，但只要一致即可）
    const energies = new Float32Array([1]);

    const front = shellPush(0, 0, 1, dirs, energies, 1);
    const side = shellPush(1, 0, 0, dirs, energies, 1);
    const back = shellPush(0, 0, -1, dirs, energies, 1);
    const off30 = shellPush(Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6), dirs, energies, 1);

    assert(approx(front, 1), "正对声源的点鼓到满幅");
    assert(side === 0, "侧向 90° 的点完全不动（幂次瓣）");
    assert(back === 0, "背向的点完全不动");
    assert(off30 < 0.42 && off30 > 0.25, "偏离 30° 已有明显下降（宽底山峰而非整体鼓包）");
    const off30Broad = shellPush(Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6), dirs, energies, 1, SHELL_LOBE_POW_MIN);
    assert(off30Broad > off30, "空间越扩散，方向瓣越宽缓（pow 降低）");

    // 六个方向都满幅：正对峰顶仍是 1，两个相邻峰的中间必须明显凹下去
    const sixDirs = new Float32Array([0, 0, 1, 0, 0, -1, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0]);
    const sixEnergies = new Float32Array([1, 1, 1, 1, 1, 1]);
    const sixFront = shellPush(0, 0, 1, sixDirs, sixEnergies, 6);
    const sixValley = shellPush(Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6), sixDirs, sixEnergies, 6);
    assert(sixFront > 0.9 && sixValley < 0.5, "六源同响时峰顶与峰间仍分明（没有被夹平）");
    assert(shellPush(0, 0, 1, dirs, energies, 0) === 0, "没有活跃声源时球壳不鼓");

    // 反向声源不应该在别处留下位移（dot <= 0 直接跳过）
    const negDirs = new Float32Array([0, 0, -1]);
    assert(shellPush(0, 0, 1, negDirs, energies, 1) === 0, "背向声源对前方顶点无位移");

    // 脉冲相位必须是 timeMs 的纯函数：绕回后仍落在 [0,1)，否则离屏导出与预览会漂
    assert(pulsePhase(0, 1000) === 0, `pulse phase t=0 -> 0, got ${pulsePhase(0, 1000)}`);
    assert(approx(pulsePhase(500, 1000), 0.5), `pulse phase half -> 0.5, got ${pulsePhase(500, 1000)}`);
    assert(approx(pulsePhase(1500, 1000), 0.5), `pulse phase wraps, got ${pulsePhase(1500, 1000)}`);
    assert(approx(pulsePhase(0, 1000, 0.25), 0.25), "pulse phase applies the per-slot offset");
    let pulseInRange = true;
    for (let t = 0; t < 5000; t += 37) {
      const v = pulsePhase(t, 1400, 0.3);
      if (!(v >= 0 && v < 1)) pulseInRange = false;
    }
    assert(pulseInRange, "pulse phase always inside [0,1)");
  }
}
