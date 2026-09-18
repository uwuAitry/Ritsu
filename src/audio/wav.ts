// 原生 PCM/float WAV(C) 解码：ADM BWF 多为 10/12 声道 24-bit 未压缩 PCM，
// 浏览器 decodeAudioData 会拒绝，故自行解成 Float32。
// 复用 ../adm/parse 的容器遍历（含 RF64/BW64 ds64 覆盖），不重复实现。
import { walkRiffChunks } from "../adm/parse";

export interface WavPcm {
  channelCount: number;
  sampleRate: number;
  frameCount: number;
  /** 交织 float 采样，范围 [-1, 1]，长度 = frameCount * channelCount */
  samples: Float32Array;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

/** RIFF/RF64/BW64 WAVE 且为受支持 PCM/float 时返回解析结果，否则 null。 */
export function parseWavPcm(buffer: ArrayBuffer): WavPcm | null {
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

  if (audioFormat === FORMAT_EXTENSIBLE) {
    // cbSize(u16) / validBits(u16) / channelMask(u32) / SubFormat GUID(16B)
    if (fmtChunk.size < 40 || fmtChunk.offset + 40 > bufLen) return null;
    const cbSize = dv.getUint16(fmtChunk.offset + 16, true);
    if (cbSize < 22) return null;
    const v = dv.getUint16(fmtChunk.offset + 18, true);
    validBits = v > 0 && v <= bitsPerSample ? v : bitsPerSample;
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

  const samples = new Float32Array(frameCount * channelCount);
  const shift = bitsPerSample - validBits;
  const divisor =
    bitsPerSample === 16
      ? 32768
      : bitsPerSample === 24
        ? 8388608
        : 2147483648;

  for (let f = 0; f < frameCount; f++) {
    const frameBase = dataChunk.offset + f * blockAlign;
    for (let c = 0; c < channelCount; c++) {
      const p = frameBase + c * bytesPerSample;
      let out: number;
      if (isFloat) {
        out = dv.getFloat32(p, true);
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
        out = n / divisor;
      }
      samples[f * channelCount + c] = out;
    }
  }

  return { channelCount, sampleRate, frameCount, samples };
}
