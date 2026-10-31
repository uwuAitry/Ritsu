// ST 2094-40（HDR10+）动态元数据生成 + ST2084(PQ) 编码。
// 纯函数、无副作用：浏览器渲染循环用它把线性光帧统计转成 hdr10plus_tool 可注入的 JSON；
// Node 下 selfcheck 直接引用，不触碰 DOM / WebCodecs。
//
// 数值约定（与 ST 2094-40 一致，且经 hdr10plus_tool 1.7.2 实测可注入）：
// - 线性绝对亮度单位 nit；1 nit = SDR 白 / 100（Q4：SDR 白 100nit）。
// - MaxScl / AverageRGB / 分布值 = round(nit * 10)，即归一化到 1.0 ⇔ 10000nit 再乘 1e5，上限 100000。

const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;
const PQ_CODE_MAX = 1023;
const SCL_MAX = 100_000;
/** ST 2094-40 规定的 9 个分布百分位，顺序/取值不可改（hdr10plus_tool 严格校验） */
export const HDR10PLUS_DISTRIBUTION_INDEXES = [1, 5, 10, 25, 50, 75, 90, 95, 99] as const;

/** ST2084 反 EOTF：绝对亮度(nit) → 归一化信号 [0,1] */
export function pqOetfInverse(nits: number): number {
  const y = Math.min(Math.max(nits / 10_000, 0), 1);
  const ym = Math.pow(y, PQ_M1);
  return Math.pow((PQ_C1 + PQ_C2 * ym) / (1 + PQ_C3 * ym), PQ_M2);
}

/** 线性绝对亮度(nit) → 10bit PQ 码值 (0..1023)，供 gbrp10le 直接写入 */
export function nitsToPq10(nits: number): number {
  return Math.round(pqOetfInverse(nits) * PQ_CODE_MAX);
}

/** nit → ST2094-40 亮度标度（0..100000） */
function toScl(nits: number): number {
  if (!Number.isFinite(nits) || nits <= 0) return 0;
  return Math.min(SCL_MAX, Math.round(nits * 10));
}

/** 已缩放亮度值（0..100000）直接裁剪取整 */
function clampScl(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(SCL_MAX, Math.max(0, Math.round(v)));
}

export interface Hdr10PlusFrameMeasure {
  /** 三个通道各自的最大线性亮度，已缩放为 0..100000 */
  maxScl: [number, number, number];
  /** 每像素 max(r,g,b) 的均值，已缩放为 0..100000 */
  averageRgb: number;
  /** 9 个百分位对应的亮度值（0..100000，非递减） */
  distribution: number[];
}

export interface Hdr10PlusScenePos {
  sceneId: number;
  sceneFrameIndex: number;
}

export type Hdr10PlusFrame = Hdr10PlusFrameMeasure & Hdr10PlusScenePos;

