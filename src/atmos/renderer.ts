import * as THREE from "three";
import {
  ACTIVITY_WINDOW_MS,
  type AdmKeyframe,
  type AdmObject,
  type AtmosViewOptions,
} from "../types";
import { levelAt, visibilityAt } from "./activity";
import {
  CLOUD_BULGE,
  fillCloudParticles,
  fitDistanceForRadius,
  isMovingTrack,
  markerWorldRadius,
  paleTint,
  pulsePhase,
  sampleTrackAt,
  SHELL_LOBE_POW,
  SHELL_LOBE_POW_MIN,
  trailSampleOffsets,
  trailWindowStart,
  type Vec3Out,
} from "./geometry";
// AtmosRenderer：ADM 摆位 3D 视图。
// 只拥有一个离屏 canvas（不挂载 DOM、不是 React 组件），由 compositor drawImage 到 1920×1080 主画布。
//
// 两条贯穿全文件的约束：
// 1. 画面必须是 timeMs 的纯函数（无滚动缓冲 / 无墙钟 / 无帧计数）——预览与离线逐帧导出共用它，
//    任何「累积型」动画都会让成片与预览不一致。粒子有随机布局，用固定 seed 保证两次运行相同。
// 2. 所有形状与取景数值都在 geometry.ts 里算（那一侧不依赖 three，可在 CI 裸 Node 下自检）。

// 单位球半径 = ADM 距离 1；对象小球半径（世界单位，固定值）。
// 房间缩到 ADM 尺度后取景距离同步变近，半径按同比例缩小才能保持上一版的屏幕观感（约 9.2px）。
const OBJECT_RADIUS = 0.063;
// 需完整入镜的包围球半径下限（单位球 + 光晕余量）
const FIT_RADIUS = 1.25;
// 相机方向：原点前左上方。方位角约 30°（偏画面左）、俯角约 20°，
// 形成两点透视——最近的竖直棱落在画面中心左侧，视线略向下但无侧倾（lookAt 默认 up）
const CAMERA_DIR = new THREE.Vector3(-0.47, 0.342, 0.814).normalize();
const CAMERA_TARGET = new THREE.Vector3(0, 0.05, 0);
// 相机看向 CAMERA_TARGET 而非原点：球心相对画面轴的横向偏移。球形取景的解析解必须把它算进去，
// 否则球面一侧会被画幅切掉（盒形走点集迭代，本身已经算准了这个偏移）。
const TARGET_LATERAL = (() => {
  const t = CAMERA_TARGET.clone();
  t.addScaledVector(CAMERA_DIR, -t.dot(CAMERA_DIR));
  return t.length();
})();
const FOV_DEG = 40;
// 取景余量：贴边后再留 2% 呼吸空间
const FIT_MARGIN = 1.02;

// 听者：极简纯白发光人头剪影，始终正对相机
const LISTENER_COLOR = 0xffffff;

// 球形空间 = ADM 单位球（距离 1）；云壳略小于取景包围球，给山尖留出显影余量。
const CLOUD_RADIUS = 0.92;

// 标记与光晕
const MARKER_SAT = 0.72;
const MARKER_LIGHT = 0.62;
const HALO_SCALE = 2.8; // 相对小球半径
const HALO_OPACITY = 0.26;

// 辉光轨迹：6 个同材质 sprite 沿时间轴反向采样，只做尺寸渐隐（共享材质 → 每节点多 1 个材质）
// ponytail: 逐点 alpha 需要自定义 shader，这里尺寸渐隐 + 加色叠加已够像彗尾；要更细腻再上 Points + shader
const TRAIL_SAMPLES = 6;
const TRAIL_HEAD_SCALE = 2.6;
const TRAIL_TAIL_SCALE = 0.6;
const TRAIL_OPACITY = 0.22;
const DEFAULT_TRAIL_MS = 500;

// 球状粒子云：2800 个点铺满球壳，另有 22% 稀薄雾层填出体积感。
// 不用 PointsMaterial：山峰位移必须在 GPU 上按声源方向实时计算。
const CLOUD_COUNT = 2800;
const CLOUD_SEED = 0x5eed;
const CLOUD_OPACITY = 0.5;
const CLOUD_POINT_SCALE = 3.4;

// 声场驱动（ADM → 球壳定向鼓包）：CPU 侧把最强的几个对象归并成固定数量的方向槽，
// 顶点着色器按 dot(方向法线, 声源方向)^pow 推出球面。多源同时发声时鼓包自然叠加。
// ponytail: 固定槽位，超出时最弱的声源被丢弃；要全量得改成纹理传参。
const MAX_SOURCES = 6;
// 强度平滑：时间线 100ms 一窗，取近几窗均值抹平抖动。
// 纯 timeMs 函数（不做帧间低通——那会让预览与离线导出对不上）。
const LEVEL_SMOOTH_WINDOWS = 3;

