import * as THREE from "three";
import {
  ACTIVITY_WINDOW_MS,
  type AdmKeyframe,
  type AdmObject,
  type AtmosRoomShape,
  type AtmosViewOptions,
} from "../types";
import { levelAt, visibilityAt } from "./activity";
import {
  boxRoomLines,
  fillParticles,
  fitDistanceForRadius,
  isMovingTrack,
  markerWorldRadius,
  mulberry32,
  sampleTrackAt,
  sphereRoomLines,
  trailWindowStart,
  updateParticles,
  type Vec3Out,
} from "./geometry";

// AtmosRenderer：ADM 摆位 3D 视图，分层配方参照 Dolby Atmos Visualizer，
// 但配色不抄官方 visualizer——从整体背景取色，白灰为主。
// 只拥有一个离屏 canvas（不挂载 DOM、不是 React 组件），由 StageRenderer drawImage 到主画布。
//
// 层次（从远到近）：
//   夜空底（暗色径向晕） → 星场 → 发光膜壳（房间本身）
//   → 听者小人剪影 → 带环行星状对象（亮核 + 软晕 + 细环 + 彗尾）
// 房间不是线框盒——空间感靠膜壳提供；线笼只当极暗的刻度参照。
//
// 声场反馈：对象的环/雾/亮度随自身发声强度胀缩；膜壳朝声场重心鼓出；
// 膜壳表面自带高频噪声辉光粒子。
//
// 两条贯穿全文件的约束：
// 1. 画面必须是 timeMs 的纯函数（无滚动缓冲 / 无墙钟累积 / 无帧计数）——预览与离线逐帧导出共用它。
//    粒子与星场有随机布局，用固定 seed 保证两次运行像素一致。
// 2. 数值几何都在 geometry.ts（不依赖 three，可在 CI 裸 Node 下自检）。

// 单位球半径 = ADM 距离 1；对象标记的基准尺寸（世界单位，固定值）。
const OBJECT_RADIUS = 0.063;
// 需完整入镜的包围球半径下限（单位球 + 余量）
const FIT_RADIUS = 1.25;
// 相机方向：原点前左上方，形成两点透视。
const CAMERA_DIR = new THREE.Vector3(-0.47, 0.342, 0.814).normalize();
const CAMERA_TARGET = new THREE.Vector3(0, 0.05, 0);
// 相机看向 CAMERA_TARGET 而非原点：球心相对画面轴的横向偏移，球形取景的解析解必须算进去，
// 否则球面一侧会被画幅切掉。
const TARGET_LATERAL = (() => {
  const t = CAMERA_TARGET.clone();
  t.addScaledVector(CAMERA_DIR, -t.dot(CAMERA_DIR));
  return t.length();
})();
const FOV_DEG = 40;
const FIT_MARGIN = 1.02;

// ── 色板：从整体背景取色，白灰为主，只在极小范围内偏冷 ────
const MEMBRANE_INNER = new THREE.Color(0x2f333d);
const MEMBRANE_MID = new THREE.Color(0x8d95a3);
const MEMBRANE_RIM = new THREE.Color(0xe6ebf3);
const MEMBRANE_CAUSTIC = new THREE.Color(0xc6cdd8);
const MEMBRANE_RIM_POWER = 2.4;
// 声场重心方向的鼓包幅度（相对半径）：越响的方位，膜壳表现得越往外推
const MEMBRANE_BULGE = 0.16;
const MEMBRANE_AMP = 0.045;
const MEMBRANE_SEGMENTS_W = 128;
const MEMBRANE_SEGMENTS_H = 80;

// ── 对象标记：亮核 + 宽软晕 + 细环 ────────────────────────────────
const MARKER_SAT = 0.16;
const DOT_SCALE = 2.4; // sprite 边长 = OBJECT_RADIUS × 它；贴图 0.4 半径内是实心球核，整块读作「发光球」
const HALO_SCALE = 2.2;
const HALO_OPACITY = 0.2;
const RING_INNER = 0.55; // 环内沿（相对 sprite 半宽），亮核直径约 0.5，留出间隙
const RING_OUTER = 0.95; // 环外沿
const RING_SOFT = 0.35; // 环带的柔边宽度（相对环带厚度）
const RING_OPACITY = 0.85;
// 环与辉光随发声强度缩放（直径和粗度同比例跟着变）
const RING_MIN = 0.7;
const RING_GAIN = 0.55;
const HALO_MIN = 0.65;
const HALO_GAIN = 0.6;
const DOT_MIN = 0.55;
// ── 彗尾：三角带（对应官方 MeshLine），逐帧按轨迹重算顶点，仍是 timeMs 纯函数 ──
const TRAIL_SAMPLES = 24;
const TRAIL_WIDTH_FRAC = 0.42; // 头部半宽 = OBJECT_RADIUS × DOT_SCALE × 它
const TRAIL_TAPER = 0.85; // 尾端收窄到 1 - 它
const TRAIL_MS = 500;

// ── 听者：小人剪影 + 身后柔光（官方画面中央那个白色人形）─────────────
const LISTENER_COLOR = 0xdfe9ff;
const LISTENER_HEIGHT_FRAC = 0.2; // 相对膜壳半径的屏占比
const LISTENER_GLOW_SCALE = 2.6;
const LISTENER_GLOW_OPACITY = 0.3;

// ── 星场 ────────────────────────────────────────────────────
const STAR_COUNT = 620;
const STAR_SEED = 0x51a2;
const STAR_COLOR = 0xdbe4ff;
const STAR_OPACITY = 0.6;
const STAR_SIZE_FRAC = 0.0016;
const STAR_SHELL = 2.6;

