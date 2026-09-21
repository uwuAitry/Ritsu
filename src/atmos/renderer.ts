import * as THREE from "three";
import {
  ACTIVITY_WINDOW_MS,
  type AdmKeyframe,
  type AdmObject,
  type AtmosRoomShape,
  type AtmosViewOptions,
} from "../types";
import { visibilityAt } from "./activity";
import {
  boxRoomLines,
  boxRoomPoints,
  fillParticles,
  fitDistanceForPoints,
  fitDistanceForRadius,
  isMovingTrack,
  markerWorldRadius,
  sampleTrackAt,
  sphereRoomLines,
  trailSampleOffsets,
  trailWindowStart,
  updateParticles,
  type Vec3Out,
} from "./geometry";

// AtmosRenderer：ADM 摆位 3D 视图。
// 只拥有一个离屏 canvas（不挂载 DOM、不是 React 组件），由 compositor drawImage 到 1920×1080 主画布。
//
// 两条贯穿全文件的约束：
// 1. 画面必须是 timeMs 的纯函数（无滚动缓冲 / 无墙钟 / 无帧计数）——预览与离线逐帧导出共用它，
//    任何「累积型」动画都会让成片与预览不一致。粒子有随机布局，用固定 seed 保证两次运行相同。
// 2. 所有形状与取景数值都在 geometry.ts 里算（那一侧不依赖 three，可在 CI 裸 Node 下自检）。

// 单位球半径 = ADM 距离 1；对象小球半径（世界单位，固定值——与上一版观感一致）
const OBJECT_RADIUS = 0.075;
// 需完整入镜的包围球半径下限（单位球 + 光晕余量）
const FIT_RADIUS = 1.25;
// 相机方向：原点前左上方。方位角约 30°（偏画面左）、俯角约 20°，
// 形成两点透视——最近的竖直棱落在画面中心左侧，视线略向下但无侧倾（lookAt 默认 up）
const CAMERA_DIR = new THREE.Vector3(-0.47, 0.342, 0.814).normalize();
const CAMERA_TARGET = new THREE.Vector3(0, 0.05, 0);
const FOV_DEG = 40;
// 取景余量：贴边后再留 2% 呼吸空间
const FIT_MARGIN = 1.02;

// 房间线框：钢蓝灰细线，无填充/无背景，只为摆位视图提供空间参照，画布保持透明以便 alpha 合成与导出。
// 亮度刻意压在彩色对象之下（1px 细线 + 低不透明度）——它是参照物，不是主角。
const ROOM_COLOR = 0x77879b;
const ROOM_LINE_OPACITY = 0.42;
// 赤道是球形空间里唯一有含义的结构线（听者平面），单独给更高的不透明度
const EQUATOR_OPACITY = 0.6;
const LISTENER_COLOR = 0x9fb0c4;
const LISTENER_OPACITY = 0.32;

// 盒形房间尺寸：7×6 格、间距 0.5。比对象云（单位立方体）明显外扩，
// 于是对象落在房间半宽的 ~55% 处——不再贴着墙，房间读起来更大。
const FLOOR_Y = -1; // 单位球最低点，对象漂浮其上方
const ROOM_TOP_Y = 1;
const ROOM_HALF_W = 1.75;
const ROOM_HALF_D = 1.5;
const GRID_COLS = 7;
const GRID_ROWS = 6;

// 球形房间：半径必须把单位立方体（角点 √3 ≈ 1.73）包进去，否则角落对象会戳出球外
const SPHERE_RADIUS = 1.8;
const SPHERE_MERIDIANS = 8; // 每 45° 一条经线
const SPHERE_PARALLELS = 3; // → ±45° 两条纬线 + 赤道，稀疏得像地球仪而不是亮笼子

// 标记与光晕
const MARKER_SAT = 0.85;
const MARKER_LIGHT = 0.58;
const HALO_SCALE = 4.5; // 相对小球半径
const HALO_OPACITY = 0.5;

