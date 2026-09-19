// AudioEngine：歌词 / 视觉的主时钟。
// 图：AudioBufferSourceNode → GainNode → { ctx.destination(监听), MediaStreamAudioDestinationNode(导出抓流) }
import type { AdmMetadata, AudioSource } from "../types";
import { decodeAudioFile } from "./decode";

export type PlaybackState = "idle" | "playing" | "paused" | "ended";

export class AudioEngine {
  readonly ctx: AudioContext;
  /** 导出抓流用的目的节点（配合 canvas.captureStream 使用） */
  readonly destination: MediaStreamAudioDestinationNode;

  private readonly gain: GainNode;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;

  private state_: PlaybackState = "idle";
  private startCtxTime = 0; // source 启动时的 ctx.currentTime
  private startOffset = 0; // source 启动时对应的音频时间

  private rafId = 0;
  private readonly tickCbs = new Set<(t: number) => void>();
  private readonly stateCbs = new Set<(s: PlaybackState) => void>();

  constructor() {
    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.destination = this.ctx.createMediaStreamDestination();
    this.gain.connect(this.ctx.destination);
    this.gain.connect(this.destination);
  }

  get duration(): number {
    return this.buffer ? this.buffer.duration : 0;
  }

  get currentTime(): number {
    const t =
      this.state_ === "playing"
        ? this.startOffset + (this.ctx.currentTime - this.startCtxTime)
        : this.startOffset;
    return Math.min(Math.max(t, 0), this.duration);
  }

  get state(): PlaybackState {
    return this.state_;
  }

  // 可重复调用：先拆掉旧的 source / 状态，再解码新文件
  async load(file: File): Promise<{
    source: AudioSource;
    adm: AdmMetadata | null;
    activity: Uint8Array[] | null;
  }> {
    this.stopSource();
    this.buffer = null;
    this.startOffset = 0;
    this.setState("idle");

    const decoded = await decodeAudioFile(this.ctx, file);
    this.buffer = decoded.source.buffer;
    this.startOffset = 0;
    this.setState("idle");
    return decoded;
  }

  play(): void {
    if (!this.buffer || this.state_ === "playing") return;
    if (this.state_ === "ended") this.startOffset = 0;
    // 浏览器要求用户手势内 resume
    void this.ctx.resume();
    this.startSource(this.startOffset);
    this.setState("playing");
  }

  pause(): void {
    if (this.state_ !== "playing") return;
    const t = this.currentTime;
    this.stopSource();
    this.startOffset = t;
    this.setState("paused");
  }

  seek(sec: number): void {
    if (!this.buffer) return;
    const t = Math.min(Math.max(sec, 0), this.duration);

    if (this.state_ === "playing") {
      // 播放中：停止并按新偏移重启 source
      this.stopSource();
      this.startSource(t);
      return;
    }

    this.startOffset = t;
    if (this.state_ === "ended") this.setState("paused");
  }

  // 播放期间由 rAF 驱动；返回取消订阅函数
  onTick(cb: (t: number) => void): () => void {
    this.tickCbs.add(cb);
    return () => {
      this.tickCbs.delete(cb);
    };
  }

  onState(cb: (s: PlaybackState) => void): () => void {
    this.stateCbs.add(cb);
    return () => {
      this.stateCbs.delete(cb);
    };
  }

  dispose(): void {
    this.stopRaf();
    this.stopSource();
    this.buffer = null;
    this.tickCbs.clear();
    this.stateCbs.clear();
    void this.ctx.close();
  }

  private startSource(offset: number): void {
    const buffer = this.buffer;
    if (!buffer) return;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer; // ponytail: v1 直接播放解码缓冲，不自动套 ADM downmix；空间降混为后续升级
    src.connect(this.gain);

    const safeOffset = Math.min(Math.max(offset, 0), buffer.duration);
    this.startOffset = safeOffset;
    this.startCtxTime = this.ctx.currentTime;

    src.onended = () => {
      // stopSource() 会先清空 onended，所以这里只可能是自然播放结束
      if (this.source !== src) return;
      this.source = null;
      this.startOffset = buffer.duration;
      this.setState("ended");
    };

    src.start(0, safeOffset);
    this.source = src;
  }

  private stopSource(): void {
    const src = this.source;
    if (!src) return;
    this.source = null;
    src.onended = null;
    try {
      src.stop();
    } catch {
      // 已停止的 source 再 stop 会抛，忽略
    }
    src.disconnect();
  }

  private setState(s: PlaybackState): void {
    if (this.state_ === s) return;
    this.state_ = s;
    if (s === "playing") this.startRaf();
    else this.stopRaf();
    for (const cb of this.stateCbs) cb(s);
  }

  private readonly tick = (): void => {
    this.rafId = 0;
    if (this.state_ !== "playing") return;
    const t = this.currentTime;
    for (const cb of this.tickCbs) cb(t);
    this.rafId = requestAnimationFrame(this.tick);
  };

  private startRaf(): void {
    if (this.rafId || this.state_ !== "playing") return;
    this.rafId = requestAnimationFrame(this.tick);
  }

  private stopRaf(): void {
    if (!this.rafId) return;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }
}
