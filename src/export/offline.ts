// 离线逐帧渲染导出：WebCodecs（H.264 + AAC）编码 + mp4-muxer 封装 MP4。
// 与实时导出（recorder.ts / MediaRecorder）并存的纯新增路径：逐帧渲染、非实时，
// 总耗时 ≈ 总帧数 × 单帧（渲染+编码）耗时，速度取决于机器。画面与预览走同一帧
// 路径（调用方注入 renderFrame），预览/导出逐帧一致。
// 能力缺失（无 VideoEncoder / AudioEncoder / AVC / AAC 支持）时抛可识别错误，
// 调用方捕获后回退实时导出。

// ---- WebCodecs 最小结构类型 ----
// ponytail: lib.dom（TS 5.6）没有 WebCodecs 类型；这里手写本项目用到的最小面，
// 构造器一律经 globalThis 取用，不依赖 @types/dom-webcodecs 的全局注入（它是
// mp4-muxer 的传递依赖，不保证总在根 @types 下）。引入 @types/webcodecs 后可整体替换。

interface WcVideoFrame {
  close(): void;
}

interface WcVideoFrameCtor {
  new (source: CanvasImageSource, init: { timestamp: number; duration?: number }): WcVideoFrame;
}

interface WcEncodedVideoChunk {
  readonly timestamp: number;
  readonly duration?: number;
}

/** VideoEncoder output 回调的元数据：decoderConfig.description（avcC）是 muxer 必需的 */
interface WcChunkMeta {
  decoderConfig?: {
    codec?: string;
    description?: BufferSource;
  };
}

interface WcVideoConfig {
  codec: string;
  width: number;
  height: number;
  bitrate: number;
  framerate: number;
  avc?: { format: "avc" };
}

interface WcVideoEncoder {
  configure(config: WcVideoConfig): void;
  encode(frame: WcVideoFrame, opts?: { keyFrame?: boolean }): void;
  flush(): Promise<void>;
  close(): void;
  readonly encodeQueueSize: number;
  addEventListener(type: "dequeue", listener: () => void, options?: { once?: boolean }): void;
}

interface WcVideoEncoderCtor {
  new (init: {
    output: (chunk: WcEncodedVideoChunk, meta?: WcChunkMeta) => void;
    error: (error: DOMException) => void;
  }): WcVideoEncoder;
  isConfigSupported(config: WcVideoConfig): Promise<{ supported?: boolean }>;
}

interface WcAudioData {
  close(): void;
}

interface WcAudioDataCtor {
  new (init: {
    format: "f32-planar";
    sampleRate: number;
    numberOfFrames: number;
    numberOfChannels: number;
    timestamp: number;
    data: Float32Array;
  }): WcAudioData;
}

interface WcAudioConfig {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  bitrate: number;
}

interface WcEncodedAudioChunk {
  readonly timestamp: number;
  readonly duration?: number;
}

interface WcAudioEncoder {
  configure(config: WcAudioConfig): void;
  encode(data: WcAudioData): void;
  flush(): Promise<void>;
  close(): void;
}

interface WcAudioEncoderCtor {
  new (init: {
    output: (chunk: WcEncodedAudioChunk, meta?: WcChunkMeta) => void;
    error: (error: DOMException) => void;
  }): WcAudioEncoder;
  isConfigSupported(config: WcAudioConfig): Promise<{ supported?: boolean }>;
}

// ---- mp4-muxer 最小面（边界处 cast，隔离其类型对 @types 的依赖） ----
interface WcMuxerTarget {
  buffer: ArrayBuffer | null;
}

interface WcMuxer {
  readonly target: WcMuxerTarget;
  addVideoChunk(chunk: WcEncodedVideoChunk, meta?: WcChunkMeta): void;
  addAudioChunk(chunk: WcEncodedAudioChunk, meta?: WcChunkMeta): void;
  finalize(): void;
}

interface WcMuxerCtor {
  new (options: {
    target: WcMuxerTarget;
    video?: { codec: "avc"; width: number; height: number; frameRate: number };
    audio?: { codec: "aac"; numberOfChannels: number; sampleRate: number };
    fastStart: "in-memory";
  }): WcMuxer;
}

// ---- 纯函数（export/selfcheck.ts 在 Node 下自检；本模块顶层无副作用） ----

/** 第 i 帧的呈现时间戳（µs）：round(i·1e6/fps)；按帧独立计算，无累计漂移 */
export function videoFrameTimestampUs(frameIndex: number, fps: number): number {
  return Math.round((frameIndex * 1e6) / fps);
}

/** 单帧时长（µs）：round(1e6/fps) */
export function frameDurationUs(fps: number): number {
  return Math.round(1e6 / fps);
}

