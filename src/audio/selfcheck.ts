// 音频 PCM 解析最小自检：无测试框架，assert 抛错即失败。
// 运行方式（浏览器控制台 / Node>=18）：
//   import { runSelfCheck } from "./src/audio/selfcheck"; runSelfCheck();

import { readWavInfo, decodeWavToStereo } from "./wav";

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
  // 16-bit 立体声 2 帧：frame0 L=R=0x7fff；frame1 L=0x0000, R=0x4000
  const stereo = buildWav(
    { audioFormat: 1, channelCount: 2, sampleRate: 48000, bitsPerSample: 16 },
    [0xff, 0x7f, 0xff, 0x7f, 0x00, 0x00, 0x00, 0x40],
  );
  const s = readWavInfo(stereo);
  assert(s !== null, "16-bit stereo not parsed");
  assert(s!.channelCount === 2, "stereo channelCount");
  assert(s!.frameCount === 2, "stereo frameCount");
  assert(s!.sampleRate === 48000, "stereo sampleRate");
  // 头 44 字节后即第一样本帧；读取 dataOffset 处应得 L0 = 0x7fff。
  assert(s!.dataOffset === 44, "stereo dataOffset");
  assert(
    new DataView(stereo).getInt16(s!.dataOffset, true) === 0x7fff,
    "dataOffset points at first sample frame",
  );

  const sl = new Float32Array(2);
  const sr = new Float32Array(2);
  decodeWavToStereo(stereo, s!, sl, sr);
  // 降混为平均：frame0 两声道均 32767/32768；frame1 平均 (0 + 0.5)/2 = 0.25。
  assert(approx(sl[0], 32767 / 32768), "stereo L0");
  assert(approx(sr[0], 32767 / 32768), "stereo R0");
  assert(approx(sl[1], 0.25), "stereo L1");
  assert(approx(sr[1], 0.25), "stereo R1");

  // 24-bit 单声道 1 帧：0x400000 = 0.5
  const mono24 = buildWav(
    { audioFormat: 1, channelCount: 1, sampleRate: 48000, bitsPerSample: 24 },
    [0x00, 0x00, 0x40],
  );
  const m = readWavInfo(mono24);
  assert(m !== null, "24-bit mono not parsed");
  assert(m!.channelCount === 1, "mono channelCount");
  assert(m!.frameCount === 1, "mono frameCount");
  const ml = new Float32Array(1);
  const mr = new Float32Array(1);
  decodeWavToStereo(mono24, m!, ml, mr);
  assert(approx(ml[0], 0.5), "mono L");
  assert(approx(mr[0], 0.5), "mono R");

  // 4 声道 16-bit 单帧：0x4000, 0x4000, 0x0000, 0x0000 → 平均 0.25
  const quad = buildWav(
    { audioFormat: 1, channelCount: 4, sampleRate: 48000, bitsPerSample: 16 },
    [0x00, 0x40, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00],
  );
  const q = readWavInfo(quad);
  assert(q !== null, "4ch not parsed");
  assert(q!.channelCount === 4, "4ch channelCount");
  assert(q!.frameCount === 1, "4ch frameCount");
  const ql = new Float32Array(1);
  const qr = new Float32Array(1);
  decodeWavToStereo(quad, q!, ql, qr);
  assert(approx(ql[0], 0.25), "4ch downmix L");
  assert(approx(qr[0], 0.25), "4ch downmix R");

  // 非 WAV → null
  assert(
    readWavInfo(new Uint8Array(64).buffer as ArrayBuffer) === null,
    "non-WAV should be null",
  );
}