// 对象随发声强度呼吸：本体尺寸与光晕共用同一个 level
const BODY_MIN = 0.82;
const BODY_GAIN = 0.34;
const HALO_MIN = 0.6;
const HALO_GAIN = 0.45;

// 定向脉冲：声源方向在球面上每 RIPPLE_PERIOD_MS 推出一团柔光并消散。
// 扁平 2.5D：用 sprite（永远正对相机）；不画描边、不给鼓包描轮廓线（用户明确不要包络线）。
const RIPPLE_PERIOD_MS = 1400;
const RIPPLE_START = 0.34; // 起始直径（相对球半径）
const RIPPLE_GROW = 1.05; // 一个周期内直径增量（相对球半径）
const RIPPLE_OPACITY = 0.14;

// 定向粒子喷发：爆发方向沿法线喷出一小簇，随脉冲一起散开
const BURST_PER_DIR = 14;
const BURST_PERIOD_MS = 1100;
const BURST_REACH = 0.55; // 相对球半径
const BURST_SPREAD = 0.16;
const BURST_OPACITY = 0.45;
const BURST_SIZE_FRAC = 0.006;

// 听者：极简纯白发光人头剪影（sprite，永远正对相机）
const HEAD_SCALE = 4.2; // 相对 OBJECT_RADIUS
const HEAD_OPACITY = 0.9;


type ObjectNode = {
  root: THREE.Mesh;
  color: THREE.Color;
  materials: THREE.Material[];
  trail: THREE.Sprite[];
  trailGroup: THREE.Group;
  track?: AdmKeyframe[];
  /** 关键帧是否真的在动：静态对象不建拖尾（省 6 个 sprite 的绘制） */
  moving: boolean;
  /** 活动门控可见度（0 = 隐藏，1 = 完全可见） */
  vis: number;
  /** 发声强度 0..1（窗内 RMS 平滑后），驱动本体尺寸/光晕/球壳鼓包 */
  level: number;
  /** 发声活动位图（100ms/窗，随声道绑定取自解码期时间线）；null = 始终发声 */
  activity: Uint8Array | null;
};

// id/name → 稳定色相；末乘黄金角，让相邻 id（AO_1001 / AO_1002）色相拉开
function hueFromKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 360;
  return (h * 137.508) % 360;
}

