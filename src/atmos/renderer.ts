import * as THREE from "three";
import type { AdmObject } from "../types";

// AtmosRenderer：ADM 摆位 3D 视图。
// 只拥有一个离屏 canvas（不挂载 DOM、不是 React 组件），由 compositor drawImage 到 1920×1080 主画布。

// 单位球半径 = ADM 距离 1；对象小球半径（世界单位）
const OBJECT_RADIUS = 0.05;
// 需完整入镜的包围球半径（单位球 + 光晕余量）
const FIT_RADIUS = 1.25;
// 相机方向：原点后方偏上。ADM 前方映射到屏幕内，形成“玻璃后的房间”透视
const CAMERA_DIR = new THREE.Vector3(0, 1.6, 3.2).normalize();
const CAMERA_TARGET = new THREE.Vector3(0, 0.05, 0);

type ObjectNode = {
  root: THREE.Mesh;
  materials: THREE.Material[];
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

export class AtmosRenderer {
  readonly canvas: HTMLCanvasElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly nodes = new Map<string, ObjectNode>();
  private readonly sphereGeometry: THREE.SphereGeometry;
  private readonly glowTexture: THREE.CanvasTexture;
  private timeMs = 0;

  constructor(width: number, height: number) {
    this.canvas = document.createElement("canvas");
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    // 透明底：合成时露出 compositor 的背景
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setSize(width, height, false);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
    this.sphereGeometry = new THREE.SphereGeometry(OBJECT_RADIUS, 16, 12);
    this.glowTexture = makeGlowTexture();

    // 原点听者标记：细环，标示听者位置；既不是音频对象也不是测距标尺
    this.scene.add(
      new THREE.Mesh(
        new THREE.TorusGeometry(0.05, 0.007, 8, 40),
        new THREE.MeshBasicMaterial({ color: 0x9fb0c4, transparent: true, opacity: 0.4, depthWrite: false }),
      ),
    );

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
  }

  setTime(currentTimeMs: number): void {
    // ponytail: v1 摆位静态（每个对象固定 x/y/z），时间只记录；
    // 后续若随 audioBlockFormat 关键帧插值，在这里重算 node.root.position
    this.timeMs = currentTimeMs;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(Math.max(width, 1), Math.max(height, 1), false);
    this.fitCamera(width, height);
  }

  dispose(): void {
    // 场景里只有 Mesh（对象小球、听者环）和 Sprite（光晕）；无 Line/LineSegments 之类
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const material = obj.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      } else if (obj instanceof THREE.Sprite) {
        obj.material.dispose();
      }
    });
    this.glowTexture.dispose();
    this.nodes.clear();
    this.renderer.dispose();
    // ponytail: 只释放 renderer；若频繁创建/销毁实例（浏览器 GL 上下文上限 ~16），再加 forceContextLoss()
  }

  // 按宽高比沿视线后移相机，保证包围球始终完整入镜（竖屏面板不裁边）
  private fitCamera(width: number, height: number): void {
    const aspect = Math.max(width, 1) / Math.max(height, 1);
    this.camera.aspect = aspect;
    const halfV = (this.camera.fov * Math.PI) / 360;
    const halfH = Math.atan(Math.tan(halfV) * aspect);
    const distance = FIT_RADIUS / Math.sin(Math.min(halfV, halfH));
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
