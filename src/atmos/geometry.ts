// 摆位视图的纯几何与采样逻辑：不 import three、不碰 DOM，可在 CI 的裸 Node 下自检
// （与 atmos/activity.ts 同一套路数）。渲染器只负责把这里的数值塞进 Three 对象。
//
// 铁律：这里与 renderer 的所有动画都必须是 timeMs 的纯函数——不许滚动缓冲、不许墙钟、
// 不许帧计数，否则预览与离线逐帧导出会得到不同的画面。

import type { AdmKeyframe, AtmosRoomShape } from "../types";

/** 三维输出（避免每帧分配对象） */
export type Vec3Out = { x: number; y: number; z: number };

// ── 房间线框 ───────────────────────────────────────────

/** 盒形房间：地板格 + 背墙/右侧墙轮廓，返回成对端点（x,y,z ×2）。 */
export function boxRoomLines(
  w: number,
  d: number,
  cols: number,
  rows: number,
  floorY: number,
  topY: number,
): number[] {
  const p: number[] = [];
  for (let i = 0; i <= cols; i += 1) {
    const x = -w + (2 * w * i) / cols;
    p.push(x, floorY, -d, x, floorY, d);
  }
  for (let j = 0; j <= rows; j += 1) {
    const z = -d + (2 * d * j) / rows;
    p.push(-w, floorY, z, w, floorY, z);
  }
  // 背墙（z=-d）：顶边 + 左右竖棱（底边与地板横线重合，省去）
  p.push(-w, topY, -d, w, topY, -d);
  p.push(-w, floorY, -d, -w, topY, -d);
  p.push(w, floorY, -d, w, topY, -d);
  // 右侧墙（x=+w）：顶边 + 前竖棱（后竖棱即背墙右棱）
  p.push(w, topY, -d, w, topY, d);
  p.push(w, floorY, d, w, topY, d);
  return p;
}

/**
 * 球形房间：经线 + 纬线，赤道单独一组。
 * 赤道是「听者平面」，是这套线里唯一有含义的结构线，所以单独给更高的不透明度；
 * 其余线一律压低，避免变成亮笼子。
 */
export function sphereRoomLines(
  radius: number,
  meridians: number,
  parallels: number,
): { lines: number[]; equator: number[] } {
  const lines: number[] = [];
  const equator: number[] = [];
  const seg = 40; // 每圈细分：够圆，顶点数仍很小
  // 经线：绕 y 轴均分，每条从北极到南极
  for (let m = 0; m < meridians; m += 1) {
    const a = (Math.PI * 2 * m) / meridians;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    for (let s = 0; s < seg; s += 1) {
      const t0 = (Math.PI * s) / seg - Math.PI / 2;
      const t1 = (Math.PI * (s + 1)) / seg - Math.PI / 2;
      lines.push(
        radius * Math.cos(t0) * cx,
        radius * Math.sin(t0),
        radius * Math.cos(t0) * cz,
        radius * Math.cos(t1) * cx,
        radius * Math.sin(t1),
        radius * Math.cos(t1) * cz,
      );
    }
  }
  // 纬线：在 (-90, 90) 内均分 parallels 条；正好落在 0 的那条归赤道
  for (let i = 0; i < parallels; i += 1) {
    const lat = (Math.PI * (i + 1)) / (parallels + 1) - Math.PI / 2;
    const y = radius * Math.sin(lat);
    const r = radius * Math.cos(lat);
    const target = Math.abs(lat) < 1e-9 ? equator : lines;
    for (let s = 0; s < seg; s += 1) {
      const a0 = (Math.PI * 2 * s) / seg;
      const a1 = (Math.PI * 2 * (s + 1)) / seg;
      target.push(r * Math.cos(a0), y, r * Math.sin(a0), r * Math.cos(a1), y, r * Math.sin(a1));
    }
  }
  return { lines, equator };
}

/** 取景点集（盒形）：8 个角点就决定了盒体的轮廓。 */
export function boxRoomPoints(w: number, d: number, floorY: number, topY: number): number[] {
  const p: number[] = [];
  for (const y of [floorY, topY]) {
    for (const x of [-w, w]) {
      for (const z of [-d, d]) p.push(x, y, z);
    }
  }
  return p;
}

/** 取景点集（球形）：球面网格点。球在透视下的可见轮廓（切线圆）略大于表面点集，
 *  故取景余量 FIT_MARGIN 之外再靠调用方的 margin 兜住这一点点差。 */
export function sphereRoomPoints(radius: number, meridians = 8, parallels = 4): number[] {
  const p: number[] = [];
  for (let m = 0; m < meridians; m += 1) {
    const a = (Math.PI * 2 * m) / meridians;
    for (let i = 0; i <= parallels; i += 1) {
      const lat = (Math.PI * i) / parallels - Math.PI / 2;
      const r = radius * Math.cos(lat);
      p.push(r * Math.cos(a), radius * Math.sin(lat), r * Math.sin(a));
    }
  }
  return p;
}

// ── 取景 ───────────────────────────────────────────────

/**
 * 把点集投影到相机空间后的最大 |ndc|（1 = 正好贴画面边缘）。
 * 相机基与 THREE.PerspectiveCamera.lookAt 完全一致：zc = normalize(camPos - target)，
 * xc = normalize(up × zc)，yc = zc × xc（up = 世界 +Y）。
 */
