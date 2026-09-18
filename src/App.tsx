// Ritsu 应用外壳：素材载入 → 实时预览 → 实时导出。
// 只做编排（引擎 / 舞台 / React 状态），画面细节全部在 StageRenderer 内。
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties } from "react";
import { BackgroundRender } from "@applemusic-like-lyrics/react";
import type { LyricLine } from "@applemusic-like-lyrics/core";
import "@applemusic-like-lyrics/core/style.css";

import { parseAdmBwf } from "./adm/parse";
import { AudioEngine } from "./audio/engine";
import { exportVideo, pickMimeType } from "./export/recorder";
import { loadLyricFile } from "./lyric/load";
import { StageRenderer } from "./render/stage";
import type { StageMeta } from "./render/stage";
import type { AdmMetadata, AudioSource } from "./types";

const AUDIO_ACCEPT = "audio/*,.wav,.bwf,.rf64,.flac,.mp3,.m4a,.aac,.ogg";
const LYRIC_ACCEPT = ".lrc,.yrc,.qrc,.lys,.lyl,.lqe,.ttml,.xml,.txt";
const COVER_ACCEPT = "image/*";

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

// "Artist - Title.flac" → { artist, title }；没有分隔符时整体当标题
function splitFileName(fileName: string): { title: string; artist: string } {
  const base = baseName(fileName);
  const sep = base.indexOf(" - ");
  if (sep > 0) {
    return { artist: base.slice(0, sep).trim(), title: base.slice(sep + 3).trim() };
  }
  return { title: base, artist: "" };
}

// 空输入的兜底文案（同时用作输入框 placeholder）
const META_PLACEHOLDER = { title: "未知曲目", artist: "未知歌手" };

