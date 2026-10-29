// HDR10+ 导出：把现有 2D 舞台画布逐帧转成 10-bit PQ 的 gbrp10le，统计 ST2094-40
// 亮度参数，并流式 POST 给本机 HdrHost（tools/hdr-host）→ ffmpeg/libx265 → hdr10plus_tool 注入。
//
// 只依赖 hdr10plus.ts 的纯函数；浏览器 API（canvas/fetch）仅在调用函数内使用，Node 自检安全。
//
// ponytail: 当前是 CPU 逐像素 PQ 转换（正确、可验证）。R1 要的 WebGPU 浮点渲染是同一
// HdrFrameConverter 接口背后的性能升级；升级时只换 convert()，流式链路与元数据不变。
import {
  buildHdr10PlusJson,
  measureFrameLinear,
  nitsToPq10,
  type Hdr10PlusFrame,
  type Hdr10PlusFrameMeasure,
} from "./hdr10plus";

const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;
const PQ_CODE_MAX = 1023;

/** ST2084 EOTF：10bit PQ 码值 → 绝对亮度(nit)（measure 用，和编码互逆） */
export function pq10ToNits(code: number): number {
  const e = Math.min(Math.max(code / PQ_CODE_MAX, 0), 1);
  const e1 = Math.pow(e, 1 / PQ_M2);
  const num = Math.max(e1 - PQ_C1, 0);
  const den = PQ_C2 - PQ_C3 * e1;
  const y = den > 0 ? Math.pow(num / den, 1 / PQ_M1) : 0;
  return y * 10_000;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * SDR 基底(线性 0..1 = 100nit) + 高光自发光扩展，输出绝对亮度(nit)，上限 peakNits。
 * 接近纯白(>0.7)的像素按二次曲线推到峰值，模拟 >100nit 的发光层。
 * ponytail: 单段启发式，不是真实 HDR 素材分析；后续 WebGPU 浮点层替换。
 */
export function sdrLinearToNits(lin: number, peakNits: number): number {
  const base = Math.max(0, Math.min(1, lin)) * 100;
  const e = Math.max(0, (lin - 0.7) / 0.3);
  const boost = e * e * (peakNits - 100);
  return Math.min(peakNits, base + boost);
}

/** RGBA(10bit 码值存于 uint16) → gbrp10le 字节流（小端），返回 G,B,R 平面交错 */
export function gbrpFromRgba16(rgba: Uint16Array, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels * 6);
  const dv = new DataView(out.buffer);
  for (let p = 0; p < pixels; p += 1) {
    const r = rgba[4 * p] & PQ_CODE_MAX;
    const g = rgba[4 * p + 1] & PQ_CODE_MAX;
    const b = rgba[4 * p + 2] & PQ_CODE_MAX;
    // gbrp10le 平面顺序：G 全帧、B 全帧、R 全帧
    dv.setUint16(p * 2, g, true);
    dv.setUint16(pixels * 2 + p * 2, b, true);
    dv.setUint16(pixels * 4 + p * 2, r, true);
  }
  return out;
}

export interface HdrConverted {
  /** gbrp10le 原始字节（6 字节/像素） */
  gbrp: Uint8Array;
  /** 该帧 ST2094-40 亮度统计 */
  measure: Hdr10PlusFrameMeasure;
}

export interface HdrFrameConverter {
  readonly backend: "cpu";
  convert(canvas: HTMLCanvasElement, peakNits: number): HdrConverted;
}

/** CPU 转换器：读 2D canvas 像素（sRGB 8bit）→ 线性 nit → PQ → gbrp10le + 统计。 */
export function createCpuConverter(): HdrFrameConverter {
  return {
    backend: "cpu",
    convert(canvas, peakNits) {
      const w = canvas.width;
      const h = canvas.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("HDR 转换：无法获取 2D context");
      const img = ctx.getImageData(0, 0, w, h).data;
      const pixels = w * h;
      const rgba16 = new Uint16Array(pixels * 4);
      const nitsRgb = new Float32Array(pixels * 3);
      for (let p = 0; p < pixels; p += 1) {
        const linR = srgbToLinear(img[4 * p] / 255);
        const linG = srgbToLinear(img[4 * p + 1] / 255);
        const linB = srgbToLinear(img[4 * p + 2] / 255);
        const nR = sdrLinearToNits(linR, peakNits);
        const nG = sdrLinearToNits(linG, peakNits);
        const nB = sdrLinearToNits(linB, peakNits);
        nitsRgb[3 * p] = nR;
        nitsRgb[3 * p + 1] = nG;
        nitsRgb[3 * p + 2] = nB;
        rgba16[4 * p] = nitsToPq10(nR);
        rgba16[4 * p + 1] = nitsToPq10(nG);
        rgba16[4 * p + 2] = nitsToPq10(nB);
        rgba16[4 * p + 3] = PQ_CODE_MAX;
      }
      return { gbrp: gbrpFromRgba16(rgba16, pixels), measure: measureFrameLinear(nitsRgb) };
    },
  };
}