/** 视频轨总时长（µs）：末帧时间戳 + 单帧时长 ≈ frames·1e6/fps（两次 round，偏差 <2µs） */
export function videoDurationUs(frameCount: number, fps: number): number {
  if (frameCount <= 0) return 0;
  return videoFrameTimestampUs(frameCount - 1, fps) + frameDurationUs(fps);
}

// 码率按像素×帧率线性缩放（1080p30 = 20 Mbps 基准，与实时导出同源）。
// ponytail: 4K60 按公式应为 160 Mbps，压到上限 80 Mbps（YouTube 4K60 推荐 50–70），
// 上限随编码器实测能力再评估。
const BASE_VIDEO_BPS = 20_000_000;
const MIN_VIDEO_BPS = 2_000_000;
const MAX_VIDEO_BPS = 80_000_000;

export function scaledVideoBps(width: number, height: number, fps: number): number {
  const bps = BASE_VIDEO_BPS * ((width * height * fps) / (1920 * 1080 * 30));
  return Math.min(MAX_VIDEO_BPS, Math.max(MIN_VIDEO_BPS, bps));
}

/** H.264 yuv420 要求宽高为偶数；非法输入直接抛错（调用方转成用户可读提示） */
export function validateEvenDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new Error(`分辨率无效：${width}×${height}（需为 ≥2 的整数）`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error(`分辨率需为偶数：${width}×${height}（H.264 yuv420 要求）`);
  }
}

/** 取消统一抛 name="AbortError"，调用方按 e.name 识别 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("离线导出已取消");
    err.name = "AbortError";
    throw err;
  }
}

/** 能力检测：WebCodecs 视频编码器与音频编码器都可用才支持离线渲染 */
export function isOfflineRenderSupported(): boolean {
  const g = globalThis as unknown as Record<string, unknown>;
  return typeof g.VideoEncoder === "function" && typeof g.AudioEncoder === "function";
}

