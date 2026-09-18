// 视频导出：实时录制舞台 canvas + 音频，v1 只做实时（录制时长 == 播放时长）。

// 优先 MP4/H.264，其次 WebM/VP9；返回空 mimeType 表示让 MediaRecorder 自选默认。
export function pickMimeType(): { mimeType: string; extension: "mp4" | "webm" } {
  const mp4 = [
    "video/mp4;codecs=avc1.640028,mp4a.40.2",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
  ];
  const webm = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp9", "video/webm"];
  const supported = (t: string): boolean => {
    try {
      return typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t);
    } catch {
      return false;
    }
  };
  for (const t of mp4) if (supported(t)) return { mimeType: t, extension: "mp4" };
  for (const t of webm) if (supported(t)) return { mimeType: t, extension: "webm" };
  return { mimeType: "", extension: "webm" };
}

export function exportVideo(opts: {
  canvas: HTMLCanvasElement;
  audio: MediaStream | null;
  durationSec: number;
  fps?: number;
  onProgress?: (ratio: number) => void;
}): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    if (typeof MediaRecorder === "undefined") {
      reject(new Error("MediaRecorder 不可用：当前浏览器不支持视频导出"));
      return;
    }

    const { mimeType } = pickMimeType();
    const stream = opts.canvas.captureStream(opts.fps ?? 30);
    if (opts.audio) {
      for (const track of opts.audio.getAudioTracks()) stream.addTrack(track);
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: 12_000_000,
        audioBitsPerSecond: 192_000,
      });
    } catch (e) {
      reject(new Error(`无法创建 MediaRecorder：${e instanceof Error ? e.message : String(e)}`));
      return;
    }

    const chunks: BlobPart[] = [];
    const startMs = performance.now();
    const durationMs = opts.durationSec * 1000;
    const TAIL_MS = 150; // 让最后一帧落盘
    let rafId = 0;
    let stopped = false;

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(rafId);
      if (recorder.state !== "inactive") recorder.stop();
    };

    // ponytail: 实时导出，导出耗时 == durationSec；离线加速渲染 v2 再做。
    const tick = (): void => {
      const elapsedMs = performance.now() - startMs;
      opts.onProgress?.(Math.min(1, elapsedMs / durationMs));
      if (elapsedMs >= durationMs + TAIL_MS) {
        stop();
        return;
      }
      rafId = requestAnimationFrame(tick);
    };

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = (e: Event) => {
      stopped = true;
      cancelAnimationFrame(rafId);
      const err = (e as Event & { error?: DOMException }).error;
      reject(err ?? new Error("MediaRecorder 录制出错"));
    };
    recorder.onstop = () => {
      cancelAnimationFrame(rafId);
      opts.onProgress?.(1);
      resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
    };

    recorder.start(1000); // timeslice：每秒产出一个 chunk
    rafId = requestAnimationFrame(tick);
  });
}
