import * as THREE from "three";
import type { AdmKeyframe, AdmObject } from "../types";

// AtmosRenderer：ADM 摆位 3D 视图。
// 只拥有一个离屏 canvas（不挂载 DOM、不是 React 组件），由 compositor drawImage 到 1920×1080 主画布。

// 单位球半径 = ADM 距离 1；对象小球半径（世界单位）
const OBJECT_RADIUS = 0.05;
// 需完整入镜的包围球半径（单位球 + 光晕余量）
const FIT_RADIUS = 1.25;
// 相机方向：原点前左上方。方位角约 30°（偏画面左）、俯角约 20°，
// 形成两点透视——最近的竖直棱落在画面中心左侧，视线略向下但无侧倾（lookAt 默认 up）
const CAMERA_DIR = new THREE.Vector3(-0.47, 0.342, 0.814).normalize();
const CAMERA_TARGET = new THREE.Vector3(0, 0.05, 0);

// 房间线框：地板格 + 背墙/右侧墙轮廓。钢蓝色细线，无填充/无背景，
// 只为摆位视图提供“房间”参照，画布保持透明以便 alpha 合成与 captureStream 导出
const ROOM_COLOR = 0x4a5a6a;
const ROOM_LINE_OPACITY = 0.5;
const FLOOR_Y = -1; // 单位球最低点，对象漂浮其上方
const ROOM_TOP_Y = 1;
const ROOM_HALF_W = 1.25; // x 半宽：5 格 × 0.5
const ROOM_HALF_D = 1; // z 半深：4 格 × 0.5
const GRID_COLS = 5;
const GRID_ROWS = 4;

type ObjectNode = {
  root: THREE.Mesh;
  materials: THREE.Material[];
  track?: AdmKeyframe[];
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
function makeLineSegments(positions: number[]): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      color: ROOM_COLOR,
      transparent: true,
      opacity: ROOM_LINE_OPACITY,
      depthWrite: false,
    }),
  );
}

