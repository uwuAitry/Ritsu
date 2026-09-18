// 音频文件读取与解码
import type { AudioSource } from "../types";
import { parseAdmBwf } from "../adm/parse";
import { parseWavPcm } from "./wav";
import { downmixToStereo } from "./downmix";

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

  // ADM BWF 是未压缩多声道 PCM，浏览器 decodeAudioData 常拒绝 → 自行解 WAV。
  let decoded: AudioBuffer;
  const wav = parseWavPcm(raw);
  if (wav) {
    try {
      const buf = ctx.createBuffer(
        wav.channelCount,
        wav.frameCount,
        wav.sampleRate,
      );
      for (let ch = 0; ch < wav.channelCount; ch++) {
        const dst = buf.getChannelData(ch);
        for (let f = 0; f < wav.frameCount; f++) {
          dst[f] = wav.samples[f * wav.channelCount + ch];
        }
      }
      decoded = buf;
    } catch {
      // 手动构建失败（如 0 帧）则回退原生解码
      decoded = await ctx.decodeAudioData(raw.slice(0));
    }
  } else {
    // slice(0)：decodeAudioData 会 detach 传入的 ArrayBuffer，保留 raw 原样可用
    decoded = await ctx.decodeAudioData(raw.slice(0));
  }

  const isAdm = parseAdmBwf(raw) != null;

  const source: AudioSource = {
    fileName: file.name,
    // 上报原始声道/采样率（ADM 常见 12 声道），供 UI 显示
    channelCount: decoded.numberOfChannels,
    sampleRate: decoded.sampleRate,
    durationSec: decoded.duration,
    // ponytail: 平铺平均降为立体声以便播放；升级路径 = 声道权重 / HRTF 对象式降混
    buffer: downmixToStereo(ctx, decoded),
    isAdm,
  };

  return { source, raw };
}
