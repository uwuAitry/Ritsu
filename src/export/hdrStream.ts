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
import { renderStereo } from "./offline";

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
  readonly backend: "cpu" | "webgpu";
  convert(canvas: HTMLCanvasElement, peakNits: number): Promise<HdrConverted>;
}

/** CPU 转换器：读 2D canvas 像素（sRGB 8bit）→ 线性 nit → PQ → gbrp10le + 统计。 */
export function createCpuConverter(): HdrFrameConverter {
  return {
    backend: "cpu",
    async convert(canvas, peakNits) {
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
/** packed 10bit 码值（G | B<<10 | R<<20）→ gbrp10le 字节流（小端），返回 G,B,R 平面交错 */
export function gbrpFromPacked(packed: Uint32Array, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels * 6);
  const dv = new DataView(out.buffer);
  for (let p = 0; p < pixels; p += 1) {
    const v = packed[p];
    const g = v & PQ_CODE_MAX;
    const b = (v >>> 10) & PQ_CODE_MAX;
    const r = (v >>> 20) & PQ_CODE_MAX;
    dv.setUint16(p * 2, g, true);
    dv.setUint16(pixels * 2 + p * 2, b, true);
    dv.setUint16(pixels * 4 + p * 2, r, true);
  }
  return out;
}

// WebGPU 计算着色器：sRGB 8bit → 线性 → 绝对亮度(nit) → PQ，全程 f32；输出 packed 10bit 码值
// + 每像素 nit（CPU 侧做精确百分位统计）。数值与 CPU 转换器逐行一致，须同步修改。
// ponytail: 源仍是 8bit 2D 画布；把舞台本身画到 rgba16float 才是真正全链路浮点（后续）。
const HDR_WGSL = `
struct Params { width: u32, height: u32, peak: f32, pad: f32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> codes: array<u32>;
@group(0) @binding(2) var<storage, read_write> nits: array<f32>;
@group(0) @binding(3) var<uniform> p: Params;

fn srgb_to_linear(c: f32) -> f32 {
  if (c <= 0.04045) { return c / 12.92; }
  return pow((c + 0.055) / 1.055, 2.4);
}
fn sdr_to_nits(lin: f32) -> f32 {
  let base = clamp(lin, 0.0, 1.0) * 100.0;
  let e = max(0.0, (lin - 0.7) / 0.3);
  let boost = e * e * (p.peak - 100.0);
  return min(p.peak, base + boost);
}
fn pq_inv(n: f32) -> f32 {
  let y = clamp(n / 10000.0, 0.0, 1.0);
  let ym = pow(y, 2610.0 / 16384.0);
  let num = 3424.0 / 4096.0 + (2413.0 / 4096.0 * 32.0) * ym;
  let den = 1.0 + (2392.0 / 4096.0 * 32.0) * ym;
  return pow(num / den, (2523.0 / 4096.0) * 128.0);
}
fn pq10(n: f32) -> u32 { return u32(round(pq_inv(n) * 1023.0)); }

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= p.width || gid.y >= p.height) { return; }
  let idx = gid.y * p.width + gid.x;
  let t = textureLoad(src, vec2<i32>(i32(gid.x), i32(gid.y)), 0);
  let nr = sdr_to_nits(srgb_to_linear(t.r));
  let ng = sdr_to_nits(srgb_to_linear(t.g));
  let nb = sdr_to_nits(srgb_to_linear(t.b));
  nits[idx * 3u] = nr;
  nits[idx * 3u + 1u] = ng;
  nits[idx * 3u + 2u] = nb;
  codes[idx] = (pq10(ng) & 1023u) | ((pq10(nb) & 1023u) << 10u) | ((pq10(nr) & 1023u) << 20u);
}
`;

// WebGPU 类型未随 TS lib.dom 提供，内部用宽松类型承接 device/buffer（对外 API 仍强类型）。
type GpuAny = any;

/** WebGPU 转换器：PQ 颜色管线在 compute shader 内以 f32 完成。需在有 navigator.gpu 的浏览器调用。 */
export async function createWebGpuConverter(): Promise<HdrFrameConverter> {
  const gpu = (navigator as unknown as { gpu?: GpuAny }).gpu;
  if (!gpu) throw new Error("WebGPU 不可用（navigator.gpu 缺失）");
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error("WebGPU 无可请求的 adapter");
  const device: GpuAny = await adapter.requestDevice();
  const GU = globalThis as unknown as GpuAny;
  const module = device.createShaderModule({ code: HDR_WGSL });
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });

  let tex: GpuAny = null;
  let uni: GpuAny = null;
  let codesBuf: GpuAny = null;
  let nitsBuf: GpuAny = null;
  let codesRead: GpuAny = null;
  let nitsRead: GpuAny = null;
  let curW = 0;
  let curH = 0;

  const ensure = (w: number, h: number): void => {
    if (w === curW && h === curH) return;
    for (const b of [tex, uni, codesBuf, nitsBuf, codesRead, nitsRead]) if (b) b.destroy();
    curW = w;
    curH = h;
    const pixels = w * h;
    tex = device.createTexture({
      size: { width: w, height: h },
      format: "rgba8unorm",
      usage: GU.GPUTextureUsage.COPY_DST | GU.GPUTextureUsage.TEXTURE_BINDING | GU.GPUTextureUsage.RENDER_ATTACHMENT,
    });
    uni = device.createBuffer({ size: 16, usage: GU.GPUBufferUsage.UNIFORM | GU.GPUBufferUsage.COPY_DST });
    codesBuf = device.createBuffer({ size: pixels * 4, usage: GU.GPUBufferUsage.STORAGE | GU.GPUBufferUsage.COPY_SRC });
    nitsBuf = device.createBuffer({ size: pixels * 12, usage: GU.GPUBufferUsage.STORAGE | GU.GPUBufferUsage.COPY_SRC });
    codesRead = device.createBuffer({ size: pixels * 4, usage: GU.GPUBufferUsage.COPY_DST | GU.GPUBufferUsage.MAP_READ });
    nitsRead = device.createBuffer({ size: pixels * 12, usage: GU.GPUBufferUsage.COPY_DST | GU.GPUBufferUsage.MAP_READ });
  };

  return {
    backend: "webgpu",
    async convert(canvas: HTMLCanvasElement, peakNits: number): Promise<HdrConverted> {
      const w = canvas.width;
      const h = canvas.height;
      const pixels = w * h;
      ensure(w, h);
      device.queue.copyExternalImageToTexture({ source: canvas, flipY: false }, { texture: tex }, { width: w, height: h });
      const ub = new ArrayBuffer(16);
      const udv = new DataView(ub);
      udv.setUint32(0, w, true);
      udv.setUint32(4, h, true);
      udv.setFloat32(8, peakNits, true);
      device.queue.writeBuffer(uni, 0, ub);
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: tex.createView() },
          { binding: 1, resource: { buffer: codesBuf } },
          { binding: 2, resource: { buffer: nitsBuf } },
          { binding: 3, resource: { buffer: uni } },
        ],
      });
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      pass.end();
      enc.copyBufferToBuffer(codesBuf, 0, codesRead, 0, pixels * 4);
      enc.copyBufferToBuffer(nitsBuf, 0, nitsRead, 0, pixels * 12);
      device.queue.submit([enc.finish()]);
      await codesRead.mapAsync(GU.GPUMapMode.READ);
      await nitsRead.mapAsync(GU.GPUMapMode.READ);
      const codes = new Uint32Array(codesRead.getMappedRange().slice(0));
      const nits = new Float32Array(nitsRead.getMappedRange().slice(0));
      codesRead.unmap();
      nitsRead.unmap();
      return { gbrp: gbrpFromPacked(codes, pixels), measure: measureFrameLinear(nits) };
    },
  };
}

