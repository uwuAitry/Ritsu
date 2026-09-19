// 原生 PCM/float WAV(C) 解码：ADM BWF 多为 10/12 声道 24-bit 未压缩 PCM，
// 浏览器 decodeAudioData 会拒绝。这里分两步避免一次性物化全部样本：
// readWavInfo 只读元数据（含 dwChannelMask），decodeWavToStereo 单遍解码 +
// 声道角色感知降混直写调用方立体声数组，必要时整体限峰。
// 复用 ../adm/parse 的容器遍历（含 RF64/BW64 ds64 覆盖），不重复实现。
import { walkRiffChunks } from "../adm/parse";
import { ACTIVITY_WINDOW_MS } from "../types";

export interface WavInfo {
  channelCount: number;
  sampleRate: number;
  frameCount: number;
  /** 第一个样本帧的绝对字节偏移 */
  dataOffset: number;
  blockAlign: number;
  bitsPerSample: number;
  validBits: number;
  isFloat: boolean;
  /** dwChannelMask（WAVE_FORMAT_EXTENSIBLE）；0 = 未知/非 extensible。 */
  channelMask: number;
}

// 对象活动检测：窗内 RMS 高于此值（≈ -60 dBFS）记为「发声」。
// 内部常数不暴露 UI——母带里数字静音与可闻声之间隔得很开。
const ACTIVITY_RMS_THRESHOLD = 0.001;