/** 线性插值百分位（p ∈ [0,100]），输入需已升序 */
function percentile(sorted: Float64Array, p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const t = rank - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

/**
 * 从线性光 RGB 帧（interleaved r,g,b，单位 nit）统计单帧 ST2094-40 亮度参数。
 * @param nitsRgb 长度须为 3×像素数
 */
export function measureFrameLinear(nitsRgb: ArrayLike<number>): Hdr10PlusFrameMeasure {
  const pixels = Math.floor(nitsRgb.length / 3);
  if (pixels <= 0) throw new Error("measureFrameLinear: 空帧");
  let maxR = 0;
  let maxG = 0;
  let maxB = 0;
  let sum = 0;
  const lum = new Float64Array(pixels);
  for (let p = 0; p < pixels; p += 1) {
    const r = nitsRgb[3 * p];
    const g = nitsRgb[3 * p + 1];
    const b = nitsRgb[3 * p + 2];
    if (r > maxR) maxR = r;
    if (g > maxG) maxG = g;
    if (b > maxB) maxB = b;
    const l = Math.max(r, g, b);
    lum[p] = l;
    sum += l;
  }
  lum.sort();
  const distribution = HDR10PLUS_DISTRIBUTION_INDEXES.map((p) => toScl(percentile(lum, p)));
  return {
    maxScl: [toScl(maxR), toScl(maxG), toScl(maxB)],
    averageRgb: toScl(sum / pixels),
    distribution,
  };
}

export interface Hdr10PlusJson {
  JSONInfo: { HDR10plusProfile: "A"; Version: "1.0" };
  SceneInfo: Array<{
    LuminanceParameters: {
      AverageRGB: number;
      LuminanceDistributions: { DistributionIndex: number[]; DistributionValues: number[] };
      MaxScl: number[];
    };
    NumberOfWindows: 1;
    TargetedSystemDisplayMaximumLuminance: 0;
    SceneFrameIndex: number;
    SceneId: number;
    SequenceFrameIndex: number;
  }>;
  SceneInfoSummary: { SceneFirstFrameIndex: number[]; SceneFrameNumbers: number[] };
  ToolInfo: { Tool: string; Version: string };
}

/**
 * 逐帧统计 → hdr10plus_tool 可注入的 HDR10+ JSON（Profile A，单窗口，无 Bezier）。
 * Profile A 要求 targeted_system_display_maximum_luminance 必须为 0。
 */
export function buildHdr10PlusJson(
  frames: Hdr10PlusFrame[],
  tool = "ritsu",
  version = "1",
): Hdr10PlusJson {
  if (frames.length === 0) throw new Error("buildHdr10PlusJson: 无帧");
  const idx = HDR10PLUS_DISTRIBUTION_INDEXES;

  const sceneInfo = frames.map((f, i) => {
    if (f.distribution.length !== idx.length) {
      throw new Error(
        `buildHdr10PlusJson: distribution 需 ${idx.length} 项，实际 ${f.distribution.length}`,
      );
    }
    return {
      LuminanceParameters: {
        AverageRGB: clampScl(f.averageRgb),
        LuminanceDistributions: {
          DistributionIndex: [...idx],
          DistributionValues: f.distribution.map(clampScl),
        },
        MaxScl: f.maxScl.map(clampScl),
      },
      NumberOfWindows: 1 as const,
      TargetedSystemDisplayMaximumLuminance: 0 as const,
      SceneFrameIndex: f.sceneFrameIndex,
      SceneId: f.sceneId,
      SequenceFrameIndex: i,
    };
  });

  // 每场景首帧 = sceneFrameIndex===0 的全局帧号；场景长度由首帧差推出
  const firstFrames: number[] = [];
  frames.forEach((f, i) => {
    if (f.sceneFrameIndex === 0) firstFrames.push(i);
  });
  if (firstFrames.length === 0) throw new Error("buildHdr10PlusJson: 缺 sceneFrameIndex=0 的首帧");
  const sceneLengths = firstFrames.map((start, k) =>
    k < firstFrames.length - 1 ? firstFrames[k + 1] - start : frames.length - start,
  );

  return {
    JSONInfo: { HDR10plusProfile: "A", Version: "1.0" },
    SceneInfo: sceneInfo,
    SceneInfoSummary: { SceneFirstFrameIndex: firstFrames, SceneFrameNumbers: sceneLengths },
    ToolInfo: { Tool: tool, Version: version },
  };
}

export function runSelfCheck(): void {
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(`hdr10plus selfcheck: ${msg}`);
  };
  const near = (a: number, b: number, eps: number, msg: string): void =>
    assert(Math.abs(a - b) <= eps, `${msg} (${a} vs ${b})`);

  // PQ：端点精确、单调
  assert(nitsToPq10(0) === 0, "PQ(0)=0");
  assert(nitsToPq10(10_000) === 1023, "PQ(10000)=1023");
  assert(nitsToPq10(20_000) === 1023, "PQ 超上限裁剪");
  let prev = -1;
  for (const nits of [0, 1, 10, 100, 203, 400, 1000, 4000, 10000]) {
    const code = nitsToPq10(nits);
    assert(code >= prev, `PQ 单调 @ ${nits}`);
    prev = code;
  }
  // ST2084 已知点：1000nit → 归一化信号 ≈0.7518
  near(pqOetfInverse(1000), 0.7518, 0.01, "PQ(1000nit)≈0.7518");

  // 单帧统计：两像素（红 400nit×1，绿 100nit×1 等）
  const frame = measureFrameLinear([400, 100, 50, 100, 100, 20]);
  assert(frame.maxScl[0] === 4000, `maxScl R=${frame.maxScl[0]}`);
  assert(frame.maxScl[1] === 1000, `maxScl G=${frame.maxScl[1]}`);
  assert(frame.maxScl[2] === 500, `maxScl B=${frame.maxScl[2]}`);
  assert(frame.averageRgb === 2500, `averageRgb=${frame.averageRgb}`);
  assert(frame.distribution.length === 9, "distribution 长度 9");
  for (let i = 1; i < frame.distribution.length; i += 1) {
    assert(frame.distribution[i] >= frame.distribution[i - 1], "distribution 非递减");
  }

  // 越界亮度裁剪到 100000
  const hot = measureFrameLinear([20_000, 20_000, 20_000]);
  assert(hot.maxScl.every((v) => v === 100_000), "maxScl 裁剪 100000");

  // JSON：两场景（3 帧 + 2 帧）
  const mk = (s: number, fi: number): Hdr10PlusFrame => ({
    ...measureFrameLinear([100, 100, 100]),
    sceneId: s,
    sceneFrameIndex: fi,
  });
  const json = buildHdr10PlusJson([mk(0, 0), mk(0, 1), mk(0, 2), mk(1, 0), mk(1, 1)]);
  assert(json.JSONInfo.HDR10plusProfile === "A" && json.JSONInfo.Version === "1.0", "JSONInfo");
  assert(json.SceneInfo.length === 5, "SceneInfo 长度=帧数");
  assert(json.SceneInfo[0].TargetedSystemDisplayMaximumLuminance === 0, "Profile A target=0");
  assert(json.SceneInfo[3].SceneId === 1 && json.SceneInfo[3].SceneFrameIndex === 0, "场景 1 首帧");
  assert(
    JSON.stringify(json.SceneInfoSummary.SceneFirstFrameIndex) === "[0,3]",
    "SceneFirstFrameIndex",
  );
  assert(JSON.stringify(json.SceneInfoSummary.SceneFrameNumbers) === "[3,2]", "SceneFrameNumbers");
  assert(
    JSON.stringify(json.SceneInfo[0].LuminanceParameters.LuminanceDistributions.DistributionIndex) ===
      JSON.stringify([1, 5, 10, 25, 50, 75, 90, 95, 99]),
    "DistributionIndex 固定 9 项",
  );

  // 边界：空帧 / 分布长度错误必须抛错
  let threw = false;
  try {
    buildHdr10PlusJson([]);
  } catch {
    threw = true;
  }
  assert(threw, "空帧抛错");
  threw = false;
  try {
    buildHdr10PlusJson([
      { maxScl: [0, 0, 0], averageRgb: 0, distribution: [0, 0], sceneId: 0, sceneFrameIndex: 0 },
    ]);
  } catch {
    threw = true;
  }
  assert(threw, "distribution 长度错误抛错");
}