// 用户输入优先，空则回退文件名推导值，再回退兜底文案：舞台上不留空白标题行
function resolveMeta(input: StageMeta, fallback: StageMeta): StageMeta {
  return {
    title: input.title.trim() || fallback.title || META_PLACEHOLDER.title,
    artist: input.artist.trim() || fallback.artist || META_PLACEHOLDER.artist,
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null);
  const stageRef = useRef<StageRenderer | null>(null);
  const stageHostRef = useRef<HTMLDivElement | null>(null);
  const bgHostRef = useRef<HTMLDivElement | null>(null);
  const coverUrlRef = useRef<string | null>(null);

  const [source, setSource] = useState<AudioSource | null>(null);
  const [adm, setAdm] = useState<AdmMetadata | null>(null);
  const [lines, setLines] = useState<LyricLine[]>([]);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [coverImg, setCoverImg] = useState<HTMLImageElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [timeMs, setTimeMs] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 歌曲信息：metaInput 是输入框原值（可为空串），metaDefault 是文件名推导值
  const [metaInput, setMetaInput] = useState<StageMeta>({ title: "", artist: "" });
  const [metaDefault, setMetaDefault] = useState<StageMeta>({ title: "", artist: "" });

  // 引擎 / 舞台在挂载时创建、卸载时销毁。StrictMode 的模拟卸载走同一条清理路径，
  // 重新挂载即重建 —— 不在 render 里 new，避免被双调用泄漏 AudioContext / WebGL context。
  useEffect(() => {
    const engine = new AudioEngine();
    const stage = new StageRenderer();
    engineRef.current = engine;
    stageRef.current = stage;

    // 舞台画布进预览位；bgCanvas 进 1920×1080 的隐藏宿主，
    // StageRenderer 靠它 querySelector("canvas") 找到 AMLL 流体背景画布。
    stageHostRef.current?.appendChild(stage.canvas);
    bgHostRef.current?.appendChild(stage.bgCanvas);
    stage.render();

    const offTick = engine.onTick((t) => {
      const ms = t * 1000;
      setTimeMs(ms);
      stage.setTime(ms);
      stage.setPlaying(true);
      stage.render();
    });
    const offState = engine.onState((s) => {
      const nowPlaying = s === "playing";
      setPlaying(nowPlaying);
      stage.setPlaying(nowPlaying);
      stage.render();
    });

    return () => {
      offTick();
      offState();
      engine.dispose();
      stage.dispose();
      engineRef.current = null;
      stageRef.current = null;
      stage.canvas.remove();
      stage.bgCanvas.remove();
      if (coverUrlRef.current) {
        URL.revokeObjectURL(coverUrlRef.current);
        coverUrlRef.current = null;
      }
    };
  }, []);

  // 每次 setter 之后同步时间并强制重绘：暂停时没有 tick，画面会停在旧帧。
  const syncStage = (ms?: number): void => {
    const stage = stageRef.current;
    if (!stage) return;
    const t = ms ?? (engineRef.current ? engineRef.current.currentTime * 1000 : 0);
    stage.setTime(t);
    setTimeMs(t);
    stage.render();
  };

  const handleAudio = async (file: File): Promise<void> => {
    const engine = engineRef.current;
    const stage = stageRef.current;
    if (!engine || !stage) return;
    setBusy(true);
    setError(null);
    try {
      // engine.load 内部就是 decodeAudioFile，并把解码缓冲交给引擎（避免重复解码）
      const loaded = await engine.load(file);
      // 文件名 → 默认歌曲信息：输入框预填，舞台同步（空歌手回退兜底文案）
      const derived: StageMeta = splitFileName(file.name);
      setMetaDefault(derived);
      setMetaInput(derived);
      stage.setMeta(resolveMeta(derived, derived));
      stage.setDuration(loaded.durationSec * 1000);

      let admMeta: AdmMetadata | null = null;
      // ponytail: ADM 时二次读字节（decodeAudioFile 已读过一次）；只对 BWF 生效，
      // 后续可让 decodeAudioFile 顺带回传 raw
      if (loaded.isAdm) admMeta = parseAdmBwf(await file.arrayBuffer());
      stage.setAdm(admMeta);

      setSource(loaded);
      setAdm(admMeta);
      syncStage(0);
    } catch (e) {
      // engine.load 已清空旧缓冲，UI 状态跟着回到“未载入”，避免出现按了没反应的播放键
      setSource(null);
      setAdm(null);
      stage.setAdm(null);
      setError(`音频加载失败：${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // 改一个字就立刻同步舞台：暂停时没有 tick，必须手动补一帧
  const updateMeta = (patch: Partial<StageMeta>): void => {
    const next = { ...metaInput, ...patch };
    setMetaInput(next);
    const stage = stageRef.current;
    if (!stage) return;
    stage.setMeta(resolveMeta(next, metaDefault));
    stage.render();
  };

  const handleLyric = async (file: File): Promise<void> => {
    const stage = stageRef.current;
    if (!stage) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = await loadLyricFile(file);
      setLines(parsed);
      stage.setLyricLines(parsed);
      stage.render();
      if (parsed.length === 0) setError("未能从该文件解析出歌词行，请检查格式");
    } catch (e) {
      setError(`歌词解析失败：${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleCover = (file: File): void => {
    const stage = stageRef.current;
    if (!stage) return;
    setError(null);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const prev = coverUrlRef.current;
      coverUrlRef.current = url;
      if (prev) URL.revokeObjectURL(prev);
      setCoverUrl(url);
      setCoverImg(img);
      stage.setCover(img);
      stage.render();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setError("封面图片加载失败");
    };
    img.src = url;
  };

  const handleSeek = (e: ChangeEvent<HTMLInputElement>): void => {
    const ms = Number(e.target.value);
    engineRef.current?.seek(ms / 1000);
    syncStage(ms);
  };

  const togglePlay = (): void => {
    const engine = engineRef.current;
    if (!engine || !source) return;
    if (playing) engine.pause();
    else engine.play();
  };

  const handleExport = async (): Promise<void> => {
    const engine = engineRef.current;
    const stage = stageRef.current;
    if (!engine || !stage || exporting) return;
    if (!source) {
      setError("请先载入音频文件，再导出视频");
      return;
    }

    setError(null);
    setExporting(true);
    setExportProgress(0);
    engine.seek(0);
    syncStage(0); // 先把画面推到 0 帧，captureStream 起手才不会抓到旧画面

    try {
      const pending = exportVideo({
        canvas: stage.canvas,
        audio: engine.destination.stream,
        durationSec: engine.duration || source.durationSec,
        fps: 30,
        onProgress: setExportProgress,
      });
      engine.play(); // 实时录制：播放驱动 tick → 逐帧 render
      const blob = await pending;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${baseName(source.fileName)}.${pickMimeType().extension}`;
      a.click();
      // ponytail: 延迟回收；立刻 revoke 在部分浏览器会打断下载
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(`导出失败：${errText(e)}`);
    } finally {
      engine.pause();
      setExporting(false);
    }
  };

  const durationMs = source ? source.durationSec * 1000 : 0;
  const seekMax = Math.max(durationMs, 1);
  const seekValue = Math.min(Math.max(timeMs, 0), seekMax);
  const progressPct = durationMs > 0 ? Math.min(100, (timeMs / durationMs) * 100) : 0;
  const locked = busy || exporting;

  return (
    <div className="app">
      {/* AMLL 流体背景的宿主：必须常驻 DOM 且尺寸为 1920×1080，
          StageRenderer 会把它的画布合成进主画布，所以这里保持不可见。 */}
      <div className="stage-bg-host" ref={bgHostRef} aria-hidden="true">
        <BackgroundRender
          album={coverImg ?? coverUrl ?? undefined}
          playing={playing}
          hasLyric={lines.length > 0}
          flowSpeed={2}
          fps={30}
        />
      </div>

      <header className="app-header">
        <h1 className="brand">Ritsu</h1>
        <p className="tagline">歌词视频渲染器 · 支持 Dolby Atmos ADM BWF</p>
      </header>

      <main className="app-main">
        <aside className="panel" aria-busy={busy}>
          <section className="panel-block">
            <h2 className="block-title">素材</h2>

            <label className="file-field">
              <span className="file-label">音频文件</span>
              <input
                type="file"
                accept={AUDIO_ACCEPT}
                disabled={locked}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void handleAudio(file);
                }}
              />
              <span className="file-note">WAV · BWF · RF64 · FLAC · MP3 · M4A</span>
            </label>

            <label className="file-field">
              <span className="file-label">歌词文件</span>
              <input
                type="file"
                accept={LYRIC_ACCEPT}
                disabled={locked}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void handleLyric(file);
                }}
              />
              <span className="file-note">LRC · YRC · QRC · Lyricify · TTML</span>
            </label>

            <label className="file-field">
              <span className="file-label">封面图片</span>
              <span className="cover-row">
                {coverUrl ? <img className="cover-thumb" src={coverUrl} alt="封面预览" /> : null}
                <input
                  type="file"
                  accept={COVER_ACCEPT}
                  disabled={locked}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) handleCover(file);
                  }}
                />
              </span>
              <span className="file-note">建议 1:1 方图，PNG / JPG</span>
            </label>
          </section>

          <section className="panel-block">
            <h2 className="block-title">歌曲信息</h2>
            <div className="meta-row">
              <label className="file-field">
                <span className="file-label">标题</span>
                <input
                  className="text-input"
                  type="text"
                  value={metaInput.title}
                  placeholder={metaDefault.title || META_PLACEHOLDER.title}
                  disabled={locked}
                  onChange={(e) => updateMeta({ title: e.target.value })}
                />
              </label>
              <label className="file-field">
                <span className="file-label">歌手</span>
                <input
                  className="text-input"
                  type="text"
                  value={metaInput.artist}
                  placeholder={metaDefault.artist || META_PLACEHOLDER.artist}
                  disabled={locked}
                  onChange={(e) => updateMeta({ artist: e.target.value })}
                />
              </label>
            </div>
          </section>

          <section className="panel-block">
            <h2 className="block-title">播放</h2>
            <div className="transport">
              <button
                type="button"
                className="play-btn"
                onClick={togglePlay}
                disabled={!source || locked}
                aria-label={playing ? "暂停" : "播放"}
              >
                <span aria-hidden="true">{playing ? "⏸" : "▶"}</span>
              </button>
              <div className="seek-wrap">
                <span className="time-readout">
                  {formatTime(timeMs)} / {formatTime(durationMs)}
                </span>
                <input
                  className="seek"
                  type="range"
                  min={0}
                  max={seekMax}
                  step={50}
                  value={seekValue}
                  disabled={!source || exporting}
                  style={{ "--seek": `${progressPct.toFixed(2)}%` } as CSSProperties}
                  onChange={handleSeek}
                  aria-label="播放进度"
                />
              </div>
            </div>
          </section>

          <section className="panel-block">
            <h2 className="block-title">导出</h2>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleExport()}
              disabled={!source || locked}
            >
              {exporting ? `导出中… ${Math.round(exportProgress * 100)}%` : "导出视频"}
            </button>
            {exporting ? (
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${exportProgress * 100}%` }} />
              </div>
            ) : null}
            <p className="hint">实时导出：录制耗时约等于歌曲时长，期间请保持页面在前台。</p>
          </section>

          <div className="status-row">
            {busy ? <span className="chip chip-accent">处理中…</span> : null}
            {source ? (
              <span className="chip">
                {source.channelCount} 声道 · {(source.sampleRate / 1000).toFixed(1)} kHz
              </span>
            ) : null}
            {adm ? <span className="chip chip-accent">Dolby Atmos · {adm.objects.length} 对象</span> : null}
            {lines.length > 0 ? <span className="chip">{lines.length} 行歌词</span> : null}
            {!source && lines.length === 0 && !busy ? (
              <span className="chip chip-muted">等待载入素材</span>
            ) : null}
          </div>

          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
        </aside>

        <section className="stage-panel">
          <div className="stage-caption">
            <span>预览 · 1920 × 1080</span>
            <span>{playing ? "播放中" : source ? "已暂停" : "未载入音频"}</span>
          </div>
          <div className="stage-frame" ref={stageHostRef} />
        </section>
      </main>
    </div>
  );
}
