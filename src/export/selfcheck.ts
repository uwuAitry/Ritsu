// 离线导出纯函数自检（Node 可跑，不触碰 WebCodecs / DOM / mp4-muxer）。
// offline.ts 顶层无副作用，mp4-muxer 只在 exportOfflineRender 内动态 import，
// 因此 Node 下直接引入其纯函数安全。
// 覆盖：帧时间戳单调性与间隔、总时长、码率缩放公式（含上下限）、宽高偶数校验。
import {
  frameDurationUs,
  scaledVideoBps,
  validateEvenDimensions,
  videoDurationUs,
  videoFrameTimestampUs,
} from "./offline";

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`offline-render selfcheck: ${message}`);
}

function mustThrow(fn: () => void, message: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

export function runSelfCheck(): void {
  // 帧时间戳：全序列单调递增，相邻间隔 ≈ 1e6/fps（round 允许 ±1µs 抖动）
  for (const fps of [24, 30, 60, 144]) {
    const step = 1e6 / fps;
    assert(frameDurationUs(fps) === Math.round(step), `frameDurationUs @ ${fps}`);
    let prev = videoFrameTimestampUs(0, fps);
    assert(prev === 0, "first frame timestamp must be 0");
    for (let i = 1; i < 10_000; i += 1) {
      const ts = videoFrameTimestampUs(i, fps);
      const gap = ts - prev;
      assert(ts > prev, `timestamp monotonic @ fps=${fps} i=${i}`);
      assert(Math.abs(gap - step) <= 1, `frame gap ≈ 1e6/fps @ fps=${fps} i=${i} gap=${gap}`);
      prev = ts;
    }
  }

  // 总时长：末帧时间戳 + 单帧时长 ≈ frames/fps（两次 round，容差 2µs）
  for (const fps of [24, 30, 60]) {
    for (const frames of [1, 30, 250, 3000]) {
      const expected = (frames * 1e6) / fps;
      const actual = videoDurationUs(frames, fps);
      assert(
        Math.abs(actual - expected) <= 2,
        `duration ≈ frames/fps @ fps=${fps} frames=${frames} (${actual} vs ${expected})`,
      );
    }
  }
  assert(videoDurationUs(0, 30) === 0, "zero frames → zero duration");

  // 码率缩放：1080p30 = 20 Mbps 基准；4K30 = 80 Mbps；4K60 压到上限 80 Mbps；
  // 极小画幅压到下限 2 Mbps
  assert(scaledVideoBps(1920, 1080, 30) === 20_000_000, "bitrate base 1080p30");
  assert(scaledVideoBps(3840, 2160, 30) === 80_000_000, "bitrate 4K30 = 4× base");
  assert(scaledVideoBps(3840, 2160, 60) === 80_000_000, "bitrate cap 4K60");
  assert(scaledVideoBps(320, 180, 24) === 2_000_000, "bitrate floor");

  // 宽高偶数化校验：偶数放行，奇数 / 非整数 / 越界一律抛错
  validateEvenDimensions(1920, 1080);
  validateEvenDimensions(2, 2);
  mustThrow(() => validateEvenDimensions(1921, 1080), "odd width must throw");
  mustThrow(() => validateEvenDimensions(1920, 1079), "odd height must throw");
  mustThrow(() => validateEvenDimensions(0, 1080), "zero width must throw");
  mustThrow(() => validateEvenDimensions(100.5, 1080), "non-integer width must throw");
  mustThrow(() => validateEvenDimensions(-2, 1080), "negative width must throw");
}