/** 活动时间线的窗数：ceil(frameCount / 每窗帧数)；与 decodeWavToStereo 的分段严格一致 */
export function activityWindowCount(frameCount: number, sampleRate: number): number {
  const framesPerWindow = Math.max(1, Math.round((sampleRate * ACTIVITY_WINDOW_MS) / 1000));
  return Math.max(1, Math.ceil(frameCount / framesPerWindow));
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

/** RIFF/RF64/BW64 WAVE 且为受支持 PCM/float 时返回元数据，否则 null。不分配样本存储。 */
export function readWavInfo(buffer: ArrayBuffer): WavInfo | null {
  const walked = walkRiffChunks(buffer);
  if (!walked) return null;

  const fmtChunk = walked.chunks.find((c) => c.id === "fmt ");
  const dataChunk = walked.chunks.find((c) => c.id === "data");
  if (!fmtChunk || !dataChunk) return null;

  const bufLen = buffer.byteLength;
  if (fmtChunk.size < 16 || fmtChunk.offset + 16 > bufLen) return null;

  const dv = new DataView(buffer);
  let audioFormat = dv.getUint16(fmtChunk.offset, true);
  const channelCount = dv.getUint16(fmtChunk.offset + 2, true);
  const sampleRate = dv.getUint32(fmtChunk.offset + 4, true);
  const blockAlign = dv.getUint16(fmtChunk.offset + 12, true);
  const bitsPerSample = dv.getUint16(fmtChunk.offset + 14, true);
  let validBits = bitsPerSample;
  let channelMask = 0;

  if (audioFormat === FORMAT_EXTENSIBLE) {
    // cbSize(u16) / validBits(u16) / channelMask(u32) / SubFormat GUID(16B)
    if (fmtChunk.size < 40 || fmtChunk.offset + 40 > bufLen) return null;
    const cbSize = dv.getUint16(fmtChunk.offset + 16, true);
    if (cbSize < 22) return null;
    const v = dv.getUint16(fmtChunk.offset + 18, true);
    validBits = v > 0 && v <= bitsPerSample ? v : bitsPerSample;
    channelMask = dv.getUint32(fmtChunk.offset + 20, true);
    // GUID 首 4 字节小端即真实 format code；取前 2 字节足够。
    audioFormat = dv.getUint16(fmtChunk.offset + 24, true);
  }

  if (audioFormat !== FORMAT_PCM && audioFormat !== FORMAT_FLOAT) return null;
  const isFloat = audioFormat === FORMAT_FLOAT;
  // ponytail: 仅 16/24/32 位 int 与 32 位 float；8 位 / 压缩 / ADPCM 走 decodeAudioData 兜底。
  if (isFloat && bitsPerSample !== 32) return null;
  if (!isFloat && bitsPerSample !== 16 && bitsPerSample !== 24 && bitsPerSample !== 32) {
    return null;
  }
  if (channelCount === 0 || blockAlign === 0 || sampleRate === 0) return null;

  const bytesPerSample = bitsPerSample / 8;
  if (blockAlign < channelCount * bytesPerSample) return null;

  const dataBytes = Math.min(
    dataChunk.size,
    Math.max(0, bufLen - dataChunk.offset),
  );
  const frameCount = Math.floor(dataBytes / blockAlign);

  return {
    channelCount,
    sampleRate,
    frameCount,
    dataOffset: dataChunk.offset,
    blockAlign,
    bitsPerSample,
    validBits,
    isFloat,
    channelMask,
  };
}

// ── 声道角色 → 立体声增益（ITU-R BS.775 Lo/Ro 系数） ──────────────

const S = 0.7071067811865476;

type RoleGain = readonly [gainL: number, gainR: number];

// ksmedia SPEAKER_* 位 → (L, R) 增益；按位升序遍历即 WAVE 交织声道顺序。
const ROLE_BY_BIT = new Map<number, RoleGain>([
  [0x1, [1.0, 0]], // FrontLeft
  [0x2, [0, 1.0]], // FrontRight
  [0x4, [S, S]], // FrontCenter
  [0x8, [0, 0]], // LFE：直接丢弃
  [0x10, [S, 0]], // BackLeft / RearLeft
  [0x20, [0, S]], // BackRight / RearRight
  [0x40, [S, 0]], // FrontLeftCenter
  [0x80, [0, S]], // FrontRightCenter
  [0x100, [S, S]], // BackCenter
  [0x200, [S, 0]], // SideLeft
  [0x400, [0, S]], // SideRight
  [0x800, [S, S]], // TopCenter
  [0x1000, [S, 0]], // TopFrontLeft
  [0x2000, [S, S]], // TopFrontCenter
  [0x4000, [0, S]], // TopFrontRight
  [0x8000, [S, 0]], // TopBackLeft
  [0x10000, [S, S]], // TopBackCenter
  [0x20000, [0, S]], // TopBackRight
]);
const UNKNOWN_GAIN: RoleGain = [S, S];

// 无掩码时按声道数定位（旧 WAVE 位置约定）。单声道不走此表，见 decodeWavToStereo。
const LADDER_MASK = new Map<number, number>([
  [2, 0x3], // L R
  [3, 0x7], // L R C
  [4, 0x603], // L R SL SR
  [5, 0x607], // L R C SL SR
  [6, 0x60f], // L R C LFE SL SR
  [7, 0x637], // L R C RL RR SL SR
  [8, 0x63f], // L R C LFE RL RR SL SR
]);

// 掩码位升序 → 第 n 个置位对应声道 n；位不足的余下声道无角色，走 S/S。
function assignChannelGains(
  mask: number,
  channelCount: number,
  gainL: Float32Array,
  gainR: Float32Array,
): void {
  let remaining = mask >>> 0;
  let ch = 0;
  while (remaining !== 0 && ch < channelCount) {
    const bit = remaining & -remaining;
    remaining ^= bit;
    const g = ROLE_BY_BIT.get(bit) ?? UNKNOWN_GAIN;
    gainL[ch] = g[0];
    gainR[ch] = g[1];
    ch++;
  }
  for (; ch < channelCount; ch++) {
    gainL[ch] = S;
    gainR[ch] = S;
  }
}

/** 单遍解码 + 声道角色降混直写调用方立体声数组；仅写 [0, info.frameCount)。
 *  activityOut 提供时（每声道一个窗位图，长度 = activityWindowCount），在同一次循环里
 *  逐声道累计 RMS、按 100ms 窗写 0/1——不物化多声道缓冲，也不跑第二遍。 */
export function decodeWavToStereo(
  buffer: ArrayBuffer,
  info: WavInfo,
  left: Float32Array,
  right: Float32Array,
  activityOut?: Uint8Array[],
): void {
  const { dataOffset, blockAlign, channelCount, frameCount, channelMask } = info;
  const { bitsPerSample, validBits, isFloat } = info;

  // 每声道增益表只建一次，绝不放帧循环里。
  const gainL = new Float32Array(channelCount);
  const gainR = new Float32Array(channelCount);
  if (channelCount === 1) {
    // 单声道等功率直出双声道：不做 C 的 -3dB，否则同一内容比立体声低 3dB。
    gainL.fill(1);
    gainR.fill(1);
  } else if (channelMask !== 0) {
    assignChannelGains(channelMask, channelCount, gainL, gainR);
  } else {
    const ladder = LADDER_MASK.get(channelCount);
    if (ladder !== undefined) {
      assignChannelGains(ladder, channelCount, gainL, gainR);
    } else {
      // >8 且无掩码：仅凭声道数无法区分 5.1.4 / 7.1.2，退回平铺平均。
      // ponytail: 升级路径 = 解析 ADM chna chunk（track index → channel mask），Cavern 即此法。
      const flat = 1 / channelCount;
      gainL.fill(flat);
      gainR.fill(flat);
    }
  }

  const dv = new DataView(buffer);
  const bytesPerSample = bitsPerSample / 8;
  const shift = bitsPerSample - validBits;

  // 活动检测累加器：逐声道能量平方和，每 100ms 窗 finalize 一次（不需要时零开销）
  const framesPerWindow = Math.max(1, Math.round((info.sampleRate * ACTIVITY_WINDOW_MS) / 1000));
  const sumSq = activityOut ? new Float64Array(channelCount) : null;
  let windowStart = 0;
  let windowIndex = 0;
  const flushWindow = (endFrame: number): void => {
    if (!activityOut || !sumSq) return;
    const frames = Math.max(1, endFrame - windowStart);
    for (let c = 0; c < channelCount; c++) {
      const slots = activityOut[c];
      if (slots && windowIndex < slots.length) {
        slots[windowIndex] = Math.sqrt(sumSq[c] / frames) > ACTIVITY_RMS_THRESHOLD ? 1 : 0;
      }
      sumSq[c] = 0;
    }
    windowIndex += 1;
    windowStart = endFrame;
  };
  const divisor =
    bitsPerSample === 16
      ? 32768
      : bitsPerSample === 24
        ? 8388608
        : 2147483648;

  for (let f = 0; f < frameCount; f++) {
    const frameBase = dataOffset + f * blockAlign;
    let sumL = 0;
    let sumR = 0;
    for (let c = 0; c < channelCount; c++) {
      const p = frameBase + c * bytesPerSample;
      let s: number;
      if (isFloat) {
        s = dv.getFloat32(p, true);
      } else {
        let n: number;
        if (bitsPerSample === 16) {
          n = dv.getInt16(p, true);
        } else if (bitsPerSample === 24) {
          n =
            dv.getUint8(p) |
            (dv.getUint8(p + 1) << 8) |
            (dv.getUint8(p + 2) << 16);
          if (n & 0x800000) n -= 0x1000000;
        } else {
          n = dv.getInt32(p, true);
        }
        // 24-in-32 等：有效位小于容器位时先右移对齐再缩放。
        if (shift > 0) n >>= shift;
        s = n / divisor;
      }
      if (sumSq) sumSq[c] += s * s;
      sumL += s * gainL[c];
      sumR += s * gainR[c];
    }
    left[f] = sumL;
    right[f] = sumR;
    if (sumSq && f + 1 - windowStart >= framesPerWindow) flushWindow(f + 1);
  }
  // 末窗不足 100ms 也照常 finalize（部分窗按实际帧数取 RMS）
  if (sumSq && frameCount > windowStart) flushWindow(frameCount);

  // 0.7071 系数下多声道可叠加超过 1.0，硬削波会毁掉导出画面 → 整体限峰。
  // ponytail: 单一全局系数而非分块限制器，一处瞬态会压低全曲。
  // 升级路径 = Cavern 式逐块峰值限制器（~240 样本块，~0.9 天花板，上行缓慢恢复）。
  let peak = 0;
  for (let f = 0; f < frameCount; f++) {
    const al = Math.abs(left[f]);
    const ar = Math.abs(right[f]);
    if (al > peak) peak = al;
    if (ar > peak) peak = ar;
  }
  if (peak > 0.99) {
    // 左右共用同一系数，保持立体声像。
    const k = 0.99 / peak;
    for (let f = 0; f < frameCount; f++) {
      left[f] *= k;
      right[f] *= k;
    }
  }
}