// 实心柔光贴图（加色混合）：中心最亮，向外二次衰减到全透明。
// 刻意不做中空环——环在画面上就是一圈包络线，用户明确不要。
function makeGlowTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("AtmosRenderer: 2D canvas context unavailable");
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,0.95)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.42)");
  gradient.addColorStop(0.65, "rgba(255,255,255,0.12)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// 极简人头剪影：一个圆 + 一对肩线，白色发光。扁平 2.5D，不做 3D 模型
function makeHeadTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("AtmosRenderer: 2D canvas context unavailable");
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.shadowColor = "rgba(255,255,255,0.9)";
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.arc(64, 48, 21, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(30, 112);
  ctx.quadraticCurveTo(34, 78, 52, 74);
  ctx.lineTo(76, 74);
  ctx.quadraticCurveTo(94, 78, 98, 112);
  ctx.closePath();
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// 球状粒子云：把声源方向投射到球壳上做定向山蜂。
// 顶点 = 粒子位置方向 × (1 + push·uAmp)；push 是 dot(dir, 声源方向)^pow 的叠加，
// 所以声源正对的一小片粒子被顶成尖山，其余球壳保持静止。
const CLOUD_VERT = `
uniform vec3 uDir[${MAX_SOURCES}];
uniform float uEnergy[${MAX_SOURCES}];
uniform vec3 uSlotColor[${MAX_SOURCES}];
uniform vec3 uColorBase;
uniform float uAmp;
uniform float uLobePow;
uniform float uTime;
uniform float uPointScale;
uniform float uCamDist;
uniform float uOpacity;
attribute float aSize;
attribute float aAlpha;
attribute float aPhase;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec3 dir = normalize(position);
  // 轻微球面漂移 + 内部流动：云是活的，但幅度小到不会把山峰轮廓抹掉。
  vec3 drift = vec3(
    sin(uTime * 0.31 + aPhase),
    cos(uTime * 0.27 + aPhase * 1.7),
    sin(uTime * 0.23 + aPhase * 0.6)
  );
  dir = normalize(dir + drift * 0.018);

  float push = 0.0;
  vec3 tint = uColorBase;
  for (int i = 0; i < ${MAX_SOURCES}; i++) {
    float w = pow(max(dot(dir, uDir[i]), 0.0), uLobePow) * uEnergy[i];
    push += w;
    // 山峰尖顶混入声源淡色：加强到 3.2×，让颜色沿云层铺开，而不是只在对象周围留一个光点。
    tint = mix(tint, uSlotColor[i], clamp(w * 3.2, 0.0, 0.9));
  }
  // 多源叠加会超过 1：夹住，保证最坏情况也不超过取景用的 (1 + CLOUD_BULGE) 半径
  push = min(push, 1.0);

  float radius = length(position) * (1.0 + push * uAmp);
  vec3 p = dir * radius;
  // 整体低频漂移 + 呼吸：整团云缓慢移动，但仍是 uTime 的纯函数。
  p += vec3(
    sin(uTime * 0.11),
    sin(uTime * 0.083 + 1.7) * 0.75,
    cos(uTime * 0.097 + 0.6) * 0.9
  ) * 0.02;
  p *= 1.0 + 0.012 * sin(uTime * 0.55 + aPhase);

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aSize * uPointScale * (uCamDist / max(-mvPosition.z, 0.001)) * (1.0 + push * 1.45);
  vColor = tint;
  vAlpha = aAlpha * uOpacity * (0.45 + 1.25 * push);
}
`;

const CLOUD_FRAG = `
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 c = gl_PointCoord - vec2(0.5);
  float d = length(c);
  if (d > 0.5) discard;
  float a = smoothstep(0.5, 0.1, d);
  gl_FragColor = vec4(vColor, a * vAlpha);
}
`;

export class AtmosRenderer {
  readonly canvas: HTMLCanvasElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly nodes = new Map<string, ObjectNode>();
  private readonly nodeList: ObjectNode[] = [];
  private readonly sphereGeometry: THREE.SphereGeometry;
  private readonly glowTexture: THREE.CanvasTexture;
  private readonly listener: THREE.Sprite;
  private readonly headTexture: THREE.CanvasTexture;
  /** 声源方向槽：uniform 数组直接持有这批 Vector3，每帧原地改写，不重新分配 */
  private readonly shellDirs: THREE.Vector3[] = [];
  private readonly shellEnergy: number[] = [];
  /** 与 shellEnergy 平行的权重，仅用于挑选最响的槽位 */
  private readonly shellWeight: number[] = [];
  /** 与 shellEnergy 平行的槽位色：山上尖顶混入对应对象的淡色 */
  private readonly shellColors: THREE.Vector3[] = [];
  // 球状粒子云：位置/尺寸/透明度/相位一次生成，逐帧只改 uTime（纯 GPU 动画）
  private readonly cloudGeometry: THREE.BufferGeometry;
  private readonly cloudMaterial: THREE.ShaderMaterial;
  private readonly cloud: THREE.Points;
  private readonly cloudPositions: Float32Array;
  private readonly cloudSizes: Float32Array;
  private readonly cloudAlphas: Float32Array;
  private readonly cloudPhases: Float32Array;
  private readonly tintScratch = new THREE.Color();
  // 定向脉冲与喷发：缓冲一次分配，每帧原地改写
  private readonly ripples: THREE.Sprite[] = [];
  private readonly rippleOffset: number[] = [];
  private readonly burstGeometry: THREE.BufferGeometry;
  private readonly burstMaterial: THREE.PointsMaterial;
  private readonly burstPoints: THREE.Points;
  private readonly burstPositions: Float32Array;
  private readonly burstJitter: Float32Array;
  private readonly burstOffset: number[];
  private readonly tmp: Vec3Out = { x: 0, y: 0, z: 0 };

  private timeMs = 0;
  // 取景半径：按实际对象/关键帧范围计算，FIT_RADIUS 为下限
  private fitRadius = FIT_RADIUS;
  /** 云层缩放：粒子云按它跟随取景半径 */
  private roomScale = 1;
  /** 相机到取景中心的距离（粒子与喷发的屏幕尺寸换算基准） */
  private cameraDistance = FIT_RADIUS;
  private viewW = 1;
  private viewH = 1;

  // ── 视图选项（由 setViewOptions 下发） ──
  private trailMs = DEFAULT_TRAIL_MS;
  private trailOffsets: number[] = trailSampleOffsets(DEFAULT_TRAIL_MS, TRAIL_SAMPLES);
  private particlesOn = true;
  private activityEnabled = false;
  private activityDelayMs = 2000;

  constructor(width: number, height: number) {
    this.canvas = document.createElement("canvas");
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    // 透明底：合成时露出 compositor 的背景
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setSize(width, height, false);

    this.camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.1, 50);
    for (let i = 0; i < MAX_SOURCES; i += 1) {
      this.shellDirs.push(new THREE.Vector3(0, 1, 0));
      this.shellEnergy.push(0);
      this.shellWeight.push(0);
      this.shellColors.push(new THREE.Vector3(1, 1, 1));
    }
    this.sphereGeometry = new THREE.SphereGeometry(OBJECT_RADIUS, 16, 12);
    this.glowTexture = makeGlowTexture();

    // 原点听者标记：极简纯白发光人头剪影。sprite 永远正对相机，扁平 2.5D 不需要 3D 模型
    this.headTexture = makeHeadTexture();
    this.listener = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.headTexture,
        color: LISTENER_COLOR,
        transparent: true,
        opacity: HEAD_OPACITY,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.listener.scale.setScalar(OBJECT_RADIUS * HEAD_SCALE);
    this.listener.renderOrder = 1;
    this.scene.add(this.listener);

    // 球状粒子云：固定 seed 生成布局，逐帧只推进 uTime（纯 GPU 动画）。
    this.cloudPositions = new Float32Array(CLOUD_COUNT * 3);
    this.cloudSizes = new Float32Array(CLOUD_COUNT);
    this.cloudAlphas = new Float32Array(CLOUD_COUNT);
    this.cloudPhases = new Float32Array(CLOUD_COUNT);
    this.cloudGeometry = new THREE.BufferGeometry();
    this.cloudGeometry.setAttribute("position", new THREE.BufferAttribute(this.cloudPositions, 3));
    this.cloudGeometry.setAttribute("aSize", new THREE.BufferAttribute(this.cloudSizes, 1));
    this.cloudGeometry.setAttribute("aAlpha", new THREE.BufferAttribute(this.cloudAlphas, 1));
    this.cloudGeometry.setAttribute("aPhase", new THREE.BufferAttribute(this.cloudPhases, 1));
    this.cloudMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uDir: { value: this.shellDirs },
        uEnergy: { value: this.shellEnergy },
        uSlotColor: { value: this.shellColors },
        uColorBase: { value: new THREE.Color(0.86, 0.91, 1.0) },
        uAmp: { value: CLOUD_BULGE },
        uLobePow: { value: SHELL_LOBE_POW },
        uTime: { value: 0 },
        uPointScale: { value: CLOUD_POINT_SCALE },
        uCamDist: { value: FIT_RADIUS },
        uOpacity: { value: CLOUD_OPACITY },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.cloud = new THREE.Points(this.cloudGeometry, this.cloudMaterial);
    // 位置随声场变化，包围盒会过期 → 关掉视锥剔除
    this.cloud.frustumCulled = false;
    // 先画云，再把对象小球叠在上面：云不写深度，对象始终清晰可读。
    this.cloud.renderOrder = -1;
    this.scene.add(this.cloud);
    this.rebuildCloud();

    // 定向脉冲：每个声源槽一个柔光团，沿球面法线推开后消散。
    // 刻意不用环线——画面上不出现任何描边/包络线。
    for (let k = 0; k < MAX_SOURCES; k += 1) {
      const ring = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTexture,
          transparent: true,
          opacity: 0,
          depthTest: false,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      ring.visible = false;
      ring.renderOrder = 2;
      this.ripples.push(ring);
      this.rippleOffset.push(k / MAX_SOURCES);
      this.scene.add(ring);
    }

    // 定向粒子喷发：每槽一小簇，位置每帧由 (timeMs, 方向, 能量) 推出
    const burstCount = MAX_SOURCES * BURST_PER_DIR;
    this.burstPositions = new Float32Array(burstCount * 3);
    this.burstJitter = new Float32Array(burstCount * 3);
    this.burstOffset = [];
    const jitterSeed = 0x9e37;
    let jitterState = jitterSeed;
    for (let s = 0; s < burstCount; s += 1) {
      this.burstOffset.push((s * 0.6180339887) % 1);
      for (let a = 0; a < 3; a += 1) {
        jitterState = (jitterState * 1664525 + 1013904223) >>> 0;
        this.burstJitter[s * 3 + a] = (jitterState / 4294967296) * 2 - 1;
      }
    }
    this.burstGeometry = new THREE.BufferGeometry();
    this.burstGeometry.setAttribute("position", new THREE.BufferAttribute(this.burstPositions, 3));
    this.burstMaterial = new THREE.PointsMaterial({
      map: this.glowTexture,
      size: 0.01,
      sizeAttenuation: true,
      transparent: true,
      opacity: BURST_OPACITY,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.burstPoints = new THREE.Points(this.burstGeometry, this.burstMaterial);
    this.burstPoints.frustumCulled = false;
    this.burstPoints.visible = false;
    this.scene.add(this.burstPoints);


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
      }
      node.track = obj.track;
      node.moving = isMovingTrack(obj.track);
      // 发声活动位图：按对象绑定的声道号取对应声道的时间线；未绑定/越界 → null（始终发声）
      const bound =
        obj.channelIndex !== undefined && channelActivity
          ? channelActivity[obj.channelIndex]
          : undefined;
      node.activity = bound ?? null;
      // ADM → Three：three.x = adm.x，three.y = adm.z（上），three.z = -adm.y（前方朝屏幕内）
      node.root.position.set(obj.x, obj.z, -obj.y);
    });

    for (const [key, node] of this.nodes) {
      if (!live.has(key)) {
        this.scene.remove(node.root);
        this.scene.remove(node.trailGroup);
        for (const m of node.materials) m.dispose();
        this.nodes.delete(key);
      }
    }

    // 取景半径覆盖所有对象的静态点与全部关键帧轨迹（角落对象 |p|=√3 不再出画）
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
    // 云层随 fitRadius 等比缩放：对象越散、相机后撤多少，球壳就放大多少，
    // 于是任何取景半径下云在画幅里都保持同样的相对尺度。
    this.roomScale = this.fitRadius / FIT_RADIUS;
    this.cloud.scale.setScalar(this.roomScale);
    this.fitCamera(this.viewW, this.viewH);
    this.refreshCloud(this.timeMs);

    // setTime 用索引扫描，避免每帧分配迭代器/闭包
    this.nodeList.length = 0;
    for (const node of this.nodes.values()) this.nodeList.push(node);
    // 新节点 vis 默认 1：不在这里按当前 timeMs 重算一遍，勾了「隐藏未发声对象」
    // 载入音频后首帧仍会全员可见（setTime 的早退让后续帧也补不上）。
    this.syncNodeActivity();
    this.updateSoundField();
    this.updateNodeLooks();
  }

  setTime(currentTimeMs: number): void {
    if (currentTimeMs === this.timeMs) return;
    this.timeMs = currentTimeMs;
    this.syncNodeActivity();
    const nodes = this.nodeList;
    for (let n = 0; n < nodes.length; n += 1) {
      const node = nodes[n];
      const track = node.track;
      if (track && track.length >= 2) {
        sampleTrackAt(track, currentTimeMs, this.tmp);
        node.root.position.set(this.tmp.x, this.tmp.z, -this.tmp.y);
      }
    }
    this.updateSoundField();
    this.refreshCloud(currentTimeMs);
    this.updateNodeLooks();
  }

  /**
   * 视图选项：活动门控 + 空间形状 + 辉光轨迹时长 + 房间粒子。
   * 关闭门控时立即把所有节点复位为可见，等价于该功能 no-op。
   */
  setViewOptions(opts: AtmosViewOptions): void {
    if (opts.activityEnabled !== undefined) this.activityEnabled = opts.activityEnabled;
    if (opts.activityDelayMs !== undefined && opts.activityDelayMs >= 0) {
      this.activityDelayMs = opts.activityDelayMs;
    }
    if (opts.trailMs !== undefined && opts.trailMs >= 0 && opts.trailMs !== this.trailMs) {
      this.trailMs = opts.trailMs;
      this.trailOffsets = trailSampleOffsets(this.trailMs, TRAIL_SAMPLES);
    }
    if (opts.particles !== undefined && opts.particles !== this.particlesOn) {
      this.particlesOn = opts.particles;
      this.cloud.visible = opts.particles;
    }
    // 形状 / 门控 / 延迟都可能改变 vis 与声场权重：重算一遍，否则暂停时改设置
    // 球壳鼓包与脉冲还停在旧权重上（暂停没有 tick，没人替它补这一帧）。
    this.syncNodeActivity();
    this.updateSoundField();
    this.updateNodeLooks();
  }

  /** 背景取样 → 清淡云色：保留背景冷暖倾向，向冷白提亮。 */
  setCloudTint(r: number, g: number, b: number): void {
    const tint = paleTint(r, g, b, 0.70);
    this.cloudMaterial.uniforms.uColorBase.value.setRGB(tint[0], tint[1], tint[2]);
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
    // 对象节点：材质各自持有；球几何为所有节点共享，只释放一次
    for (const node of this.nodes.values()) {
      for (const m of node.materials) m.dispose();
      this.scene.remove(node.trailGroup);
    }
    this.nodes.clear();
    this.nodeList.length = 0;
    this.sphereGeometry.dispose();
    this.cloudGeometry.dispose();
    this.cloudMaterial.dispose();
    // sprite 共用 three 内部的三角形几何，不能 dispose；只释放自己的材质与贴图
    (this.listener.material as THREE.Material).dispose();
    this.headTexture.dispose();
    for (const ring of this.ripples) {
      this.scene.remove(ring);
      (ring.material as THREE.Material).dispose();
    }
    this.scene.remove(this.burstPoints);
    this.burstGeometry.dispose();
    this.burstMaterial.dispose();
    this.glowTexture.dispose();
    this.renderer.dispose();
    // ponytail: 只释放 renderer；若频繁创建/销毁实例（浏览器 GL 上下文上限 ~16），再加 forceContextLoss()
  }

  // ── 球状粒子云 ─────────────────────────────────────────

  private rebuildCloud(): void {
    fillCloudParticles(
      CLOUD_COUNT,
      CLOUD_RADIUS,
      CLOUD_SEED,
      this.cloudPositions,
      this.cloudSizes,
      this.cloudAlphas,
      this.cloudPhases,
    );
    this.refreshCloud(this.timeMs);
  }

  private refreshCloud(tMs: number): void {
    this.cloud.visible = this.particlesOn;
    if (!this.particlesOn) return;
    (this.cloudMaterial.uniforms.uTime as { value: number }).value = tMs / 1000;
  }

  // ── 取景 ───────────────────────────────────────────────

  /**
   * 按宽高比沿视线后移相机，保证云在最大鼓包时仍完整入镜（解析解）。
   */
  private fitCamera(width: number, height: number): void {
    const aspect = Math.max(width, 1) / Math.max(height, 1);
    this.camera.aspect = aspect;
    // 按最大鼓包后的半径取景：山尖鼓到极限也不出画
    const outer = CLOUD_RADIUS * (1 + CLOUD_BULGE) * this.roomScale;
    const distance = fitDistanceForRadius(outer, FOV_DEG, aspect, FIT_MARGIN, TARGET_LATERAL);
    this.cameraDistance = Math.max(distance, FIT_RADIUS);
    this.camera.position.copy(CAMERA_DIR).multiplyScalar(this.cameraDistance);
    this.camera.lookAt(CAMERA_TARGET);
    this.camera.updateProjectionMatrix();
    // 粒子屏幕尺寸随取景距离：云在放大后的房间里依旧是同样的视觉大小
    this.cloudMaterial.uniforms.uPointScale.value =
      CLOUD_POINT_SCALE * (Math.max(this.viewH, 1) / 585);
    this.cloudMaterial.uniforms.uCamDist.value = this.cameraDistance;
    this.burstMaterial.size = markerWorldRadius(BURST_SIZE_FRAC, FOV_DEG, this.cameraDistance);
  }

  /**
   * 按当前 timeMs / 门控设置重算每个节点的 vis 与 level。
   * setObjects / setViewOptions / setTime 三处共用：vis 只在 setTime 里算的话，
   * 新节点（默认 vis=1）和改设置后的旧节点都会停在错的可见度上。
   */
  private syncNodeActivity(): void {
    const nodes = this.nodeList;
    for (let n = 0; n < nodes.length; n += 1) {
      const node = nodes[n];
      // 活动门控对全部节点生效（含无轨迹的静态对象）；关闭时等价于 no-op
      node.vis = this.activityEnabled
        ? visibilityAt(node.activity, this.timeMs, this.activityDelayMs, ACTIVITY_WINDOW_MS)
        : 1;
      // 强度独立于门控：门控只管藏不藏，强度一直跟着声场走
      node.level = this.smoothLevel(node.activity, this.timeMs, ACTIVITY_WINDOW_MS);
    }
  }

  /** 近几窗的强度均值：抹平 100ms 窗边界的跳变 */
  private smoothLevel(timeline: Uint8Array | null, tMs: number, windowMs: number): number {
    if (!timeline) return 1;
    let sum = 0;
    for (let i = 0; i < LEVEL_SMOOTH_WINDOWS; i += 1) {
      sum += levelAt(timeline, tMs - i * windowMs, windowMs);
    }
    return sum / LEVEL_SMOOTH_WINDOWS;
  }

  /**
   * 声场 → 云山：按「可见度 × 强度」挑最响的几个方向写进 uniform 槽位，
   * 幅度取这些槽位的能量和（越响越鼓、越多人同时响越鼓）。
   * ponytail: 槽位插入排序在 6 个槽上做，节点多时是 O(N×6)；真要上百个对象再换成堆。
   */
  private updateSoundField(): void {
    const nodes = this.nodeList;
    const dirs = this.shellDirs;
    const energy = this.shellEnergy;
    const weight = this.shellWeight;
    const colors = this.shellColors;
    for (let k = 0; k < MAX_SOURCES; k += 1) {
      weight[k] = 0;
      energy[k] = 0;
    }

    for (let n = 0; n < nodes.length; n += 1) {
      const node = nodes[n];
      if (node.vis <= 0.001) continue;
      const level = node.level;
      const w = node.vis * Math.max(level, 0.05);
      const px = node.root.position.x - CAMERA_TARGET.x;
      const py = node.root.position.y - CAMERA_TARGET.y;
      const pz = node.root.position.z - CAMERA_TARGET.z;
      const len = Math.hypot(px, py, pz);
      if (len < 1e-4) continue; // 正落在听者位置：没有方位可言
      let slot = MAX_SOURCES;
      while (slot > 0 && weight[slot - 1] < w) slot -= 1;
      if (slot >= MAX_SOURCES) continue;
      for (let k = MAX_SOURCES - 1; k > slot; k -= 1) {
        weight[k] = weight[k - 1];
        dirs[k].copy(dirs[k - 1]);
        energy[k] = energy[k - 1];
        colors[k].copy(colors[k - 1]);
      }
      weight[slot] = w;
      dirs[slot].set(px / len, py / len, pz / len);
      energy[slot] = level;
      // 山尖混入对象自己的淡色：近处看是「这团声音顶起来的山」，远处看也不抢对象本体。
      const tint = paleTint(node.color.r * 255, node.color.g * 255, node.color.b * 255, 0.6);
      colors[slot].set(tint[0], tint[1], tint[2]);
    }

    // 形态由方向瓣和「整体声像」决定：先统计总响度 total 与空间扩散度 spread。
    let total = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < MAX_SOURCES; k += 1) {
      const w = weight[k];
      total += w;
      cx += dirs[k].x * w;
      cy += dirs[k].y * w;
      cz += dirs[k].z * w;
    }
    const centroid = total > 1e-6 ? Math.hypot(cx, cy, cz) / total : 0;
    const spread = total > 1e-6 ? 1 - Math.min(1, centroid) : 0;
    const peak = weight[0];
    if (peak <= 0.002) {
      for (let k = 0; k < MAX_SOURCES; k += 1) energy[k] = 0;
    }

    // 整体幅度跟全场总响度：安静段整体缩小，多个声源同响时也按总能量放缩。
    // 方向瓣随空间扩散度变宽缓：声像集中时峰形更清晰，越分散越像整体起伏。
    this.cloudMaterial.uniforms.uAmp.value = CLOUD_BULGE * (0.2 + 0.8 * Math.min(1, total));
    this.cloudMaterial.uniforms.uLobePow.value =
      SHELL_LOBE_POW - (SHELL_LOBE_POW - SHELL_LOBE_POW_MIN) * spread;
    this.updatePulses(peak);
  }

  /**
   * 定向脉冲 + 粒子喷发。全部由 (timeMs, 方向槽, 能量) 推出，无累积状态。
   * 落点贴着云山的峰顶走，不再沿盒壁。
   */
  private updatePulses(peak: number): void {
    const live = peak > 0.002;
    const energy = this.shellEnergy;
    const dirs = this.shellDirs;
    const cloudR = CLOUD_RADIUS * this.roomScale;

    for (let k = 0; k < MAX_SOURCES; k += 1) {
      const ring = this.ripples[k];
      const e = energy[k];
      if (!live || e <= 0) {
        ring.visible = false;
        continue;
      }
      const dir = dirs[k];
      const p = pulsePhase(this.timeMs, RIPPLE_PERIOD_MS, this.rippleOffset[k]);
      // 峰顶 = 球壳半径 × (1 + 该方向的鼓包高度)；光团从峰尖向外扩散。
      const peakR = cloudR * (1 + CLOUD_BULGE * e);
      ring.position.set(
        CAMERA_TARGET.x + dir.x * peakR,
        CAMERA_TARGET.y + dir.y * peakR,
        CAMERA_TARGET.z + dir.z * peakR,
      );
      ring.scale.setScalar(cloudR * (RIPPLE_START + RIPPLE_GROW * p));
      const rel = energy[0] > 0 ? e / energy[0] : 0;
      (ring.material as THREE.SpriteMaterial).opacity =
        RIPPLE_OPACITY * (1 - p) * (1 - p) * Math.min(1, rel * 1.6);
      (ring.material as THREE.SpriteMaterial).color.setRGB(
        this.shellColors[k].x,
        this.shellColors[k].y,
        this.shellColors[k].z,
      );
      ring.visible = true;
    }

    if (!live) {
      this.burstPoints.visible = false;
      return;
    }

    const pos = this.burstPositions;
    const jit = this.burstJitter;
    for (let k = 0; k < MAX_SOURCES; k += 1) {
      const e = energy[k];
      const dir = dirs[k];
      const on = e > 0;
      const reach = cloudR * (1 + CLOUD_BULGE * e);
      for (let j = 0; j < BURST_PER_DIR; j += 1) {
        const s = k * BURST_PER_DIR + j;
        const i3 = s * 3;
        if (!on) {
          // 远平面之外：被逐顶点裁剪丢弃
          pos[i3] = pos[i3 + 1] = pos[i3 + 2] = -1e5;
          continue;
        }
        const p = pulsePhase(this.timeMs, BURST_PERIOD_MS, this.burstOffset[s]);
        const along = reach * (1 + BURST_REACH * p);
        const spread = BURST_SPREAD * reach * p;
        pos[i3] = CAMERA_TARGET.x + dir.x * along + jit[i3] * spread;
        pos[i3 + 1] = CAMERA_TARGET.y + dir.y * along + jit[i3 + 1] * spread;
        pos[i3 + 2] = CAMERA_TARGET.z + dir.z * along + jit[i3 + 2] * spread;
      }
    }
    (this.burstGeometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    this.burstMaterial.opacity = BURST_OPACITY * Math.min(1, peak * 3);
    this.burstPoints.visible = true;
  }

  // ── 逐帧外观 ───────────────────────────────────────────

  /**
   * 每帧统一结算外观：活动可见度 → 小球 / 光晕 / 拖尾。位置变化与相机变化都走这里。
   * 小球用固定世界半径（与上一版一致），不随取景距离缩放。
   */
  private updateNodeLooks(): void {
    const nodes = this.nodeList;
    for (let n = 0; n < nodes.length; n += 1) {
      const node = nodes[n];
      const vis = node.vis;

      node.root.visible = vis > 0.001;
      const body = node.materials[0] as THREE.MeshBasicMaterial;
      const halo = node.materials[1] as THREE.SpriteMaterial;
      const trailMat = node.materials[2] as THREE.SpriteMaterial;
      const level = node.level;
      body.opacity = vis;
      // 本体与光晕一起跟着发声强度胀缩（光晕是 root 的子节点，会一起被 root.scale 放大）
      node.root.scale.setScalar(BODY_MIN + BODY_GAIN * level);
      halo.opacity = HALO_OPACITY * vis * (HALO_MIN + HALO_GAIN * level);
      // 拖尾只吃可见度、不跟发声强度一起明暗：否则尾端更暗，反而读不出运动方向
      trailMat.opacity = TRAIL_OPACITY * node.vis;

      const showTrail = this.trailMs > 0 && node.moving && node.vis > 0.001;
      node.trailGroup.visible = showTrail;
      if (showTrail) this.placeTrail(node);
      else for (let i = 0; i < node.trail.length; i += 1) node.trail[i].visible = false;
    }
  }

  /** 沿时间轴反向采样出拖尾：不早于 trailMs 窗口，且不跨越 jump（否则会拉出假轨迹）。 */
  private placeTrail(node: ObjectNode): void {
    const track = node.track;
    const trail = node.trail;
    if (!track || track.length < 2) {
      for (let i = 0; i < trail.length; i += 1) trail[i].visible = false;
      return;
    }
    const start = trailWindowStart(track, this.timeMs, this.trailMs);
    const offsets = this.trailOffsets;
    const span = TRAIL_HEAD_SCALE - TRAIL_TAIL_SCALE;
    for (let i = 0; i < trail.length; i += 1) {
      const sprite = trail[i];
      const tt = this.timeMs + offsets[i];
      if (tt < start) {
        sprite.visible = false;
        continue;
      }
      sampleTrackAt(track, tt, this.tmp);
      sprite.position.set(this.tmp.x, this.tmp.z, -this.tmp.y);
      const k = trail.length > 1 ? 1 - i / (trail.length - 1) : 1;
      sprite.scale.setScalar(OBJECT_RADIUS * (TRAIL_TAIL_SCALE + span * k));
      sprite.visible = true;
    }
  }

  private createNode(key: string): ObjectNode {
    // 哑光色：饱和压到 0.44、明度 0.63 —— 相邻对象仍凭色相可分辨，但不再互相抢戏
    const color = new THREE.Color().setHSL(hueFromKey(key) / 360, MARKER_SAT, MARKER_LIGHT);
    // transparent 常开：活动门控逐帧改 opacity（=1 时外观与不透明一致）
    const body = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 });
    const halo = new THREE.SpriteMaterial({
      map: this.glowTexture,
      color: 0xffffff, // 统一柔白边：单点不再各自染色发光
      transparent: true,
      opacity: HALO_OPACITY,
      depthTest: false, // 光晕始终叠在小球上，形成柔和外发光
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const root = new THREE.Mesh(this.sphereGeometry, body);
    const sprite = new THREE.Sprite(halo);
    sprite.scale.setScalar(OBJECT_RADIUS * HALO_SCALE);
    sprite.renderOrder = 1;
    root.add(sprite);

    // 拖尾 sprite 独立挂在场景上（不挂在 root 下，否则会跟着 root 的屏幕尺寸缩放二重放大）
    const trailMat = new THREE.SpriteMaterial({
      map: this.glowTexture,
      color,
      transparent: true,
      opacity: TRAIL_OPACITY,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const trailGroup = new THREE.Group();
    const trail: THREE.Sprite[] = [];
    for (let i = 0; i < TRAIL_SAMPLES; i += 1) {
      const dot = new THREE.Sprite(trailMat);
      dot.visible = false;
      trailGroup.add(dot);
      trail.push(dot);
    }
    trailGroup.visible = false;
    this.scene.add(trailGroup);

    return {
      root,
      color,
      materials: [body, halo, trailMat],
      trail,
      trailGroup,
      moving: false,
      vis: 1,
      level: 1,
      activity: null,
    };
  }
}