// 辉光轨迹：6 个同材质 sprite 沿时间轴反向采样，只做尺寸渐隐（共享材质 → 每节点多 1 个材质）
// ponytail: 逐点 alpha 需要自定义 shader，这里尺寸渐隐 + 加色叠加已够像彗尾；要更细腻再上 Points + shader
const TRAIL_SAMPLES = 6;
const TRAIL_HEAD_SCALE = 2.6;
const TRAIL_TAIL_SCALE = 0.6;
const TRAIL_OPACITY = 0.22;
const DEFAULT_TRAIL_MS = 500;

// 房间粒子：微尘，不是星空——冷灰、极低不透明度、普通混合（不用加色）
const PARTICLE_COUNT = 240;
const PARTICLE_SEED = 0x5eed;
const PARTICLE_COLOR = 0x8b9aac;
const PARTICLE_OPACITY = 0.24;
const PARTICLE_RADIUS_FRAC = 0.0055;

const ROOM_HALF_H = (ROOM_TOP_Y - FLOOR_Y) / 2;

type ObjectNode = {
  root: THREE.Mesh;
  materials: THREE.Material[];
  trail: THREE.Sprite[];
  trailGroup: THREE.Group;
  track?: AdmKeyframe[];
  /** 关键帧是否真的在动：静态对象不建拖尾（省 6 个 sprite 的绘制） */
  moving: boolean;
  /** 活动门控可见度（不含深度明暗） */
  vis: number;
  /** 发声活动位图（100ms/窗，随声道绑定取自解码期时间线）；null = 始终发声 */
  activity: Uint8Array | null;
};

// id/name → 稳定色相；末乘黄金角，让相邻 id（AO_1001 / AO_1002）色相拉开
function hueFromKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 360;
  return (h * 137.508) % 360;
}