export interface HdrStreamOptions {
  canvas: HTMLCanvasElement;
  /** 把第 timeMs 帧画到 canvas（调 StageRenderer.setTime + render） */
  renderFrame: (timeMs: number) => void;
  fps: number;
  frameCount: number;
  /** HdrHost 基址，如 http://127.0.0.1:8712 */
  host: string;
  peakNits?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface HdrStreamResult {
  path: string;
  frames: number;
}

async function postJson(host: string, path: string, payload: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(host + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HdrHost ${path} ${res.status}: ${text}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function postBytes(host: string, path: string, bytes: Uint8Array): Promise<void> {
  const res = await fetch(host + path, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  if (!res.ok) throw new Error(`HdrHost ${path} ${res.status}: ${await res.text()}`);
}

/** 探测本机 HdrHost 是否在线 */
export async function isHdrHostAvailable(host: string): Promise<boolean> {
  try {
    const res = await fetch(host + "/health", { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 逐帧渲染 → CPU/PQ 转换 → 流式 POST 到 HdrHost → finish 时提交 HDR10+ 元数据。
 * 单场景（sceneFrameIndex=帧内序号），符合现有"一条音频导一个视频"的用法。
 */
export async function exportHdrStream(opts: HdrStreamOptions): Promise<HdrStreamResult> {
  const { canvas, renderFrame, fps, frameCount, host, signal } = opts;
  const peakNits = opts.peakNits ?? 1000;
  if (frameCount <= 0) throw new Error("HDR 导出：帧数为 0");
  const width = canvas.width;
  const height = canvas.height;

  const session = await postJson(host, "/session", { width, height, fps });
  const id = String(session.id);
  const converter = createCpuConverter();
  const frames: Hdr10PlusFrame[] = [];

  for (let i = 0; i < frameCount; i += 1) {
    if (signal?.aborted) throw new DOMException("HDR 导出已取消", "AbortError");
    renderFrame((i / fps) * 1000);
    const { gbrp, measure } = converter.convert(canvas, peakNits);
    await postBytes(host, `/session/${id}/frames`, gbrp);
    frames.push({ ...measure, sceneId: 0, sceneFrameIndex: i });
    opts.onProgress?.((i + 1) / frameCount);
  }

  const meta = buildHdr10PlusJson(frames);
  const fin = await postJson(host, `/session/${id}/finish`, { meta });
  return { path: String(fin.path), frames: Number(fin.frames) };
}

export function runSelfCheck(): void {
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(`hdrStream selfcheck: ${msg}`);
  };

  // PQ 编解码互逆：1000nit → 码值 → nit，误差 <3%
  const code = nitsToPq10(1000);
  const back = pq10ToNits(code);
  assert(Math.abs(back - 1000) / 1000 < 0.03, `PQ roundtrip 1000nit (${back})`);
  assert(pq10ToNits(0) === 0, "PQ(0)=0");
  assert(Math.abs(pq10ToNits(1023) - 10_000) < 1, "PQ(1023)=10000nit");

  // sdr 高光扩展：纯白 → peak；中灰(0.5lin) → ~50nit
  assert(Math.abs(sdrLinearToNits(1, 1000) - 1000) < 1, "白→1000nit");
  assert(Math.abs(sdrLinearToNits(0.5, 1000) - 50) < 1, "0.5lin→50nit");

  // gbrp 平面顺序：2 像素，G 在前
  const rgba = new Uint16Array([
    11, 22, 33, 1023, // px0: r11 g22 b33
    44, 55, 66, 1023, // px1: r44 g55 b66
  ]);
  const gbrp = gbrpFromRgba16(rgba, 2);
  const dv = new DataView(gbrp.buffer);
  // G 平面 [22,55]，B 平面 [33,66]，R 平面 [11,44]
  assert(dv.getUint16(0, true) === 22 && dv.getUint16(2, true) === 55, "G 平面");
  assert(dv.getUint16(4, true) === 33 && dv.getUint16(6, true) === 66, "B 平面");
  assert(dv.getUint16(8, true) === 11 && dv.getUint16(10, true) === 44, "R 平面");
  assert(gbrp.length === 2 * 6, "gbrp 长度 = 像素*6");
}