// ── 房间边界线笼（本项目的 ADM 边界参照；官方没有这层，压到几乎看不见）──
const ROOM_COLOR = 0x8899bb;
const ROOM_LINE_OPACITY = 0.1;
const EQUATOR_OPACITY = 0.16;
const FLOOR_Y = -1.1;
const ROOM_TOP_Y = 1.1;
const ROOM_HALF_W = 1.1;
const ROOM_HALF_D = 1.1;
const GRID_COLS = 4;
const GRID_ROWS = 4;
const SPHERE_RADIUS = 1.1;
const SPHERE_MERIDIANS = 8;
const SPHERE_PARALLELS = 3;
const ROOM_INNER_FRAC = 0.88;

// ── 膜壳内部微尘 ──────────────────────────────────────────────
const PARTICLE_COUNT = 240;
const PARTICLE_SEED = 0x5eed;
const PARTICLE_COLOR = 0x8b9aac;
const PARTICLE_OPACITY = 0.2;
const PARTICLE_RADIUS_FRAC = 0.0055;

const ROOM_HALF_H = (ROOM_TOP_Y - FLOOR_Y) / 2;

type ObjectNode = {
  root: THREE.Group;
  ring: THREE.Sprite;
  halo: THREE.Sprite;
  dotMat: THREE.SpriteMaterial;
  haloMat: THREE.SpriteMaterial;
  ringMat: THREE.SpriteMaterial;
  trailMat: THREE.ShaderMaterial;
  trailGeo: THREE.BufferGeometry;
  trailMesh: THREE.Mesh;
  track?: AdmKeyframe[];
  moving: boolean;
  vis: number;
  /** 发声强度 0..1（量化 RMS），驱动环径/环粗/辉光 */
  level: number;
  activity: Uint8Array | null;
  /** 环呼吸的固定相位，保证同一对象每帧相位一致 */
  phase: number;
};

function hashKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 100000;
  return h;
}

// id/name → 稳定色相。配色不抄官方 visualizer，而是跟整体背景走：
// 白灰为主，色相锁在冷灰蓝的窄带（200°–260°），饱和度压得很低，只做微弱区分。
function hueFromKey(key: string): number {
  return 200 + (hashKey(key) / 100000) * 60;
}