export function ndcExtent(
  points: number[],
  camX: number,
  camY: number,
  camZ: number,
  tx: number,
  ty: number,
  tz: number,
  fovDeg: number,
  aspect: number,
): number {
  const halfV = (fovDeg * Math.PI) / 360;
  const tanV = Math.tan(halfV);
  const tanH = tanV * aspect;
  let zcx = camX - tx;
  let zcy = camY - ty;
  let zcz = camZ - tz;
  const zlen = Math.hypot(zcx, zcy, zcz) || 1;
  zcx /= zlen;
  zcy /= zlen;
  zcz /= zlen;
  // up × zc
  let xcx = zcz;
  let xcz = -zcx;
  const xlen = Math.hypot(xcx, xcz) || 1;
  xcx /= xlen;
  xcz /= xlen;
  // zc × xc（xcy = 0，up 是 +Y）
  const ycx = zcy * xcz;
  const ycy = zcz * xcx - zcx * xcz;
  const ycz = -zcy * xcx;
  let extent = 0;
  for (let i = 0; i < points.length; i += 3) {
    const vx = points[i] - camX;
    const vy = points[i + 1] - camY;
    const vz = points[i + 2] - camZ;
    const depth = -(vx * zcx + vy * zcy + vz * zcz); // 相机朝 -zc 看
    if (depth <= 1e-6) return Infinity; // 点在相机后方：必须继续后退
    const px = vx * xcx + vz * xcz;
    const py = vx * ycx + vy * ycy + vz * ycz;
    const e = Math.max(Math.abs(px / depth / tanH), Math.abs(py / depth / tanV));
    if (e > extent) extent = e;
  }
  return extent;
}

/**
 * 盒形（任意点集）取景：先退到包围球外，再按投影结果迭代收紧到贴边，最后统一留 margin。
 * 迭代 3 次即可收敛（每轮按当前超出比例缩放距离）。
 */
export function fitDistanceForPoints(
  points: number[],
  dx: number,
  dy: number,
  dz: number,
  tx: number,
  ty: number,
  tz: number,
  fovDeg: number,
  aspect: number,
  margin: number,
): number {
  let r = 0;
  for (let i = 0; i < points.length; i += 3) {
    const d = Math.hypot(points[i] - tx, points[i + 1] - ty, points[i + 2] - tz);
    if (d > r) r = d;
  }
  const halfV = (fovDeg * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * aspect);
  let distance = r / Math.sin(Math.min(halfV, halfH));
  for (let it = 0; it < 3; it += 1) {
    const camX = dx * distance;
    const camY = dy * distance;
    const camZ = dz * distance;
    const e = ndcExtent(points, camX, camY, camZ, tx, ty, tz, fovDeg, aspect);
    if (!Number.isFinite(e) || e <= 0) break;
    distance *= e;
  }
  return distance * margin;
}

/**
 * 球形房间的解析取景：视锥半角 θ 下，半径 r 的球在距离 r/sin(θ) 处正好内切。
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

// ── 标记尺寸与深度明暗 ─────────────────────────────────

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

// ── 房间粒子 ───────────────────────────────────────────

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
 * 粒子基座与漂移参数。base = 基准房间尺度下的位置；params = [幅度, 周期秒, 相位] × count。
 * 盒形填满盒体积，球形按体积均匀采样（cbrt 修正半径分布，避免堆在球心）。
 */
export function fillParticles(
  count: number,
  shape: AtmosRoomShape,
  halfW: number,
  halfD: number,
  halfY: number,
  radius: number,
  seed: number,
  base: Float32Array,
  params: Float32Array,
): void {
  const rnd = mulberry32(seed);
  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3;
    let x: number;
    let y: number;
    let z: number;
    if (shape === "sphere") {
      const r = radius * 0.92 * Math.cbrt(rnd());
      const cosT = 2 * rnd() - 1;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const phi = Math.PI * 2 * rnd();
      x = r * sinT * Math.cos(phi);
      y = r * cosT;
      z = r * sinT * Math.sin(phi);
    } else {
      x = (rnd() * 2 - 1) * halfW * 0.96;
      y = (rnd() * 2 - 1) * halfY * 0.96;
      z = (rnd() * 2 - 1) * halfD * 0.96;
    }
    base[i3] = x;
    base[i3 + 1] = y;
    base[i3 + 2] = z;
    params[i3] = 0.015 + rnd() * 0.035; // 漂移幅度（基准房间尺度）
    params[i3 + 1] = 6 + rnd() * 8; // 周期 6–14 秒
    params[i3 + 2] = rnd() * Math.PI * 2; // 相位
  }
}

/** 粒子位置 = 基座 + 逐轴正弦漂移：timeMs 的纯函数，无累积状态。 */
export function updateParticles(
  base: Float32Array,
  params: Float32Array,
  count: number,
  tMs: number,
  out: Float32Array,
): void {
  const t = tMs / 1000;
  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3;
    const amp = params[i3];
    const w = (Math.PI * 2) / params[i3 + 1];
    const phase = params[i3 + 2];
    out[i3] = base[i3] + amp * Math.sin(w * t + phase);
    out[i3 + 1] = base[i3 + 1] + amp * 0.7 * Math.sin(w * 0.8 * t + phase * 1.7);
    out[i3 + 2] = base[i3 + 2] + amp * Math.cos(w * 1.15 * t + phase * 0.6);
  }
}