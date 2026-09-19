// 音频文件读取与解码
import type { AudioSource, AdmMetadata } from "../types";
import { parseAdmBwf } from "../adm/parse";
import { readWavInfo, decodeWavToStereo, activityWindowCount } from "./wav";
import { downmixToStereo } from "./downmix";

// 解码音频并组装 AudioSource。
// ponytail: 整个文件仍驻留单个 ArrayBuffer，~2GB+ 母带仍会失败；
// 升级路径 = 用 File.slice() 随机访问 data chunk 分块解码，避免整文件入内存。
export async function decodeAudioFile(
  ctx: BaseAudioContext,
  file: File,
): Promise<{ source: AudioSource; adm: AdmMetadata | null; activity: Uint8Array[] | null }> {
  const raw = await file.arrayBuffer();

  // ADM BWF 是未压缩多声道 PCM，浏览器 decodeAudioData 常拒绝 → 自行解 WAV。
  let decoded: AudioBuffer;
  let originalChannels: number;
  // 逐声道发声活动时间线：仅自研 PCM 路径产出。decodeAudioData 兜底路径不分析——
  // ponytail: ADM BWF 恒为 PCM，兜底路径不会出现 ADM 对象，活动门控对它自然 no-op
  let activity: Uint8Array[] | null = null;
  const info = readWavInfo(raw);
  if (info && info.frameCount > 0) {
    try {
      // 直接建 2 声道输出，解码+降混一次写入，不物化 12 声道中间缓冲。
      const out = ctx.createBuffer(2, info.frameCount, info.sampleRate);
      activity = Array.from({ length: info.channelCount }, () =>
        new Uint8Array(activityWindowCount(info.frameCount, info.sampleRate)),
      );
      decodeWavToStereo(raw, info, out.getChannelData(0), out.getChannelData(1), activity);
      decoded = out;
      originalChannels = info.channelCount;
    } catch {
      // 手动构建失败（如 0 帧）则回退原生解码
      decoded = await ctx.decodeAudioData(raw.slice(0));
      originalChannels = decoded.numberOfChannels;
      activity = null;
    }
  } else {
    // slice(0)：decodeAudioData 会 detach 传入的 ArrayBuffer，保留 raw 原样可用
    decoded = await ctx.decodeAudioData(raw.slice(0));
    originalChannels = decoded.numberOfChannels;
  }

  // 解析 ADM 后 raw 不再被返回，可随作用域释放（不再保留第二份 ~1GB 拷贝）。
  const adm = parseAdmBwf(raw);

  const source: AudioSource = {
    fileName: file.name,
    // 上报原始声道/采样率（ADM 常见 12 声道），供 UI 显示
    channelCount: originalChannels,
    sampleRate: decoded.sampleRate,
    durationSec: decoded.duration,
    // ponytail: 平铺平均降为立体声以便播放；升级路径 = 声道权重 / HRTF 对象式降混
    buffer:
      decoded.numberOfChannels <= 2 ? decoded : downmixToStereo(ctx, decoded),
    isAdm: adm !== null,
  };

  return { source, adm, activity };
}