// 地板格（5×4 格）+ 背墙/右侧墙轮廓：纯线框，无天花板、无填充
function makeRoom(): THREE.LineSegments {
  const p: number[] = [];
  const w = ROOM_HALF_W;
  const d = ROOM_HALF_D;
  // 地板：沿 x 的 6 条竖线 + 沿 z 的 5 条横线
  for (let i = 0; i <= GRID_COLS; i += 1) {
    const x = -w + (2 * w * i) / GRID_COLS;
    p.push(x, FLOOR_Y, -d, x, FLOOR_Y, d);
  }
  for (let j = 0; j <= GRID_ROWS; j += 1) {
    const z = -d + (2 * d * j) / GRID_ROWS;
    p.push(-w, FLOOR_Y, z, w, FLOOR_Y, z);
  }
  // 背墙（z=-d）：顶边 + 左右竖棱（底边与地板横线重合，省去）
  p.push(-w, ROOM_TOP_Y, -d, w, ROOM_TOP_Y, -d);
  p.push(-w, FLOOR_Y, -d, -w, ROOM_TOP_Y, -d);
  p.push(w, FLOOR_Y, -d, w, ROOM_TOP_Y, -d);
  // 右侧墙（x=+w）：顶边 + 前竖棱（后竖棱即背墙右棱）
  p.push(w, ROOM_TOP_Y, -d, w, ROOM_TOP_Y, d);
  p.push(w, FLOOR_Y, d, w, ROOM_TOP_Y, d);
  return makeLineSegments(p);
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
  private timeMs = 0;
  // 取景半径：按实际对象/关键帧范围计算，FIT_RADIUS 为下限
  private fitRadius = FIT_RADIUS;
  private viewW = 1;
  private viewH = 1;

  constructor(width: number, height: number) {
    this.canvas = document.createElement("canvas");
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    // 透明底：合成时露出 compositor 的背景
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setSize(width, height, false);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
    this.sphereGeometry = new THREE.SphereGeometry(OBJECT_RADIUS, 16, 12);
    this.glowTexture = makeGlowTexture();

    // 原点听者标记：细环，标示听者位置；转平落在 XZ 平面（水平面），既不是音频对象也不是测距标尺
    const listener = new THREE.Mesh(
      new THREE.TorusGeometry(0.05, 0.007, 8, 40),
      new THREE.MeshBasicMaterial({ color: 0x9fb0c4, transparent: true, opacity: 0.4, depthWrite: false }),
    );
    listener.rotation.x = -Math.PI / 2;
    this.scene.add(listener);

    // 房间线框：给对象云一个地板与墙角参照
    this.scene.add(makeRoom());

    this.resize(width, height);
  }

  setObjects(objects: AdmObject[]): void {
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
      // ADM → Three：three.x = adm.x，three.y = adm.z（上），three.z = -adm.y（前方朝屏幕内）
      node.root.position.set(obj.x, obj.z, -obj.y);
    });

    for (const [key, node] of this.nodes) {
      if (!live.has(key)) {
        this.scene.remove(node.root);
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
    this.fitCamera(this.viewW, this.viewH);

    // setTime 用索引扫描，避免每帧分配迭代器/闭包
    this.nodeList.length = 0;
    for (const node of this.nodes.values()) this.nodeList.push(node);
  }

  setTime(currentTimeMs: number): void {
    if (currentTimeMs === this.timeMs) return;
    this.timeMs = currentTimeMs;
    const nodes = this.nodeList;
    for (let n = 0; n < nodes.length; n += 1) {
      const node = nodes[n];
      const track = node.track;
      if (!track || track.length < 2) continue;
      const first = track[0];
      const last = track[track.length - 1];
      let x: number;
      let y: number;
      let z: number;
      if (currentTimeMs <= first.timeMs) {
        x = first.x;
        y = first.y;
        z = first.z;
      } else if (currentTimeMs >= last.timeMs) {
        x = last.x;
        y = last.y;
        z = last.z;
      } else {
        // track[i-1].timeMs <= t < track[i].timeMs
        let i = 1;
        while (i < track.length && track[i].timeMs <= currentTimeMs) i += 1;
        const a = track[i - 1];
        const b = track[i];
        if (b.jump) {
          // jumpPosition=1：保持 a 的位置直到 b.timeMs 再瞬间切换
          x = a.x;
          y = a.y;
          z = a.z;
        } else {
          const span = b.timeMs - a.timeMs;
          const f = span > 0 ? (currentTimeMs - a.timeMs) / span : 1;
          x = a.x + (b.x - a.x) * f;
          y = a.y + (b.y - a.y) * f;
          z = a.z + (b.z - a.z) * f;
        }
      }
      node.root.position.set(x, z, -y);
    }
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.viewW = width;
    this.viewH = height;
    this.renderer.setSize(Math.max(width, 1), Math.max(height, 1), false);
    this.fitCamera(width, height);
  }

  dispose(): void {
    // 对象节点：材质各自持有；球几何为所有节点共享，只释放一次
    for (const node of this.nodes.values()) {
      for (const m of node.materials) m.dispose();
    }
    this.sphereGeometry.dispose();
    // 场景其余 Mesh/LineSegments（听者环、房间线框等）：跳过共享球几何，避免重复 dispose
    this.scene.traverse((obj) => {
      if (
        (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) &&
        obj.geometry !== this.sphereGeometry
      ) {
        obj.geometry.dispose();
        const material = obj.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    });
    this.glowTexture.dispose();
    this.nodes.clear();
    this.nodeList.length = 0;
    this.renderer.dispose();
    // ponytail: 只释放 renderer；若频繁创建/销毁实例（浏览器 GL 上下文上限 ~16），再加 forceContextLoss()
  }

  // 按宽高比沿视线后移相机，保证包围球始终完整入镜（竖屏面板不裁边）
  private fitCamera(width: number, height: number): void {
    const aspect = Math.max(width, 1) / Math.max(height, 1);
    this.camera.aspect = aspect;
    const halfV = (this.camera.fov * Math.PI) / 360;
    const halfH = Math.atan(Math.tan(halfV) * aspect);
    const distance = this.fitRadius / Math.sin(Math.min(halfV, halfH));
    this.camera.position.copy(CAMERA_DIR).multiplyScalar(distance);
    this.camera.lookAt(CAMERA_TARGET);
    this.camera.updateProjectionMatrix();
  }

  private createNode(key: string): ObjectNode {
    // 高饱和 + 中低明度：相邻对象单凭色相就能分辨，加色光晕也不会把本色洗成白
    const color = new THREE.Color().setHSL(hueFromKey(key) / 360, 0.85, 0.58);
    const body = new THREE.MeshBasicMaterial({ color });
    const halo = new THREE.SpriteMaterial({
      map: this.glowTexture,
      color,
      transparent: true,
      opacity: 0.5,
      depthTest: false, // 光晕始终叠在小球上，形成柔和外发光
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const root = new THREE.Mesh(this.sphereGeometry, body);
    const sprite = new THREE.Sprite(halo);
    sprite.scale.setScalar(OBJECT_RADIUS * 4.5);
    sprite.renderOrder = 1;
    root.add(sprite);
    return { root, materials: [body, halo] };
  }
}
