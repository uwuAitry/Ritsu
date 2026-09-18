// 多声道 → 立体声降混
// ponytail: 简单算术平均；升级路径 = 按声道权重 / HRTF 对象式降混（v1 不做真正 Atmos 渲染）
export function downmixToStereo(
  ctx: BaseAudioContext,
  buffer: AudioBuffer
): AudioBuffer {
  if (buffer.numberOfChannels <= 2) return buffer;

  const out = ctx.createBuffer(2, buffer.length, buffer.sampleRate);
  const left = out.getChannelData(0);
  const right = out.getChannelData(1);
  const n = buffer.numberOfChannels;
  const channels: Float32Array[] = [];
  for (let c = 0; c < n; c++) channels.push(buffer.getChannelData(c));

  for (let i = 0; i < buffer.length; i++) {
    let sum = 0;
    for (let c = 0; c < n; c++) sum += channels[c][i];
    const avg = sum / n;
    left[i] = avg;
    right[i] = avg;
  }

  return out;
}
