// 音频文件读取与解码
import type { AudioSource } from "../types";
import { parseAdmBwf } from "../adm/parse";

// 读取文件字节，保持原始 ArrayBuffer 供后续解析（如 ADM axml chunk）
export async function readFileBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

// 解码音频并组装 AudioSource；同时返回原始字节供调用方复用
export async function decodeAudioFile(
  ctx: BaseAudioContext,
  file: File
): Promise<{ source: AudioSource; raw: ArrayBuffer }> {
  const raw = await readFileBuffer(file);
  // slice(0)：decodeAudioData 会 detach 传入的 ArrayBuffer，保留 raw 原样可用
  const buffer = await ctx.decodeAudioData(raw.slice(0));
  const isAdm = parseAdmBwf(raw) != null;

  const source: AudioSource = {
    fileName: file.name,
    channelCount: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
    durationSec: buffer.duration,
    buffer,
    isAdm,
  };

  return { source, raw };
}