// 对象标记贴图：亮核 + 宽软晕（官方 dot 的渐变停点，逐字照搬）。
// 中心 10% 半径纯白实心，40% 处降到半透明灰，到边缘完全消失——是「发光点」而非「中空环」。
function makeDotTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("AtmosRenderer: 2D canvas context unavailable");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.1, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(100,100,100,0.5)");
  g.addColorStop(1, "rgba(100,100,100,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// 夜空底 + 64 道极淡光芒（官方背景 sprite 的配方）。
// 中心近乎不透明、边缘 alpha 归零，所以贴在流体背景上不会露出矩形边界。
function makeBackgroundTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("AtmosRenderer: 2D canvas context unavailable");

  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(14,16,22,0.92)");
  g.addColorStop(0.6, "rgba(26,29,38,0.62)");
  g.addColorStop(0.9, "rgba(24,27,34,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  // 64 道随机角度的细长方形：alpha 上限 0.025，只提供极弱的放射质感
  const rand = mulberry32(0x1a2b3c);
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 64; i += 1) {
    const angle = ((Math.PI * 2) / 64) * i + (rand() - 0.5) * 0.4;
    const width = 0.5 + rand() * 4;
    const alpha = rand() * 0.025;
    const beam = ctx.createLinearGradient(0, 0, size, 0);
    beam.addColorStop(0.4, "rgba(255,255,255,0)");
    beam.addColorStop(0.4 + rand() * 0.05, `rgba(255,255,255,${alpha})`);
    beam.addColorStop(0.5, "rgba(255,255,255,0)");
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(angle);
    ctx.fillStyle = beam;
    ctx.fillRect(0, 0, size, width);
    ctx.restore();
  }
  ctx.globalCompositeOperation = "source-over";

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// 听者：头 + 肩的剪影（官方画面中央那个白色小人）。
// 用 shadowBlur 把边缘糊开，加色混合下自然成柔光剪影。
function makeListenerTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("AtmosRenderer: 2D canvas context unavailable");

  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(220,235,255,0.95)";
  ctx.shadowBlur = 18;
  // 头
  ctx.beginPath();
  ctx.arc(128, 96, 34, 0, Math.PI * 2);
  ctx.fill();
  // 肩：上宽下窄的圆角梯形
  ctx.beginPath();
  ctx.moveTo(128 - 62, 214);
  ctx.quadraticCurveTo(128 - 58, 150, 128 - 30, 146);
  ctx.lineTo(128 + 30, 146);
  ctx.quadraticCurveTo(128 + 58, 150, 128 + 62, 214);
  ctx.closePath();
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// 柔光圆盘：给听者身后提供无结构的光晕
function makeGlowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("AtmosRenderer: 2D canvas context unavailable");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,0.85)");
  g.addColorStop(0.35, "rgba(255,255,255,0.28)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// 对象星环：正对相机的柔光环（官方是 Sprite 环，不是 3D torus）。
// 环带在 RING_INNER..RING_OUTER 之间，两侧 RING_SOFT 宽的羽化。
function makeRingTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("AtmosRenderer: 2D canvas context unavailable");
  const mid = ((RING_INNER + RING_OUTER) / 2) * (size / 2);
  const half = ((RING_OUTER - RING_INNER) / 2) * (size / 2);
  const soft = half * RING_SOFT;
  const g = ctx.createRadialGradient(size / 2, size / 2, mid - half, size / 2, size / 2, mid + half);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(soft / (2 * half), "rgba(255,255,255,1)");
  g.addColorStop(1 - soft / (2 * half), "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ── 膜壳着色器 ───────────────────────────────────────────────
// 顶点：三组乘积正弦做不规则边界（有机薄膜），起伏幅度与声场能量挂钩。
// 片元：双面加色叠加近壁 + 远壁 → 天然出体积；宽窄两层柔边；
//       低频 fbm 丝绸 + 稀疏柔亮点，整体低对比——对齐官方的柔调。
// 所有输入都是 position / uTime / uEnergy，因此仍是 timeMs 的纯函数。
const MEMBRANE_VERT = `
uniform float uTime;
uniform float uEnergy;
uniform float uAmp;
uniform vec3 uFocus;
uniform float uFocusAmt;
varying float vNoise;
varying vec3 vDirW;
varying vec3 vWorldPos;

float wobble(vec3 p, float t) {
  float n = sin(p.x * 2.7 + t * 0.70) * sin(p.y * 3.1 - t * 0.50) * sin(p.z * 2.3 + t * 0.60);
  n += 0.50 * sin(p.x * 5.3 - t * 1.10) * sin(p.y * 4.7 + t * 0.90) * sin(p.z * 6.1 - t * 0.80);
  n += 0.25 * sin(p.x * 9.1 + t * 1.70) * sin(p.y * 8.3 - t * 1.30) * sin(p.z * 10.7 + t * 1.50);
  return n;
}

void main() {
  vec3 dir = normalize(position);
  float n = wobble(dir, uTime * 0.35);
  // 声场方位：uFocus 指向当前声场重心，该侧的膜被推出去
  float toward = max(dot(dir, uFocus), 0.0);
  float bulge = uFocusAmt * pow(toward, 3.0);
  float disp = 1.0 + n * uAmp * (0.55 + uEnergy * 0.90) + bulge;
  vNoise = n;
  vDirW = dir;
  vec4 world = modelMatrix * vec4(dir * disp, 1.0);
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const MEMBRANE_FRAG = `
uniform vec3 uInner;
uniform vec3 uMid;
uniform vec3 uRim;
uniform vec3 uCaustic;
uniform float uRimPower;
uniform float uEnergy;
uniform float uTime;
varying float vNoise;
varying vec3 vDirW;
varying vec3 vWorldPos;

float hash3(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}

float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

void main() {
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  // 球面法线就是归一化位置：用模型空间方向当法线，省一组 varyings
  vec3 nrm = normalize(vDirW);
  float facing = clamp(dot(nrm, viewDir), -1.0, 1.0);
  float edge = 1.0 - abs(facing);

  // 柔和的双层边缘光：官方泡的边是「几乎透明的薄边 + 一层宽晕」，不是锐利亮圈
  float rimWide = pow(clamp(edge, 0.0, 1.0), uRimPower * 0.35);
  float rimThin = pow(clamp(edge, 0.0, 1.0), uRimPower) * (0.55 + 0.45 * uEnergy);

  // 内部丝绸：低频 fbm 缓慢流动，幅度小、对比低——只有隐约的流动质感
  vec3 flow = vDirW * 2.4 + vec3(0.0, uTime * 0.035, uTime * 0.02);
  float clouds = fbm(flow) * 0.7 + vNoise * 0.3;
  float silk = pow(0.5 + 0.5 * sin((clouds * 5.0 + vDirW.y * 1.5) * 6.28318), 3.0) * 0.18;

  vec3 col = uInner * (0.35 + 0.45 * clouds);
  col += uMid * (0.22 + 0.40 * clouds + 0.40 * uEnergy) * (0.45 + 0.55 * rimWide);
  col += uCaustic * silk * (0.10 + 0.25 * uEnergy) * rimWide;
  col += uRim * rimThin * 1.1;

  float alpha = (0.02 + 0.05 * uEnergy) * (1.0 - 0.4 * rimWide)
              + rimWide * (0.06 + 0.10 * uEnergy)
              + rimThin * 0.45
              + silk * 0.05;

  // 辉光粒子：低频噪声取高次幂 + 时间漂移，稀疏柔亮点（不再是硬噪点）
  float spark = pow(vnoise(vDirW * 9.0 + vec3(uTime * 0.06, uTime * 0.09, uTime * 0.04)), 14.0);
  col += vec3(1.0) * spark * (0.35 + 0.85 * uEnergy);
  alpha += spark * 0.30;

  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

// 彗尾三角带：aT 是「沿尾端的方向参数」（0 = 头部），uVis 参与 alpha
const TRAIL_VERT = `
attribute float aT;
attribute vec3 aColor;
varying float vT;
varying vec3 vColor;
void main() {
  vT = aT;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const TRAIL_FRAG = `
uniform float uVis;
varying float vT;
varying vec3 vColor;
void main() {
  float a = pow(1.0 - vT, 1.7) * 0.8 * uVis;
  gl_FragColor = vec4(vColor * (1.25 - 0.55 * vT), a);
}
`;

// 线框：positions 为成对线段端点。WebGL 忽略 linewidth，天然 1px 细线
function makeLineSegments(positions: number[], opacity: number): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      color: ROOM_COLOR,
      transparent: true,
      opacity,
      depthWrite: false,
    }),
  );
}

// 彗尾几何：TRAIL_SAMPLES 段 × 2 顶点，索引与 aT/aColor 一次建好，之后只改 position。
function makeTrailGeometry(color: THREE.Color): THREE.BufferGeometry {
  const n = TRAIL_SAMPLES;
  const positions = new Float32Array(n * 2 * 3);
  const tAttr = new Float32Array(n * 2);
  const colorAttr = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    tAttr[i * 2] = t;
    tAttr[i * 2 + 1] = t;
    for (let k = 0; k < 2; k += 1) {
      colorAttr[(i * 2 + k) * 3] = color.r;
      colorAttr[(i * 2 + k) * 3 + 1] = color.g;
      colorAttr[(i * 2 + k) * 3 + 2] = color.b;
    }
  }
  const index: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aT", new THREE.BufferAttribute(tAttr, 1));
  geometry.setAttribute("aColor", new THREE.BufferAttribute(colorAttr, 3));
  geometry.setIndex(index);
  return geometry;
}

export class AtmosRenderer {
  readonly canvas: HTMLCanvasElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly nodes = new Map<string, ObjectNode>();
  private readonly nodeList: ObjectNode[] = [];

  private readonly dotTexture: THREE.CanvasTexture;
  private readonly listenerTexture: THREE.CanvasTexture;
  private readonly ringTexture: THREE.CanvasTexture;
  private readonly glowTexture: THREE.CanvasTexture;
  private readonly backgroundTexture: THREE.CanvasTexture;

  private readonly background: THREE.Sprite;
  private readonly membrane: THREE.Mesh;
  private readonly membraneMat: THREE.ShaderMaterial;
  private readonly listener: THREE.Group;

  private readonly stars: THREE.Points;
  private readonly starMaterial: THREE.PointsMaterial;

  private room: THREE.LineSegments;
  private equator: THREE.LineSegments | null = null;
  private readonly particleGeometry: THREE.BufferGeometry;
  private readonly particleMaterial: THREE.PointsMaterial;
  private readonly particles: THREE.Points;
  private readonly particleBase: Float32Array;
  private readonly particleParams: Float32Array;
  private readonly particlePositions: Float32Array;

  // 逐帧复用的暂存：轨迹采样点与有效性，避免每帧分配
  private readonly trailPts = new Float32Array(TRAIL_SAMPLES * 3);
  private readonly trailLive = new Uint8Array(TRAIL_SAMPLES);
  private readonly tmp: Vec3Out = { x: 0, y: 0, z: 0 };

  private timeMs = 0;
  /** 声场能量 0..1：驱动膜壳起伏、内部亮度与边缘光 */
  private energy = 0.6;
  private fitRadius = FIT_RADIUS;
  private membraneRadius = FIT_RADIUS;
  private roomScale = 1;
  private cameraDistance = FIT_RADIUS;
  private viewW = 1;
  private viewH = 1;

  private roomShape: AtmosRoomShape = "box";
  private trailMs = TRAIL_MS;
  private particlesOn = true;
  private activityEnabled = false;
  private activityDelayMs = 2000;

  constructor(width: number, height: number) {
    this.canvas = document.createElement("canvas");
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    // 透明底：合成时露出 compositor 的流体背景
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setSize(width, height, false);

    this.camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.1, 80);
    this.dotTexture = makeDotTexture();
    this.listenerTexture = makeListenerTexture();
    this.glowTexture = makeGlowTexture();
    this.ringTexture = makeRingTexture();
    this.backgroundTexture = makeBackgroundTexture();

    // ── 1. 夜空底：一张径向渐变的 billboard，边缘 alpha 归零 → 不露出矩形边界 ──
    this.background = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.backgroundTexture,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.background.renderOrder = -40;
    this.background.frustumCulled = false;
    this.scene.add(this.background);

    // ── 2. 星场：单位球壳均匀撒点（固定 seed），关深度测试、最先绘制 ──
    const starPositions = new Float32Array(STAR_COUNT * 3);
    const rand = mulberry32(STAR_SEED);
    for (let i = 0; i < STAR_COUNT; i += 1) {
      const u = rand() * 2 - 1;
      const th = rand() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - u * u));
      starPositions[i * 3] = r * Math.cos(th);
      starPositions[i * 3 + 1] = u;
      starPositions[i * 3 + 2] = r * Math.sin(th);
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    this.starMaterial = new THREE.PointsMaterial({
      map: this.dotTexture,
      color: STAR_COLOR,
      size: 0.01,
      sizeAttenuation: true,
      transparent: true,
      opacity: STAR_OPACITY,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(starGeometry, this.starMaterial);
    this.stars.renderOrder = -30;
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    // ── 3. 膜壳：单位球 + 顶点噪声位移，半径由 fitCamera 设定 ──
    this.membraneMat = new THREE.ShaderMaterial({
      vertexShader: MEMBRANE_VERT,
      fragmentShader: MEMBRANE_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uEnergy: { value: this.energy },
        uAmp: { value: MEMBRANE_AMP },
        uFocus: { value: new THREE.Vector3(0, 1, 0) },
        uFocusAmt: { value: 0 },
        uInner: { value: MEMBRANE_INNER },
        uMid: { value: MEMBRANE_MID },
        uRim: { value: MEMBRANE_RIM },
        uCaustic: { value: MEMBRANE_CAUSTIC },
        uRimPower: { value: MEMBRANE_RIM_POWER },
      },
      transparent: true,
      depthWrite: false,
      // 双面 + 加色：近壁与远壁叠加，观感上就是一层有厚度的膜
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.membrane = new THREE.Mesh(
      new THREE.SphereGeometry(1, MEMBRANE_SEGMENTS_W, MEMBRANE_SEGMENTS_H),
      this.membraneMat,
    );
    this.membrane.renderOrder = 1;
    this.membrane.position.copy(CAMERA_TARGET);
    this.membrane.frustumCulled = false;
    this.scene.add(this.membrane);

    // 对象星环改用 Sprite 贴图环（官方做法），不再建 TorusGeometry

    // ── 4. 听者：身后柔光 + 小人剪影 ──
    this.listener = new THREE.Group();
    const listenerGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: LISTENER_COLOR,
        transparent: true,
        opacity: LISTENER_GLOW_OPACITY,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    listenerGlow.renderOrder = 2;
    this.listener.add(listenerGlow);
    const figure = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.listenerTexture,
        color: LISTENER_COLOR,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    figure.renderOrder = 3;
    this.listener.add(figure);
    this.listener.userData.glow = listenerGlow;
    this.listener.userData.figure = figure;
    this.scene.add(this.listener);

    // ── 5. 房间微尘 ──
    this.particleBase = new Float32Array(PARTICLE_COUNT * 3);
    this.particleParams = new Float32Array(PARTICLE_COUNT * 3);
    this.particlePositions = new Float32Array(PARTICLE_COUNT * 3);
    this.particleGeometry = new THREE.BufferGeometry();
    this.particleGeometry.setAttribute("position", new THREE.BufferAttribute(this.particlePositions, 3));
    this.particleMaterial = new THREE.PointsMaterial({
      map: this.dotTexture,
      color: PARTICLE_COLOR,
      size: 0.01,
      sizeAttenuation: true,
      transparent: true,
      opacity: PARTICLE_OPACITY,
      depthWrite: false,
    });
    this.particles = new THREE.Points(this.particleGeometry, this.particleMaterial);
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);

    // ── 6. ADM 边界线笼（极暗，只当刻度） ──
    this.room = makeLineSegments(
      boxRoomLines(ROOM_HALF_W, ROOM_HALF_D, GRID_COLS, GRID_ROWS, FLOOR_Y, ROOM_TOP_Y),
      ROOM_LINE_OPACITY,
    );
    this.room.renderOrder = 0;
    this.scene.add(this.room);
    this.rebuildParticles();

    this.resize(width, height);
  }

  setObjects(objects: AdmObject[], channelActivity?: Uint8Array[] | null): void {
    const live = new Set<string>();
    objects.forEach((obj, i) => {
      const key = obj.id || obj.name || String(i);
      live.add(key);
      let node = this.nodes.get(key);
      if (!node) {
        node = this.createNode(key);
        this.nodes.set(key, node);
        this.scene.add(node.root);
        this.scene.add(node.trailMesh);
      }
      node.track = obj.track;
      node.moving = isMovingTrack(obj.track);
      // 发声活动位图：按对象绑定的声道号取对应声道的时间线；未绑定/越界 → null（始终发声）
      const bound =
        obj.channelIndex !== undefined && channelActivity
          ? channelActivity[obj.channelIndex]
          : undefined;
      node.activity = bound ?? null;
      node.level = levelAt(node.activity, this.timeMs, ACTIVITY_WINDOW_MS);
      // ADM → Three：three.x = adm.x，three.y = adm.z（上），three.z = -adm.y（前方朝屏幕内）
      node.root.position.set(obj.x, obj.z, -obj.y);
      node.trailMesh.visible = false;
    });

    for (const [key, node] of this.nodes) {
      if (!live.has(key)) {
        this.scene.remove(node.root);
        this.scene.remove(node.trailMesh);
        node.dotMat.dispose();
        node.haloMat.dispose();
        node.ringMat.dispose();
        node.trailMat.dispose();
        node.trailGeo.dispose();
        this.nodes.delete(key);
      }
    }

    // 取景半径覆盖所有对象的静态点与全部关键帧轨迹
    let maxDist = 0;
    for (let i = 0; i < objects.length; i += 1) {
      const obj = objects[i];
      const track = obj.track;
      if (track) {
        for (let k = 0; k < track.length; k += 1) {
          const d = Math.hypot(
            track[k].x - CAMERA_TARGET.x,
            track[k].z - CAMERA_TARGET.y,
            -track[k].y - CAMERA_TARGET.z,
          );
          if (d > maxDist) maxDist = d;
        }
      }
      const d0 = Math.hypot(obj.x - CAMERA_TARGET.x, obj.z - CAMERA_TARGET.y, -obj.y - CAMERA_TARGET.z);
      if (d0 > maxDist) maxDist = d0;
    }
    this.fitRadius = Math.max(FIT_RADIUS, maxDist + 0.25);
    // 膜壳 = 取景的那层球面：对象云越散，气泡越大，相机同步后撤，画面密度不变。
    this.fitCamera(this.viewW, this.viewH);
    this.refreshParticles(this.timeMs);

    this.nodeList.length = 0;
    for (const node of this.nodes.values()) this.nodeList.push(node);
    this.updateEnergy();
    this.updateNodeLooks();
  }

  setTime(currentTimeMs: number): void {
    if (currentTimeMs === this.timeMs) return;
    this.timeMs = currentTimeMs;
    const nodes = this.nodeList;
    for (let n = 0; n < nodes.length; n += 1) {
      const node = nodes[n];
      if (this.activityEnabled) {
        node.vis = visibilityAt(node.activity, currentTimeMs, this.activityDelayMs, ACTIVITY_WINDOW_MS);
      }
      // 强度独立于门控：门控只管「藏不藏」，强度一直跟着声场走
      node.level = levelAt(node.activity, currentTimeMs, ACTIVITY_WINDOW_MS);
      const track = node.track;
      if (track && track.length >= 2) {
        sampleTrackAt(track, currentTimeMs, this.tmp);
        node.root.position.set(this.tmp.x, this.tmp.z, -this.tmp.y);
      }
    }
    this.updateEnergy();
    this.refreshParticles(currentTimeMs);
    this.updateNodeLooks();
  }

  /**
   * 视图选项：活动门控 + 空间形状 + 彗尾时长 + 房间微尘。
   * 关闭门控时立即把所有节点复位为可见，等价于该功能 no-op。
   */
  setViewOptions(opts: AtmosViewOptions): void {
    if (opts.activityEnabled !== undefined) this.activityEnabled = opts.activityEnabled;
    if (opts.activityDelayMs !== undefined && opts.activityDelayMs >= 0) {
      this.activityDelayMs = opts.activityDelayMs;
    }
    if (opts.trailMs !== undefined && opts.trailMs >= 0) this.trailMs = opts.trailMs;
    if (opts.particles !== undefined && opts.particles !== this.particlesOn) {
      this.particlesOn = opts.particles;
      this.particles.visible = opts.particles;
    }
    if (opts.roomShape !== undefined && opts.roomShape !== this.roomShape) {
      this.roomShape = opts.roomShape;
      this.rebuildRoom();
    }
    if (!this.activityEnabled) {
      for (const node of this.nodes.values()) node.vis = 1;
    }
    this.updateEnergy();
    this.updateNodeLooks();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.viewW = width;
    this.viewH = height;
    this.renderer.setSize(Math.max(width, 1), Math.max(height, 1), false);
    this.fitCamera(width, height);
    this.updateNodeLooks();
  }

  dispose(): void {
    for (const node of this.nodes.values()) {
      node.dotMat.dispose();
      node.haloMat.dispose();
      node.ringMat.dispose();
      node.trailMat.dispose();
      node.trailGeo.dispose();
      this.scene.remove(node.root);
      this.scene.remove(node.trailMesh);
    }
    this.nodes.clear();
    this.nodeList.length = 0;
    this.disposeRoom();
    this.particleGeometry.dispose();
    this.particleMaterial.dispose();
    this.stars.geometry.dispose();
    this.starMaterial.dispose();
    this.ringTexture.dispose();
    this.membrane.geometry.dispose();
    this.membraneMat.dispose();
    (this.background.material as THREE.SpriteMaterial).dispose();
    // 听者：两个子节点都是 Sprite。它们的 geometry 是 three 内部所有 Sprite 共享的同一份三角形，
    // dispose 会打断之后新建的任何 Sprite → 只释放材质。
    for (const child of this.listener.children) {
      const mat = (child as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else if (mat) mat.dispose();
    }
    this.dotTexture.dispose();
    this.listenerTexture.dispose();
    this.glowTexture.dispose();
    this.backgroundTexture.dispose();
    this.renderer.dispose();
    // ponytail: 只释放 renderer；若频繁创建/销毁实例（浏览器 GL 上下文上限 ~16），再加 forceContextLoss()
  }

  // ── 房间与粒子 ─────────────────────────────────────────

  private applyRoomScale(): void {
    this.room.scale.setScalar(this.roomScale);
    if (this.equator) this.equator.scale.setScalar(this.roomScale);
    this.particles.scale.setScalar(this.roomScale);
  }

  private disposeRoom(): void {
    this.scene.remove(this.room);
    this.room.geometry.dispose();
    (this.room.material as THREE.Material).dispose();
    if (this.equator) {
      this.scene.remove(this.equator);
      this.equator.geometry.dispose();
      (this.equator.material as THREE.Material).dispose();
      this.equator = null;
    }
  }

  /** 切换线笼形状：重建线段 + 粒子基座，然后重新取景。膜壳永远是球，不吃形状。 */
  private rebuildRoom(): void {
    this.disposeRoom();
    if (this.roomShape === "sphere") {
      const globe = sphereRoomLines(SPHERE_RADIUS, SPHERE_MERIDIANS, SPHERE_PARALLELS);
      this.room = makeLineSegments(globe.lines, ROOM_LINE_OPACITY);
      this.equator = makeLineSegments(globe.equator, EQUATOR_OPACITY);
      this.equator.renderOrder = 0;
      this.scene.add(this.equator);
    } else {
      this.room = makeLineSegments(
        boxRoomLines(ROOM_HALF_W, ROOM_HALF_D, GRID_COLS, GRID_ROWS, FLOOR_Y, ROOM_TOP_Y),
        ROOM_LINE_OPACITY,
      );
    }
    this.room.renderOrder = 0;
    this.scene.add(this.room);
    this.rebuildParticles();
    this.fitCamera(this.viewW, this.viewH);
  }

  private rebuildParticles(): void {
    fillParticles(
      PARTICLE_COUNT,
      this.roomShape,
      ROOM_HALF_W,
      ROOM_HALF_D,
      ROOM_HALF_H,
      SPHERE_RADIUS,
      PARTICLE_SEED,
      this.particleBase,
      this.particleParams,
    );
    this.refreshParticles(this.timeMs);
  }

  private refreshParticles(tMs: number): void {
    if (!this.particlesOn) return;
    updateParticles(
      this.particleBase,
      this.particleParams,
      PARTICLE_COUNT,
      tMs,
      this.particlePositions,
    );
    (this.particleGeometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  /**
   * 声场能量：取所有对象当前可见度的均值，即「此刻有多少对象在发声」。
   * 门控关闭或没有位图时退回一条确定性正弦呼吸，避免膜壳死成静态图。
   */
  private updateEnergy(): void {
    const nodes = this.nodeList;
    if (this.activityEnabled && nodes.length > 0) {
      let sum = 0;
      for (let i = 0; i < nodes.length; i += 1) sum += nodes[i].vis;
      this.energy = sum / nodes.length;
    } else {
      this.energy = 0.4 + 0.3 * (0.5 + 0.5 * Math.sin(this.timeMs * 0.0009));
    }

    // 声场重心：按强度加权的位置方向 → 膜壳朝该侧鼓出
    let fx = 0;
    let fy = 0;
    let fz = 0;
    let wsum = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i];
      const w = n.vis * n.level;
      if (w <= 0) continue;
      fx += n.root.position.x * w;
      fy += n.root.position.y * w;
      fz += n.root.position.z * w;
      wsum += w;
    }
    const uFocus = this.membraneMat.uniforms.uFocus.value as THREE.Vector3;
    const flen = Math.hypot(fx, fy, fz);
    if (wsum > 1e-6 && flen > 1e-6) {
      uFocus.set(fx / flen, fy / flen, fz / flen);
      // 重心越偏离球心，方位感越强 → 鼓包幅度跟着偏离程度走
      this.membraneMat.uniforms.uFocusAmt.value = MEMBRANE_BULGE * Math.min(1, flen / wsum / 0.9);
    } else {
      this.membraneMat.uniforms.uFocusAmt.value = 0;
    }
    this.membraneMat.uniforms.uEnergy.value = this.energy;
    this.membraneMat.uniforms.uTime.value = this.timeMs / 1000;
  }

  // ── 取景 ───────────────────────────────────────────────

  /**
   * 按宽高比沿视线后移相机，让膜壳（= 房间本身）完整入镜。
   * 透视下可见轮廓是切线圆，用解析解把球心的横向偏移算进去。
   */
  private fitCamera(width: number, height: number): void {
    const aspect = Math.max(width, 1) / Math.max(height, 1);
    this.camera.aspect = aspect;

    this.membraneRadius = this.fitRadius;
    const distance = fitDistanceForRadius(
      this.membraneRadius,
      FOV_DEG,
      aspect,
      FIT_MARGIN,
      TARGET_LATERAL,
    );
    this.cameraDistance = Math.max(distance, FIT_RADIUS);
    this.camera.position.copy(CAMERA_DIR).multiplyScalar(this.cameraDistance);
    this.camera.lookAt(CAMERA_TARGET);
    this.camera.updateProjectionMatrix();

    this.membrane.scale.setScalar(this.membraneRadius);

    // 夜空底：覆盖整块画幅（贴图边缘 alpha 归零，放大 1.6 倍保证四角也在渐变之内）
    const frameH = 2 * Math.tan((FOV_DEG * Math.PI) / 360) * this.cameraDistance;
    const frameW = frameH * aspect;
    this.background.position.copy(CAMERA_TARGET);
    this.background.scale.setScalar(Math.max(frameH, frameW) * 1.6);

    // 线笼 / 微尘的缩放：顶点落到膜壳半径的 ROOM_INNER_FRAC 处
    const innerExtent = this.roomShape === "sphere" ? SPHERE_RADIUS : ROOM_HALF_W * Math.sqrt(3);
    this.roomScale = (this.membraneRadius * ROOM_INNER_FRAC) / innerExtent;
    this.applyRoomScale();

    // 星场：球壳放在相机之外很远，尺寸按壳距换算 → 屏幕上是恒定的微尘
    const shellDistance = this.cameraDistance * STAR_SHELL;
    this.stars.scale.setScalar(shellDistance);
    this.starMaterial.size = markerWorldRadius(STAR_SIZE_FRAC, FOV_DEG, shellDistance);

    // 微尘屏幕尺寸随取景距离：放大后的房间里依旧是同样的视觉大小
    this.particleMaterial.size = markerWorldRadius(PARTICLE_RADIUS_FRAC, FOV_DEG, this.cameraDistance);

    // 听者剪影：按膜壳半径定高，随机位距离换算成固定屏占比
    const figureH = this.membraneRadius * LISTENER_HEIGHT_FRAC;
    const figure = this.listener.userData.figure as THREE.Sprite;
    const glow = this.listener.userData.glow as THREE.Sprite;
    figure.scale.setScalar(figureH);
    // 剪影贴图里人形只占画布下半部分，向上挪一点让视觉重心落在原点
    figure.position.set(0, figureH * 0.08, 0);
    glow.scale.setScalar(figureH * LISTENER_GLOW_SCALE);
    glow.position.set(0, figureH * 0.05, 0);
  }

  // ── 逐帧外观 ───────────────────────────────────────────

  /**
   * 每帧统一结算外观：活动可见度 → 亮核 / 软晕 / 细环 / 彗尾。位置与相机变化都走这里。
   */
  private updateNodeLooks(): void {
    const nodes = this.nodeList;
    const t = this.timeMs;
    for (let n = 0; n < nodes.length; n += 1) {
      const node = nodes[n];
      const vis = node.vis;

      const level = node.level;
      // 亮核、外层雾、细环同一套强度驱动：越响越大越亮，环与雾同步胀开
      node.root.visible = vis > 0.001;
      node.dotMat.opacity = vis * (DOT_MIN + (1 - DOT_MIN) * level);
      node.haloMat.opacity = HALO_OPACITY * vis * (HALO_MIN + HALO_GAIN * level);
      node.halo.scale.setScalar(OBJECT_RADIUS * DOT_SCALE * HALO_SCALE * (HALO_MIN + HALO_GAIN * level));
      // 环单独呼吸（官方 ring 贴图是分散 tile 的呼吸动画），相位固定在节点上
      const breath = 0.78 + 0.22 * Math.sin(t * 0.004 + node.phase);
      node.ringMat.opacity = RING_OPACITY * vis * breath * (0.55 + 0.45 * level);
      // 环直径随强度胀缩；贴图里环带相对宽度固定，直径变大时粗度视觉上也同步变粗
      node.ring.scale.setScalar(OBJECT_RADIUS * DOT_SCALE * (RING_MIN + RING_GAIN * level));
      node.trailMat.uniforms.uVis.value = vis;

      const showTrail = this.trailMs > 0 && node.moving && vis > 0.001;
      node.trailMesh.visible = showTrail;
      if (showTrail) this.placeTrail(node);
    }
  }

  /**
   * 按轨迹重算彗尾三角带：沿时间轴回溯 trailMs，头部宽、尾端收窄。
   * 逐帧从轨迹采样 → 仍是 timeMs 的纯函数，不做任何累积缓冲。
   */
  private placeTrail(node: ObjectNode): void {
    const track = node.track;
    if (!track || track.length < 2) {
      node.trailMesh.visible = false;
      return;
    }
    const start = trailWindowStart(track, this.timeMs, this.trailMs);
    const n = TRAIL_SAMPLES;
    const pts = this.trailPts;
    const live = this.trailLive;

    // 第一遍：采样所有点，记下哪些落在窗口内（窗口外宽度归零，带子自然收口）
    for (let i = 0; i < n; i += 1) {
      const t = i / (n - 1);
      const tt = this.timeMs - this.trailMs * t;
      if (tt < start) {
        live[i] = 0;
        pts[i * 3] = 0;
        pts[i * 3 + 1] = 0;
        pts[i * 3 + 2] = 0;
        continue;
      }
      sampleTrackAt(track, tt, this.tmp);
      pts[i * 3] = this.tmp.x;
      pts[i * 3 + 1] = this.tmp.z;
      pts[i * 3 + 2] = -this.tmp.y;
      live[i] = 1;
    }

    // 第二遍：邻居差分求切线，叉乘视线方向得到带子的侧向量
    const attr = node.trailGeo.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const cam = this.camera.position;
    const unit = OBJECT_RADIUS * DOT_SCALE * TRAIL_WIDTH_FRAC;
    for (let i = 0; i < n; i += 1) {
      const t = i / (n - 1);
      const width = unit * (1 - TRAIL_TAPER * t) * live[i];
      const px = pts[i * 3];
      const py = pts[i * 3 + 1];
      const pz = pts[i * 3 + 2];

      // 切线：取前后邻居差分（端点用单向差分）
      const ia = i > 0 ? i - 1 : i;
      const ib = i < n - 1 ? i + 1 : i;
      const tx = pts[ib * 3] - pts[ia * 3];
      const ty = pts[ib * 3 + 1] - pts[ia * 3 + 1];
      const tz = pts[ib * 3 + 2] - pts[ia * 3 + 2];
      // 视线方向：从点指向相机
      const vx = cam.x - px;
      const vy = cam.y - py;
      const vz = cam.z - pz;
      // side = normalize(tangent × viewDir)
      let sx = ty * vz - tz * vy;
      let sy = tz * vx - tx * vz;
      let sz = tx * vy - ty * vx;
      const len = Math.hypot(sx, sy, sz);
      if (len > 1e-8) {
        sx /= len;
        sy /= len;
        sz /= len;
      } else {
        // 轨迹退化（原地不动）：给一个稳定朝向，避免 NaN
        sx = 1;
        sy = 0;
        sz = 0;
      }

      const a = i * 6;
      arr[a] = px + sx * width;
      arr[a + 1] = py + sy * width;
      arr[a + 2] = pz + sz * width;
      arr[a + 3] = px - sx * width;
      arr[a + 4] = py - sy * width;
      arr[a + 5] = pz - sz * width;
    }
    attr.needsUpdate = true;
  }

  private createNode(key: string): ObjectNode {
    const h = hashKey(key);
    const color = new THREE.Color().setHSL(hueFromKey(key) / 360, MARKER_SAT, 0.72 + (h % 100) / 400);
    const phase = (h % 628) / 100;

    // 亮核
    const dotMat = new THREE.SpriteMaterial({
      map: this.dotTexture,
      color,
      transparent: true,
      opacity: 1,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const dot = new THREE.Sprite(dotMat);
    dot.renderOrder = 3;
    dot.scale.setScalar(OBJECT_RADIUS * DOT_SCALE);

    // 外圈雾：同贴图、更大更淡，把亮核裹进一层宽晕
    const haloMat = new THREE.SpriteMaterial({
      map: this.dotTexture,
      color,
      transparent: true,
      opacity: HALO_OPACITY,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const halo = new THREE.Sprite(haloMat);
    halo.renderOrder = 3;
    halo.scale.setScalar(OBJECT_RADIUS * DOT_SCALE * HALO_SCALE);

    // 星环：正对相机的柔光环 sprite（官方是 Sprite 环，不是 3D torus）
    const ringMat = new THREE.SpriteMaterial({
      map: this.ringTexture,
      color,
      transparent: true,
      opacity: RING_OPACITY,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Sprite(ringMat);
    ring.renderOrder = 3;
    ring.scale.setScalar(OBJECT_RADIUS * DOT_SCALE);
    const root = new THREE.Group();
    root.add(ring);
    root.add(halo);
    root.add(dot);

    // 彗尾：独立材质 + 独立几何（顶点逐帧重算），挂在场景上而非 root 下，
    // 否则会跟着 root 的变换二重放大。uVis 让拖尾跟随活动门控淡出。
    const trailMat = new THREE.ShaderMaterial({
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      uniforms: { uVis: { value: 1 } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const trailGeo = makeTrailGeometry(color);
    const trailMesh = new THREE.Mesh(trailGeo, trailMat);
    trailMesh.renderOrder = 2;
    trailMesh.frustumCulled = false;
    trailMesh.visible = false;

    return {
      root,
      ring,
      halo,
      dotMat,
      haloMat,
      ringMat,
      trailMat,
      trailGeo,
      trailMesh,
      moving: false,
      vis: 1,
      level: 1,
      activity: null,
      phase,
    };
  }
}
