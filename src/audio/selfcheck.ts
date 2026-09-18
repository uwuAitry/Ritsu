// 音频 PCM 解析最小自检：无测试框架，assert 抛错即失败。
// 运行方式（浏览器控制台 / Node>=18）：
//   import { runSelfCheck } from "./src/audio/selfcheck"; runSelfCheck();

import { parseWavPcm } from "./wav";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("audio selfcheck failed: " + msg);
}

function approx(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) <= eps;
}

interface FmtSpec {
  audioFormat: number;
  channelCount: number;
  sampleRate: number;
  bitsPerSample: number;
}

// 合成 44 字节头 + data 的 WAV。
function buildWav(spec: FmtSpec, data: number[]): ArrayBuffer {
  const blockAlign = spec.channelCount * (spec.bitsPerSample / 8);
  const bytes: number[] = [];
  const putStr = (s: string): void => {
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
  };
  const putU16 = (v: number): void => {
    bytes.push(v & 0xff, (v >>> 8) & 0xff);
  };
  const putU32 = (v: number): void => {
    bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  };

  putStr("RIFF");
  putU32(36 + data.length);
  putStr("WAVE");
  putStr("fmt ");
  putU32(16);
  putU16(spec.audioFormat);
  putU16(spec.channelCount);
  putU32(spec.sampleRate);
  putU32(spec.sampleRate * blockAlign);
  putU16(blockAlign);
  putU16(spec.bitsPerSample);
  putStr("data");
  putU32(data.length);
  for (let i = 0; i < data.length; i++) bytes.push(data[i] & 0xff);

  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

export function runSelfCheck(): void {
  // 16-bit 立体声 2 帧：L0=32767, R0=-32768, L1=0, R1=16384
  const stereo = buildWav(
    { audioFormat: 1, channelCount: 2, sampleRate: 48000, bitsPerSample: 16 },
    [0xff, 0x7f, 0x00, 0x80, 0x00, 0x00, 0x00, 0x40],
  );
  const s = parseWavPcm(stereo);
  assert(s !== null, "16-bit stereo not parsed");
  assert(s!.channelCount === 2, "stereo channelCount");
  assert(s!.frameCount === 2, "stereo frameCount");
  assert(s!.sampleRate === 48000, "stereo sampleRate");
  assert(approx(s!.samples[0], 32767 / 32768), "stereo L0");
  assert(approx(s!.samples[1], -1), "stereo R0");
  assert(approx(s!.samples[2], 0), "stereo L1");
  assert(approx(s!.samples[3], 0.5), "stereo R1");

  // 24-bit 单声道 1 帧：0x400000 = 0.5
  const mono24 = buildWav(
    { audioFormat: 1, channelCount: 1, sampleRate: 48000, bitsPerSample: 24 },
    [0x00, 0x00, 0x40],
  );
  const m = parseWavPcm(mono24);
  assert(m !== null, "24-bit mono not parsed");
  assert(m!.channelCount === 1, "mono channelCount");
  assert(m!.frameCount === 1, "mono frameCount");
  assert(approx(m!.samples[0], 0.5), "mono sample");

  // 非 WAV → null
  assert(
    parseWavPcm(new Uint8Array(64).buffer as ArrayBuffer) === null,
    "non-WAV should be null",
  );
}