export interface OfflineRenderOptions {
  /** 舞台画布（renderFrame 已把当前帧画好；编码器直接取它的实际像素，要求宽高为偶） */
  canvas: HTMLCanvasElement;
  /** 已解码音频缓冲（AudioEngine.decodedBuffer） */
  buffer: AudioBuffer;
  /** 目标帧率（24 / 30 / 60） */
  fps: number;
  /** 调用方注入的画帧函数：把舞台渲染到 timeMs 时刻 */
  renderFrame: (timeMs: number) => void;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

// AVC 档位：High Profile，Level 4.0 → 5.1 → 5.2 依次尝试（4K / 高帧率需要更高 level）
const AVC_CODECS = ["avc1.640028", "avc1.640033", "avc1.640034"] as const;
const AUDIO_CODEC = "mp4a.40.2"; // AAC-LC
const AUDIO_BPS = 192_000;
const AAC_SAMPLES_PER_CHUNK = 1024;
const MAX_ENCODE_QUEUE = 8; // 背压阈值：编码队列超过即等待 dequeue

export async function exportOfflineRender(opts: OfflineRenderOptions): Promise<Blob> {
  const { canvas, buffer, fps, renderFrame, onProgress, signal } = opts;
  const width = canvas.width;
  const height = canvas.height;
  validateEvenDimensions(width, height);
  throwIfAborted(signal);

  const webcodecs = globalThis as unknown as {
    VideoEncoder?: WcVideoEncoderCtor;
    AudioEncoder?: WcAudioEncoderCtor;
    VideoFrame?: WcVideoFrameCtor;
    AudioData?: WcAudioDataCtor;
  };
  const { VideoEncoder: VE, AudioEncoder: AE, VideoFrame: VFC, AudioData: ADC } = webcodecs;
  if (!VE || !AE || !VFC || !ADC) {
    throw new Error("此浏览器不支持 WebCodecs，无法离线渲染，请改用实时录制导出");
  }

  // 编码器异步错误统一收口：errorGate 可在任何 await 处竞速，避免错误后等待悬挂
  let encoderError: Error | null = null;
  let rejectEncoderError: ((e: Error) => void) | null = null;
  const errorGate = new Promise<never>((_, reject) => {
    rejectEncoderError = reject;
  });
  errorGate.catch(() => {}); // gate 未必总被 await，先落地防 unhandledrejection
  const fail = (e: DOMException): void => {
    encoderError ??= new Error(`编码器错误：${e.message}`);
    rejectEncoderError?.(encoderError);
  };

  const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");
  const muxer = new (Muxer as unknown as WcMuxerCtor)({
    target: new (ArrayBufferTarget as unknown as new () => WcMuxerTarget)(),
    video: { codec: "avc", width, height, frameRate: fps },
    audio: { codec: "aac", numberOfChannels: 2, sampleRate: buffer.sampleRate },
    fastStart: "in-memory",
    // ponytail: 'in-memory' 把全部编码块攒在内存（4K 长视频可达 GB 级）；超大工程
    // 需要时换 StreamTarget 边编码边落盘。
  });

  let audioEncoder: WcAudioEncoder | null = null;
  let videoEncoder: WcVideoEncoder | null = null;
  try {
    // ---- 音频：解码缓冲 → OfflineAudioContext 渲染成立体声 → AAC 逐块编码 ----
    // 多声道按 Web Audio 标准规则下混为 2.0，与实时导出的 MediaStreamDestination 一致。
    const stereo = await renderStereo(buffer);
    const audioCfg: WcAudioConfig = {
      codec: AUDIO_CODEC,
      sampleRate: stereo.sampleRate,
      numberOfChannels: 2,
      bitrate: AUDIO_BPS,
    };
    const audioSupport = await Promise.race([AE.isConfigSupported(audioCfg), errorGate]);
    if (!audioSupport.supported) {
      throw new Error("此浏览器不支持 AAC 音频编码，无法离线渲染，请改用实时录制导出");
    }
    audioEncoder = new AE({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: fail,
    });
    audioEncoder.configure(audioCfg);

    const left = stereo.getChannelData(0);
    const right = stereo.getChannelData(1);
    for (let offset = 0; offset < stereo.length; offset += AAC_SAMPLES_PER_CHUNK) {
      throwIfAborted(signal);
      const frames = Math.min(AAC_SAMPLES_PER_CHUNK, stereo.length - offset);
      const planar = new Float32Array(frames * 2);
      planar.set(left.subarray(offset, offset + frames), 0);
      planar.set(right.subarray(offset, offset + frames), frames);
      const data = new ADC({
        format: "f32-planar",
        sampleRate: stereo.sampleRate,
        numberOfFrames: frames,
        numberOfChannels: 2,
        timestamp: Math.round((offset / stereo.sampleRate) * 1e6),
        data: planar,
      });
      audioEncoder.encode(data);
      data.close();
    }
    await Promise.race([audioEncoder.flush(), errorGate]);
    audioEncoder.close();
    audioEncoder = null;

    // ---- 视频：选档 → 逐帧 renderFrame → VideoFrame → encode（关键帧间隔 2s、队列背压） ----
    const bitrate = scaledVideoBps(width, height, fps);
    const baseCfg: WcVideoConfig = {
      codec: AVC_CODECS[0],
      width,
      height,
      bitrate,
      framerate: fps,
      avc: { format: "avc" }, // muxer 需要 AVCC（description 走 decoderConfig 提供）
    };
    let codec: string | null = null;
    for (const candidate of AVC_CODECS) {
      const support = await Promise.race([
        VE.isConfigSupported({ ...baseCfg, codec: candidate }),
        errorGate,
      ]);
      if (support.supported) {
        codec = candidate;
        break;
      }
    }
    if (!codec) {
      throw new Error(
        `此浏览器不支持 ${width}×${height}@${fps} 的 H.264 视频编码，请降低分辨率或改用实时录制导出`,
      );
    }
    videoEncoder = new VE({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: fail,
    });
    videoEncoder.configure({ ...baseCfg, codec });

    const totalFrames = Math.max(1, Math.ceil(buffer.duration * fps));
    const frameDuration = frameDurationUs(fps);
    const keyFrameInterval = Math.max(1, Math.round(fps * 2)); // 关键帧间隔 2s
    for (let i = 0; i < totalFrames; i += 1) {
      throwIfAborted(signal);
      renderFrame((i / fps) * 1000);
      const frame = new VFC(canvas, {
        timestamp: videoFrameTimestampUs(i, fps),
        duration: frameDuration,
      });
      videoEncoder.encode(frame, { keyFrame: i % keyFrameInterval === 0 });
      frame.close();
      onProgress?.((i + 1) / totalFrames);
      while (videoEncoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
        await Promise.race([
          new Promise<void>((resolve) => {
            videoEncoder?.addEventListener("dequeue", () => resolve(), { once: true });
          }),
          errorGate,
        ]);
      }
    }
    await Promise.race([videoEncoder.flush(), errorGate]);
    videoEncoder.close();
    videoEncoder = null;

    muxer.finalize();
    const out = muxer.target.buffer;
    if (!out) throw new Error("MP4 封装失败：未产出数据");
    return new Blob([out], { type: "video/mp4" });
  } finally {
    // 中途出错 / 取消时释放编码器（close 对已关闭实例按规范为 no-op）
    audioEncoder?.close();
    videoEncoder?.close();
  }
}

/** 解码缓冲 → 立体声（多声道按 Web Audio 标准规则下混，与实时导出一致） */
async function renderStereo(buffer: AudioBuffer): Promise<AudioBuffer> {
  const length = Math.max(1, Math.ceil(buffer.duration * buffer.sampleRate));
  const ctx = new OfflineAudioContext(2, length, buffer.sampleRate);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0);
  return ctx.startRendering();
}
