// 摆位视图的纯几何与采样逻辑：不 import three、不碰 DOM，可在 CI 的裸 Node 下自检
// （与 atmos/activity.ts 同一套路数）。渲染器只负责把这里的数值塞进 Three 对象。
//
// 铁律：这里与 renderer 的所有动画都必须是 timeMs 的纯函数——不许滚动缓冲、不许墙钟、
// 不许帧计数，否则预览与离线逐帧导出会得到不同的画面。

import type { AdmKeyframe } from "../types";

/** 三维输出（避免每帧分配对象） */
export type Vec3Out = { x: number; y: number; z: number };

// ── 取景 ───────────────────────────────────────────────

/**
 * 球形空间的解析取景：视锥半角 θ 下，半径 r 的球在距离 r/sin(θ) 处正好内切。
 * 相机看向 target（不是球心）时，球心相对画面轴的横向偏移 φ 也要算进去：最坏方向上
 * 要求 θ + φ ≤ half，故按 d = r / sin(half - φ) 迭代两次求解。
 * 比点集迭代更准（透视下可见轮廓是切线圆，略大于表面点），故球形走这条路。
 *
 * offset：target 相对球心的横向偏移（世界单位）；0 = 相机正对球心。
 */
export function fitDistanceForRadius(
  radius: number,
  fovDeg: number,
  aspect: number,
  margin: number,
  offset = 0,
): number {
  const halfV = (fovDeg * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * aspect);
  const half = Math.min(halfV, halfH) / margin;
  let distance = radius / Math.sin(half);
  for (let i = 0; i < 2; i += 1) {
    const phi = Math.atan(offset / distance);
    const angle = half - phi;
    if (angle <= 0.01) break;
    distance = radius / Math.sin(angle);
  }
  return distance;
}

// ── 标记尺寸 ───────────────────────────────────────────

/**
 * 让某个尺寸在画面上的大小恒定：世界半径 = frac × 2·tan(fov/2) × 距离。
 * 推导：屏幕半径/视口高 = worldRadius / (2·tan(fov/2)·d)，令其恒为 frac 即得。
 * 用途：粒子尺寸与拖尾按取景距离换算；对象小球不用它——小球保持固定世界半径。
 */
export function markerWorldRadius(radiusFrac: number, fovDeg: number, distance: number): number {
  return radiusFrac * 2 * Math.tan((fovDeg * Math.PI) / 360) * distance;
}

// ── 轨迹 ───────────────────────────────────────────────

/** 关键帧是否真的在动：全程同位置 → 静态（不建拖尾，省 6 个 sprite 的绘制）。 */
export function isMovingTrack(track: AdmKeyframe[] | undefined): boolean {
  if (!track || track.length < 2) return false;
  const k0 = track[0];
  for (let i = 1; i < track.length; i += 1) {
    const k = track[i];
    if (k.x !== k0.x || k.y !== k0.y || k.z !== k0.z) return true;
  }
  return false;
}

/** 轨迹采样偏移（ms）：head = 0，tail = -trailMs，等分 samples 段。 */
export function trailSampleOffsets(trailMs: number, samples: number): number[] {
  if (samples < 2) return [0];
  const out: number[] = [];
  for (let i = 0; i < samples; i += 1) out.push(-(trailMs * i) / (samples - 1));
  return out;
}

/**
 * 轨迹可回溯的最早时刻：不早于 tMs - trailMs，且不跨越 jump。
 * jumpPosition=1 是「瞬间换位」，跨过去画拖尾会凭空拉出一道横穿房间的假线。
 */
export function trailWindowStart(track: AdmKeyframe[], tMs: number, trailMs: number): number {
  let start = tMs - trailMs;
  for (let i = 0; i < track.length; i += 1) {
    const k = track[i];
    if (k.timeMs > tMs) break;
    if (k.jump && k.timeMs > start) start = k.timeMs;
  }
  return start;
}

/** 时间轴插值（与标记同一套规则；jump 保持前一块位置直到本块 rtime）。 */
export function sampleTrackAt(track: AdmKeyframe[], tMs: number, out: Vec3Out): void {
  const first = track[0];
  const last = track[track.length - 1];
  if (tMs <= first.timeMs) {
    out.x = first.x;
    out.y = first.y;
    out.z = first.z;
    return;
  }
  if (tMs >= last.timeMs) {
    out.x = last.x;
    out.y = last.y;
    out.z = last.z;
    return;
  }
  let i = 1;
  while (i < track.length && track[i].timeMs <= tMs) i += 1;
  const a = track[i - 1];
  const b = track[i];
  if (b.jump) {
    out.x = a.x;
    out.y = a.y;
    out.z = a.z;
    return;
  }
  const span = b.timeMs - a.timeMs;
  const f = span > 0 ? (tMs - a.timeMs) / span : 1;
  out.x = a.x + (b.x - a.x) * f;
  out.y = a.y + (b.y - a.y) * f;
  out.z = a.z + (b.z - a.z) * f;
}

// ── 粒子云 ─────────────────────────────────────────────

