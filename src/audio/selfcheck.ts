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
  /** 提供则写 WAVE_FORMAT_EXTENSIBLE（0xFFFE）+ dwChannelMask。 */
  channelMask?: number;
}

// 合成 WAV：默认 16 字节 fmt（44 字节头）；给了 channelMask 则 40 字节 fmt（68 字节头）。
function buildWav(spec: FmtSpec, data: number[]): ArrayBuffer {
  const blockAlign = spec.channelCount * (spec.bitsPerSample / 8);
  const extensible = spec.channelMask !== undefined;
  const fmtSize = extensible ? 40 : 16;
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
  putU32(4 + (8 + fmtSize) + (8 + data.length));
  putStr("WAVE");
  putStr("fmt ");
  putU32(fmtSize);
  if (extensible) {
    putU16(0xfffe);
    putU16(spec.channelCount);
    putU32(spec.sampleRate);
    putU32(spec.sampleRate * blockAlign);
    putU16(blockAlign);
    putU16(spec.bitsPerSample);
    putU16(22); // cbSize
    putU16(spec.bitsPerSample); // validBits
    putU32(spec.channelMask ?? 0); // dwChannelMask
    putU16(spec.audioFormat); // GUID 前 2 字节 = 真实 format code
    for (let i = 0; i < 14; i++) bytes.push(0);
  } else {
    putU16(spec.audioFormat);
    putU16(spec.channelCount);
    putU32(spec.sampleRate);
    putU32(spec.sampleRate * blockAlign);
    putU16(blockAlign);
    putU16(spec.bitsPerSample);
  }
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
  // 仅普通 44 字节头成立：头 44 字节后即第一样本帧。
  assert(s!.dataOffset === 44, "stereo dataOffset");
  assert(
    new DataView(stereo).getInt16(s!.dataOffset, true) === 0x7fff,
    "dataOffset points at first sample frame",
  );

  const sl = new Float32Array(2);
  const sr = new Float32Array(2);
  decodeWavToStereo(stereo, s!, sl, sr);
  // 2ch 定位为 L R：left 取 ch0，right 取 ch1。峰值 0x7fff > 0.99 → 整体限峰到 0.99。
  const k = 0.99 / (32767 / 32768);
  assert(approx(sl[0], 0.99), "stereo L0");
  assert(approx(sr[0], 0.99), "stereo R0");
  assert(approx(sl[1], 0), "stereo L1");
  assert(approx(sr[1], 0.5 * k), "stereo R1");

  // 24-bit 单声道 1 帧：0x400000 = 0.5（1ch → 双声道等功率直出，不衰减）
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

  // 4 声道 plain：L R SL SR；ch0/ch1 = 0.5，SL/SR = 0 → 左右各 0.5
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
  assert(approx(ql[0], 0.5), "4ch L");
  assert(approx(qr[0], 0.5), "4ch R");

  // 6ch 5.1 extensible mask 0x3F，仅 LFE（ch3）非零 → LFE 丢弃，左右均为 0
  const lfe = buildWav(
    {
      audioFormat: 1,
      channelCount: 6,
      sampleRate: 48000,
      bitsPerSample: 16,
      channelMask: 0x3f,
    },
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x7f, 0x00, 0x00, 0x00, 0x00],
  );
  const li = readWavInfo(lfe);
  assert(li !== null, "5.1 LFE not parsed");
  assert(li!.channelMask === 0x3f, "5.1 LFE channelMask");
  assert(li!.dataOffset === 68, "5.1 LFE dataOffset");
  const ll = new Float32Array(1);
  const lr = new Float32Array(1);
  decodeWavToStereo(lfe, li!, ll, lr);
  assert(approx(ll[0], 0), "5.1 LFE dropped L");
  assert(approx(lr[0], 0), "5.1 LFE dropped R");

  // 6ch 5.1 mask 0x3F，仅中置（ch2）非零 → S=0.7071 入左右
  const centre = buildWav(
    {
      audioFormat: 1,
      channelCount: 6,
      sampleRate: 48000,
      bitsPerSample: 16,
      channelMask: 0x3f,
    },
    [0x00, 0x00, 0x00, 0x00, 0xff, 0x7f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  );
  const ci = readWavInfo(centre);
  assert(ci !== null, "5.1 centre not parsed");
  const cl = new Float32Array(1);
  const cr = new Float32Array(1);
  decodeWavToStereo(centre, ci!, cl, cr);
  assert(approx(cl[0], 0.7071), "5.1 centre L");
  assert(approx(cr[0], 0.7071), "5.1 centre R");

  // 10ch 无掩码 → 平铺平均：一个 0x7fff + 9 个 0 → 左右均 ≈ 0.1
  const tenData: number[] = new Array<number>(20).fill(0);
  tenData[0] = 0xff;
  tenData[1] = 0x7f;
  const ten = buildWav(
    { audioFormat: 1, channelCount: 10, sampleRate: 48000, bitsPerSample: 16 },
    tenData,
  );
  const ti = readWavInfo(ten);
  assert(ti !== null, "10ch not parsed");
  assert(ti!.channelMask === 0, "10ch maskless");
  const tl = new Float32Array(1);
  const tr = new Float32Array(1);
  decodeWavToStereo(ten, ti!, tl, tr);
  assert(approx(tl[0], 0.1), "10ch flat mean L");
  assert(approx(tr[0], 0.1), "10ch flat mean R");

  // 6ch 5.1 mask 0x3F 全满 → 限峰：L = 1 + 0.7071 + 0.7071 = 2.4142 → 左右同因子降至 0.99
  const full: number[] = [];
  for (let i = 0; i < 6; i++) full.push(0xff, 0x7f);
  const peakWav = buildWav(
    {
      audioFormat: 1,
      channelCount: 6,
      sampleRate: 48000,
      bitsPerSample: 16,
      channelMask: 0x3f,
    },
    full,
  );
  const pi = readWavInfo(peakWav);
  assert(pi !== null, "5.1 full not parsed");
  const pl = new Float32Array(1);
  const pr = new Float32Array(1);
  decodeWavToStereo(peakWav, pi!, pl, pr);
  assert(approx(pl[0], 0.99), "peak guard L");
  assert(approx(pr[0], 0.99), "peak guard R");
  assert(pl[0] === pr[0], "peak guard shared factor");

  // 非 WAV → null
  assert(
    readWavInfo(new Uint8Array(64).buffer as ArrayBuffer) === null,
    "non-WAV should be null",
  );
}