/** 优先 WebGPU（PQ 在 shader 内），不可用或初始化失败则回退 CPU。 */
export async function createBestConverter(): Promise<HdrFrameConverter> {
  try {
    if ((navigator as unknown as { gpu?: unknown }).gpu) {
      return await createWebGpuConverter();
    }
  } catch (e) {
    console.warn("HDR: WebGPU 转换器初始化失败，回退 CPU", e);
  }
  return createCpuConverter();
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
  /** 可选：已解码音频缓冲；传入则连同 HDR 视频一起封装成带音轨的 mp4 */
  buffer?: AudioBuffer;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface HdrStreamResult {
  path: string;
  frames: number;
  /** 实际使用的转换后端（cpu / webgpu） */
  backend: string;
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
    body: bytes as unknown as BodyInit,
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

async function postPcm(host: string, path: string, stereo: AudioBuffer, signal?: AbortSignal): Promise<void> {
  const left = stereo.getChannelData(0);
  const right = stereo.numberOfChannels > 1 ? stereo.getChannelData(1) : left;
  const total = stereo.length;
  const framesPerChunk = 1 << 17; // ≤1MB/块（交错立体声 f32le，小端）
  for (let off = 0; off < total; off += framesPerChunk) {
    if (signal?.aborted) throw new DOMException("HDR 导出已取消", "AbortError");
    const n = Math.min(framesPerChunk, total - off);
    const interleaved = new Float32Array(n * 2);
    for (let i = 0; i < n; i += 1) {
      interleaved[2 * i] = left[off + i];
      interleaved[2 * i + 1] = right[off + i];
    }
    await postBytes(host, path, new Uint8Array(interleaved.buffer));
  }
}

/**
 * 逐帧渲染 → WebGPU/CPU PQ 转换 → 流式 POST 到 HdrHost → finish 时提交 HDR10+ 元数据。
 * 单场景（sceneFrameIndex=帧内序号），符合现有"一条音频导一个视频"的用法。
 */
export async function exportHdrStream(opts: HdrStreamOptions): Promise<HdrStreamResult> {
  const { canvas, renderFrame, fps, frameCount, host, signal } = opts;
  const peakNits = opts.peakNits ?? 1000;
  if (frameCount <= 0) throw new Error("HDR 导出：帧数为 0");
  const width = canvas.width;
  const height = canvas.height;

  const sessionPayload: Record<string, unknown> = { width, height, fps };
  if (opts.buffer) {
    sessionPayload.audio_rate = opts.buffer.sampleRate;
    sessionPayload.audio_channels = 2;
  }
  const session = await postJson(host, "/session", sessionPayload);
  const id = String(session.id);
  const converter = await createBestConverter();
  const frames: Hdr10PlusFrame[] = [];

  for (let i = 0; i < frameCount; i += 1) {
    if (signal?.aborted) throw new DOMException("HDR 导出已取消", "AbortError");
    renderFrame((i / fps) * 1000);
    const { gbrp, measure } = await converter.convert(canvas, peakNits);
    await postBytes(host, `/session/${id}/frames`, gbrp);
    frames.push({ ...measure, sceneId: 0, sceneFrameIndex: i });
    opts.onProgress?.((i + 1) / frameCount);
  }

  if (opts.buffer) {
    const stereo = await renderStereo(opts.buffer);
    await postPcm(host, `/session/${id}/audio`, stereo, signal);
  }

  const meta = buildHdr10PlusJson(frames);
  const fin = await postJson(host, `/session/${id}/finish`, { meta });
  return { path: String(fin.path), frames: Number(fin.frames), backend: converter.backend };
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
  // packed(G|B<<10|R<<20) → gbrp 平面顺序与 gbrpFromRgba16 一致
  const pk = new Uint32Array([22 | (33 << 10) | (11 << 20), 55 | (66 << 10) | (44 << 20)]);
  const gbrp2 = gbrpFromPacked(pk, 2);
  const dv2 = new DataView(gbrp2.buffer);
  assert(dv2.getUint16(0, true) === 22 && dv2.getUint16(2, true) === 55, "packed G 平面");
  assert(dv2.getUint16(4, true) === 33 && dv2.getUint16(6, true) === 66, "packed B 平面");
  assert(dv2.getUint16(8, true) === 11 && dv2.getUint16(10, true) === 44, "packed R 平面");
}