/** mulberry32：确定性 PRNG。同一 seed → 同一布局，预览与离线导出的粒子逐粒一致。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 球状粒子云：约 78% 的粒子铺在球壳表面（0.96–1.04R），其余是球内的稀薄雾层（0.25–0.9R）。
 * Fibonacci 球面分布保证经线方向也不会扎堆；每个粒子带独立尺寸 / 透明度 / 相位。
 * sizes/alphas/phases 与 positions 一一对应，渲染器直接塞进 shader 属性。
 */
export function fillCloudParticles(
  count: number,
  radius: number,
  seed: number,
  positions: Float32Array,
  sizes: Float32Array,
  alphas: Float32Array,
  phases: Float32Array,
): void {
  const rnd = mulberry32(seed);
  const shellCount = Math.floor(count * 0.78);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  // 壳层独立跑 Fibonacci：按整球 index 切 78% 会把南半球整片切给雾层，底部出现空洞。
  for (let i = 0; i < shellCount; i += 1) {
    const i3 = i * 3;
    const cosT = 1 - (2 * (i + 0.5)) / shellCount;
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = i * goldenAngle + (rnd() - 0.5) * 0.06;
    const r = radius * (0.96 + 0.08 * rnd());
    positions[i3] = sinT * Math.cos(phi) * r;
    positions[i3 + 1] = cosT * r;
    positions[i3 + 2] = sinT * Math.sin(phi) * r;
    sizes[i] = 0.75 + 0.7 * rnd();
    alphas[i] = 0.62 + 0.38 * rnd();
    phases[i] = rnd() * Math.PI * 2;
  }
  // 雾层：球内均匀体积采样（cbrt 保证密度均匀），方向随机、不与壳层共用 Fibonacci。
  const fogCount = count - shellCount;
  for (let f = 0; f < fogCount; f += 1) {
    const i = shellCount + f;
    const i3 = i * 3;
    const cosT = 2 * rnd() - 1;
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = 2 * Math.PI * rnd();
    const r = radius * (0.25 + 0.65 * Math.cbrt(rnd()));
    positions[i3] = sinT * Math.cos(phi) * r;
    positions[i3 + 1] = cosT * r;
    positions[i3 + 2] = sinT * Math.sin(phi) * r;
    sizes[i] = 0.45 + 0.5 * rnd();
    alphas[i] = 0.1 + 0.15 * rnd();
    phases[i] = rnd() * Math.PI * 2;
  }
}

/**
 * 把采样到的背景色变成“清淡”的云色：保留色相，向冷白大量提亮。
 * mix 越大越接近白；默认 0.72 仍能看出背景的冷暖倾向。
 */
export function paleTint(r: number, g: number, b: number, mix = 0.72): [number, number, number] {
  const m = Math.max(0, Math.min(1, mix));
  const wr = 238;
  const wg = 244;
  const wb = 255;
  return [(r + (wr - r) * m) / 255, (g + (wg - g) * m) / 255, (b + (wb - b) * m) / 255];
}

// ── 球壳鼓包 ───────────────────────────────────────────

// 声场方向瓣的陡峭度：越大越像单个尖包，越小越整体起伏。
// 基准 7 约等于 33° 半宽的圆缓山峰；空间越分散，实际使用的 5 更宽（更敏感地铺开）。
export const SHELL_LOBE_POW = 7;
export const SHELL_LOBE_POW_MIN = 5;

/** 峰值位移（相对球半径）：1.0 能量时山顶比壳面高 60%。取景按 1+CLOUD_BULGE 留边。 */
export const CLOUD_BULGE = 0.6;

/**
 * 顶点沿自身法线的位移（相对球半径，已被 clamp 到 1）。
 * 与 renderer 里 CLOUD_VERT 的算式逐字一致——抽出来是为了能在裸 Node 下断言，
 * 否则「六个方向都顶满 → min() 夹平 → 看起来还是圆的」这种 bug 只能靠肉眼发现。
 * dirs 为平铺的单位方向（3 × count），energies 已由调用方归一。
 */
export function shellPush(
  nx: number,
  ny: number,
  nz: number,
  dirs: Float32Array,
  energies: Float32Array,
  count: number,
  lobePow: number = SHELL_LOBE_POW,
): number {
  let push = 0;
  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3;
    const dot = nx * dirs[i3] + ny * dirs[i3 + 1] + nz * dirs[i3 + 2];
    if (dot <= 0) continue;
    push += Math.pow(dot, lobePow) * energies[i];
  }
  return push > 1 ? 1 : push;
}

// ── 定向脉冲（柔光团 / 粒子喷发）──────────────────────

/**
 * 脉冲推进相位 0..1。tMs 是唯一输入，offset 让每个环/粒子错开，
 * 保证预览与离线逐帧导出得到同一画面（不做任何帧间累积）。
 */
export function pulsePhase(tMs: number, periodMs: number, offset = 0): number {
  const p = tMs / periodMs + offset;
  const f = p - Math.floor(p);
  return f < 0 ? f + 1 : f;
}