// 中空环状白色光晕贴图（加色混合）：中心 alpha=0，小球本色从中心透出；
// 能量集中在半径中段（约 1.25 倍小球半径处，正好落在小球轮廓外侧），内外两侧平滑衰减，无硬环边。
function makeGlowTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("AtmosRenderer: 2D canvas context unavailable");
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.22, "rgba(255,255,255,0.10)");
  gradient.addColorStop(0.42, "rgba(255,255,255,0.30)");
  gradient.addColorStop(0.55, "rgba(255,255,255,0.34)");
  gradient.addColorStop(0.72, "rgba(255,255,255,0.15)");
  gradient.addColorStop(0.88, "rgba(255,255,255,0.04)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

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

export class AtmosRenderer {
  readonly canvas: HTMLCanvasElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly nodes = new Map<string, ObjectNode>();
  private readonly nodeList: ObjectNode[] = [];
  private readonly sphereGeometry: THREE.SphereGeometry;
  private readonly glowTexture: THREE.CanvasTexture;
  private readonly listener: THREE.Mesh;
  // 房间线框：形状可变（盒形/球形），由 rebuildRoom 重建；尺寸靠 scale 跟随 fitRadius
  private room: THREE.LineSegments;
  private equator: THREE.LineSegments | null = null;
  /** 取景点集（基准尺度）：盒形为 8 角点，球形为球面网格点 */
  private roomPoints: number[];
  private readonly fitScratch: number[] = [];
  // 房间粒子：基座与参数一次算好，每帧只按 timeMs 重算位置
  private readonly particleGeometry: THREE.BufferGeometry;
  private readonly particleMaterial: THREE.PointsMaterial;
  private readonly particles: THREE.Points;
  private readonly particleBase: Float32Array;
  private readonly particleParams: Float32Array;
  private readonly particlePositions: Float32Array;
  private readonly tmp: Vec3Out = { x: 0, y: 0, z: 0 };

  private timeMs = 0;
  // 取景半径：按实际对象/关键帧范围计算，FIT_RADIUS 为下限
  private fitRadius = FIT_RADIUS;
  /** 房间缩放：房间与粒子都按它跟随取景半径 */
  private roomScale = 1;
  /** 相机到取景中心的距离（深度明暗的基准） */
  private cameraDistance = FIT_RADIUS;
  private viewW = 1;
  private viewH = 1;

  // ── 视图选项（由 setViewOptions 下发） ──
  private roomShape: AtmosRoomShape = "box";
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
    this.sphereGeometry = new THREE.SphereGeometry(OBJECT_RADIUS, 16, 12);
    this.glowTexture = makeGlowTexture();

    // 原点听者标记：细环，标示听者位置；转平落在 XZ 平面（水平面），既不是音频对象也不是测距标尺
    this.listener = new THREE.Mesh(
      new THREE.TorusGeometry(0.075, 0.0105, 8, 40),
      new THREE.MeshBasicMaterial({
        color: LISTENER_COLOR,
        transparent: true,
        opacity: LISTENER_OPACITY,
        depthWrite: false,
      }),
    );
    this.listener.rotation.x = -Math.PI / 2;
    this.scene.add(this.listener);

    // 粒子的基座/参数在 rebuildRoom 里按形状填；这里先准备好缓冲与对象
    this.particleBase = new Float32Array(PARTICLE_COUNT * 3);
    this.particleParams = new Float32Array(PARTICLE_COUNT * 3);
    this.particlePositions = new Float32Array(PARTICLE_COUNT * 3);
    this.particleGeometry = new THREE.BufferGeometry();
    this.particleGeometry.setAttribute("position", new THREE.BufferAttribute(this.particlePositions, 3));
    this.particleMaterial = new THREE.PointsMaterial({
      map: this.glowTexture,
      color: PARTICLE_COLOR,
      size: 0.01,
      sizeAttenuation: true,
      transparent: true,
      opacity: PARTICLE_OPACITY,
      depthWrite: false,
    });
    this.particles = new THREE.Points(this.particleGeometry, this.particleMaterial);
    // 位置每帧变，包围盒会过期 → 关掉视锥剔除
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);

    // 默认盒形房间（与 roomShape 字段一致）
    this.room = makeLineSegments(
      boxRoomLines(ROOM_HALF_W, ROOM_HALF_D, GRID_COLS, GRID_ROWS, FLOOR_Y, ROOM_TOP_Y),
      ROOM_LINE_OPACITY,
    );
    this.roomPoints = boxRoomPoints(ROOM_HALF_W, ROOM_HALF_D, FLOOR_Y, ROOM_TOP_Y);
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
    // 房间与粒子随 fitRadius 等比缩放：对象云越散、相机后撤多少，房间就放大多少，
    // 于是任何取景半径下房间都保持同样的相对尺度。取景按房间轮廓收紧（见 fitCamera），
    // 所以房间在画幅里占得比「按外接球保守取景」时更满。
    this.roomScale = this.fitRadius / FIT_RADIUS;
    this.room.scale.setScalar(this.roomScale);
    this.particles.scale.setScalar(this.roomScale);
    this.fitCamera(this.viewW, this.viewH);
    this.refreshParticles(this.timeMs);

    // setTime 用索引扫描，避免每帧分配迭代器/闭包
    this.nodeList.length = 0;
    for (const node of this.nodes.values()) this.nodeList.push(node);
    this.updateNodeLooks();
  }

  setTime(currentTimeMs: number): void {
    if (currentTimeMs === this.timeMs) return;
    this.timeMs = currentTimeMs;
    const nodes = this.nodeList;
    for (let n = 0; n < nodes.length; n += 1) {
      const node = nodes[n];
      // 活动门控对全部节点生效（含无轨迹的静态对象），置于轨迹处理之前
      if (this.activityEnabled) {
        node.vis = visibilityAt(node.activity, currentTimeMs, this.activityDelayMs, ACTIVITY_WINDOW_MS);
      }
      const track = node.track;
      if (track && track.length >= 2) {
        sampleTrackAt(track, currentTimeMs, this.tmp);
        node.root.position.set(this.tmp.x, this.tmp.z, -this.tmp.y);
      }
    }
    this.refreshParticles(currentTimeMs);
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
      this.particles.visible = opts.particles;
    }
    if (opts.roomShape !== undefined && opts.roomShape !== this.roomShape) {
      this.roomShape = opts.roomShape;
      this.rebuildRoom();
    }
    if (!this.activityEnabled) {
      for (const node of this.nodes.values()) node.vis = 1;
    }
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
    // 对象节点：材质各自持有；球几何为所有节点共享，只释放一次
    for (const node of this.nodes.values()) {
      for (const m of node.materials) m.dispose();
      this.scene.remove(node.trailGroup);
    }
    this.nodes.clear();
    this.nodeList.length = 0;
    this.sphereGeometry.dispose();
    this.disposeRoom();
    this.particleGeometry.dispose();
    this.particleMaterial.dispose();
    this.listener.geometry.dispose();
    (this.listener.material as THREE.Material).dispose();
    this.glowTexture.dispose();
    this.renderer.dispose();
    // ponytail: 只释放 renderer；若频繁创建/销毁实例（浏览器 GL 上下文上限 ~16），再加 forceContextLoss()
  }

  // ── 房间与粒子 ─────────────────────────────────────────

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

  /** 切换空间形状：重建线框 + 取景点集 + 粒子基座，然后重新取景。 */
  private rebuildRoom(): void {
    this.disposeRoom();
    if (this.roomShape === "sphere") {
      const globe = sphereRoomLines(SPHERE_RADIUS, SPHERE_MERIDIANS, SPHERE_PARALLELS);
      this.room = makeLineSegments(globe.lines, ROOM_LINE_OPACITY);
      this.equator = makeLineSegments(globe.equator, EQUATOR_OPACITY);
      this.equator.scale.setScalar(this.roomScale);
      this.scene.add(this.equator);
    } else {
      this.room = makeLineSegments(
        boxRoomLines(ROOM_HALF_W, ROOM_HALF_D, GRID_COLS, GRID_ROWS, FLOOR_Y, ROOM_TOP_Y),
        ROOM_LINE_OPACITY,
      );
      this.roomPoints = boxRoomPoints(ROOM_HALF_W, ROOM_HALF_D, FLOOR_Y, ROOM_TOP_Y);
    }
    this.room.scale.setScalar(this.roomScale);
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

  // ── 取景 ───────────────────────────────────────────────

  /**
   * 按宽高比沿视线后移相机，保证房间（而非外接球）完整入镜。
   * 盒形用角点投影迭代收紧；球形用解析解（透视下可见轮廓是切线圆）。
   */
  private fitCamera(width: number, height: number): void {
    const aspect = Math.max(width, 1) / Math.max(height, 1);
    this.camera.aspect = aspect;
    let distance: number;
    if (this.roomShape === "sphere") {
      distance = fitDistanceForRadius(SPHERE_RADIUS * this.roomScale, FOV_DEG, aspect, FIT_MARGIN);
    } else {
      const pts = this.roomPoints;
      const scratch = this.fitScratch;
      scratch.length = pts.length;
      for (let i = 0; i < pts.length; i += 1) scratch[i] = pts[i] * this.roomScale;
      distance = fitDistanceForPoints(
        scratch,
        CAMERA_DIR.x,
        CAMERA_DIR.y,
        CAMERA_DIR.z,
        CAMERA_TARGET.x,
        CAMERA_TARGET.y,
        CAMERA_TARGET.z,
        FOV_DEG,
        aspect,
        FIT_MARGIN,
      );
    }
    this.cameraDistance = Math.max(distance, FIT_RADIUS);
    this.camera.position.copy(CAMERA_DIR).multiplyScalar(this.cameraDistance);
    this.camera.lookAt(CAMERA_TARGET);
    this.camera.updateProjectionMatrix();
    // 粒子屏幕尺寸随取景距离：微尘在放大后的房间里依旧是同样的视觉大小
    this.particleMaterial.size = markerWorldRadius(PARTICLE_RADIUS_FRAC, FOV_DEG, this.cameraDistance);
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
      body.opacity = vis;
      halo.opacity = HALO_OPACITY * vis;
      // 拖尾不吃深度明暗：否则尾端更暗，反而读不出运动方向
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
      color,
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

    return { root, materials: [body, halo, trailMat], trail, trailGroup, moving: false, vis: 1, activity: null };
  }
}