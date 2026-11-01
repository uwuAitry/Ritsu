// Ritsu 应用外壳：素材载入 → 实时预览 → 实时导出。
// 只做编排（引擎 / 舞台 / React 状态），画面细节全部在 StageRenderer 内。
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties } from "react";
import { BackgroundRender } from "@applemusic-like-lyrics/react";
import type { LyricLine } from "@applemusic-like-lyrics/core";
import "@applemusic-like-lyrics/core/style.css";

import { AudioEngine } from "./audio/engine";
import { exportVideo, pickMimeType } from "./export/recorder";
import { exportOfflineRender, isOfflineRenderSupported } from "./export/offline";
import { exportHdrStream, isHdrHostAvailable } from "./export/hdrStream";
import { loadLyricFile, parseLyricsText } from "./lyric/load";
import {
  bestMetaCandidate,
  fetchCoverBlob,
  searchLyricCandidates,
  searchMetaCandidates,
} from "./autofill/sources";
import type { LyricCandidate, LyricSource, MetaCandidate } from "./autofill/sources";
import { StageRenderer } from "./render/stage";
import type { StageMeta } from "./render/stage";
import type { AdmMetadata, AudioSource } from "./types";
import {
  AssetField,
  Button,
  CheckRow,
  Dialog,
  Icon,
  NumberField,
  ProgressBar,
  Reveal,
  Section,
  Segmented,
  SelectField,
  SwapText,
  TextField,
  Tooltip,
  Toast,
} from "./ui";

const AUDIO_ACCEPT = "audio/*,.wav,.bwf,.rf64,.flac,.mp3,.m4a,.aac,.ogg";
const LYRIC_ACCEPT = ".lrc,.yrc,.qrc,.lys,.lyl,.lqe,.ttml,.xml,.txt";
const COVER_ACCEPT = "image/*";

// 离线渲染分辨率预设（16:9）+ 帧率档位；选「自定义」时宽高可编辑
const RESOLUTION_PRESETS = [
  { id: "1080p", label: "1080p（1920×1080）", width: 1920, height: 1080 },
  { id: "1440p", label: "1440p（2560×1440）", width: 2560, height: 1440 },
  { id: "4k", label: "4K（3840×2160）", width: 3840, height: 2160 },
] as const;
const FPS_CHOICES = [24, 30, 60];
const HDR_HOST = "http://127.0.0.1:8712";
const RESOLUTION_OPTIONS = [
  ...RESOLUTION_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
  { value: "custom", label: "自定义" },
];
const FPS_OPTIONS = FPS_CHOICES.map((fps) => ({
  value: String(fps),
  label: `${fps} fps`,
}));
const EXPORT_MODE_OPTIONS = [
  { value: "realtime", label: "实时录制" },
  { value: "offline", label: "离线渲染" },
  { value: "hdr", label: "HDR10+（本机）" },
];
const LYRIC_SOURCE_OPTIONS = [
  { value: "auto", label: "自动（AMLL → LRCLIB）" },
  { value: "amll", label: "AMLL 逐字 TTML" },
  { value: "lrclib", label: "LRCLIB 行级 LRC" },
];

// 输出宽高就近取偶并夹进可编码范围：H.264 yuv420 要求偶数，NaN / 过小归到下限
function snapEvenSize(v: number): number {
  if (!Number.isFinite(v)) return 2;
  return Math.min(7680, Math.max(2, Math.round(v) & ~1));
}

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

type FillStatus = { tone: "info" | "success" | "error"; text: string };
type PendingOverwrite = { label: string; run: () => void };

// 封面缩略图：挂载时先只画虚线占位，下一帧交叉模糊揭示真图（transitions.dev skeleton-reveal）。
function CoverSlot({ url }: { url: string }) {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <span className={revealed ? "t-skel cover-slot is-revealed" : "t-skel cover-slot"}>
      <span className="t-skel-skeleton" aria-hidden="true" />
      <span className="t-skel-content">
        <img className="cover-thumb" src={url} alt="封面预览" />
      </span>
    </span>
  );
}

// 空舞台：三行文案分层浮现（transitions.dev texts-reveal）。
function StageEmpty() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="stage-empty" aria-hidden="true">
      <div className={shown ? "t-stagger is-shown" : "t-stagger"}>
        <div className="t-stagger-line t-stagger-line--1">
          <div className="stage-empty-mark">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
        <div className="t-stagger-line t-stagger-line--2">
          <p className="stage-empty-title">等待载入素材</p>
        </div>
        <div className="t-stagger-line t-stagger-line--3">
          <p className="stage-empty-sub">音频 · 歌词 · 封面</p>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null);
  const stageRef = useRef<StageRenderer | null>(null);
  const stageHostRef = useRef<HTMLDivElement | null>(null);
  const bgHostRef = useRef<HTMLDivElement | null>(null);
  const coverUrlRef = useRef<string | null>(null);
  // 封面/歌词是「自动补全填的」还是「用户自己传的」：只有自动填的才允许被下一次补全覆盖
  const coverAutoRef = useRef(false);
  const lyricsAutoRef = useRef(false);
  // 用户亲手改过标题/歌手：应用 iTunes 候选前要确认，整包补全也跳过
  const metaHandRef = useRef(false);

  const [source, setSource] = useState<AudioSource | null>(null);
  const [adm, setAdm] = useState<AdmMetadata | null>(null);
  const [lines, setLines] = useState<LyricLine[]>([]);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [coverImg, setCoverImg] = useState<HTMLImageElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [timeMs, setTimeMs] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  // 导出模式与离线参数：realtime = 原实时录制路径，offline = 逐帧编码（WebCodecs + mp4-muxer）
  const [exportMode, setExportMode] = useState<"realtime" | "offline" | "hdr">("realtime");
  const [resPreset, setResPreset] = useState("1080p");
  const [outWidth, setOutWidth] = useState(1920);
  const [outHeight, setOutHeight] = useState(1080);
  const [outFps, setOutFps] = useState(30);
  // 离线渲染的取消句柄
  const abortRef = useRef<AbortController | null>(null);
  // ADM 逐声道活动时间线：预览与离线导出共用（离线舞台需要同一份数据才能画出同样的摆位）
  const admActivityRef = useRef<Uint8Array[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 歌曲信息：metaInput 是输入框原值（可为空串），metaDefault 是文件名推导值
  const [metaInput, setMetaInput] = useState<StageMeta>({ title: "", artist: "" });
  const [metaDefault, setMetaDefault] = useState<StageMeta>({ title: "", artist: "" });
  // 自动补全的结果来源与专辑名（专辑只在状态里展示，舞台信息条仍是双行）
  const [autoAlbum, setAutoAlbum] = useState("");
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoNote, setAutoNote] = useState<string | null>(null);
  // 自动补全工作台（弹层）状态
  const [fillOpen, setFillOpen] = useState(false);
  const [lyricSourceChoice, setLyricSourceChoice] = useState<"auto" | LyricSource>("auto");
  const [metaCandidates, setMetaCandidates] = useState<MetaCandidate[]>([]);
  const [lyricCandidates, setLyricCandidates] = useState<LyricCandidate[]>([]);
  const [metaBusy, setMetaBusy] = useState(false);
  const [lyricBusy, setLyricBusy] = useState(false);
  const [metaMsg, setMetaMsg] = useState<FillStatus | null>(null);
  const [lyricMsg, setLyricMsg] = useState<FillStatus | null>(null);
  const [fillNote, setFillNote] = useState<FillStatus | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<PendingOverwrite | null>(null);
  // 摆位显示：隐藏未发声对象 + 消失延迟（秒）
  const [hideSilent, setHideSilent] = useState(false);
  const [silentDelaySec, setSilentDelaySec] = useState(2);
  // 摆位视图：辉光轨迹 / 房间粒子（都由 timeMs 驱动，导出与预览一致）
  const [trailOn, setTrailOn] = useState(true);
  const [trailSec, setTrailSec] = useState(0.5);
  const [particlesOn, setParticlesOn] = useState(true);

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
    // 舞台到手就按当前状态初始化摆位视图（渲染器默认值与这里一致，显式下发避免以后默认值漂移）
    stage.setViewOptions({
      activityEnabled: hideSilent,
      activityDelayMs: silentDelaySec * 1000,
      trailMs: trailOn ? trailSec * 1000 : 0,
      particles: particlesOn,
    });
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
      // 换了素材，上一轮的补全结果就作废了
      setAutoAlbum("");
      setAutoNote(null);
      stage.setMeta(resolveMeta(derived, derived));
      stage.setDuration(loaded.source.durationSec * 1000);

      const admMeta: AdmMetadata | null = loaded.source.isAdm ? loaded.adm : null;
      // 逐声道活动时间线随 ADM 下发；对象按声道绑定（chna / trackIndex）在渲染器内取用
      admActivityRef.current = admMeta ? loaded.activity : null;
      stage.setAdm(admMeta, admActivityRef.current);

      setSource(loaded.source);
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
    metaHandRef.current = true;
    const next = { ...metaInput, ...patch };
    setMetaInput(next);
    const stage = stageRef.current;
    if (!stage) return;
    stage.setMeta(resolveMeta(next, metaDefault));
    stage.render();
  };

  // 摆位视图选项：改状态 + 下发给渲染器，并补一帧（暂停时没有 tick，画面不会自己更新）
  const updateView = (patch: {
    hideSilent?: boolean;
    silentDelaySec?: number;
    trailOn?: boolean;
    trailSec?: number;
    particlesOn?: boolean;
  }): void => {
    const nextHide = patch.hideSilent ?? hideSilent;
    const nextDelay = patch.silentDelaySec ?? silentDelaySec;
    const nextTrailOn = patch.trailOn ?? trailOn;
    const nextTrailSec = patch.trailSec ?? trailSec;
    const nextParticles = patch.particlesOn ?? particlesOn;
    setHideSilent(nextHide);
    setSilentDelaySec(nextDelay);
    setTrailOn(nextTrailOn);
    setTrailSec(nextTrailSec);
    setParticlesOn(nextParticles);
    const stage = stageRef.current;
    if (!stage) return;
    stage.setViewOptions({
      activityEnabled: nextHide,
      activityDelayMs: nextDelay * 1000,
      // 轨迹时长 0 = 关闭，不需要单独的开关字段
      trailMs: nextTrailOn ? nextTrailSec * 1000 : 0,
      particles: nextParticles,
    });
    syncStage();
  };

  const handleLyric = async (file: File): Promise<void> => {
    const stage = stageRef.current;
    if (!stage) return;
    setBusy(true);
    setError(null);
    try {
      lyricsAutoRef.current = false; // 用户亲手传的歌词，后续自动补全不得覆盖
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
    coverAutoRef.current = false; // 用户亲手传的封面，后续自动补全不得覆盖
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

  // 把取回的封面 Blob 装成图片（blob: URL 同源，不会污染画布），复用上传路径的装填逻辑
  const applyCoverBlob = (blob: Blob): Promise<boolean> =>
    new Promise((resolve) => {
      const stage = stageRef.current;
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const prev = coverUrlRef.current;
        coverUrlRef.current = url;
        if (prev) URL.revokeObjectURL(prev);
        setCoverUrl(url);
        setCoverImg(img);
        stage?.setCover(img);
        stage?.render();
        resolve(true);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(false);
      };
      img.src = url;
    });

  // ── 自动补全工作台：候选由用户点选，应用前不写入舞台 ──
  const buildQuery = () => ({
    title: metaInput.title.trim() || metaDefault.title,
    artist: metaInput.artist.trim() || metaDefault.artist,
    durationMs: source ? source.durationSec * 1000 : 0,
  });

  const openFill = (): void => {
    setFillNote(null);
    setMetaMsg(null);
    setLyricMsg(null);
    setPendingOverwrite(null);
    setFillOpen(true);
  };

  const closeFill = (): void => {
    setFillOpen(false);
    setPendingOverwrite(null);
  };

  const fetchMeta = async (): Promise<void> => {
    const query = buildQuery();
    if (!query.title) {
      setMetaCandidates([]);
      setMetaMsg({ tone: "info", text: "先载入音频或填写标题" });
      return;
    }
    setMetaBusy(true);
    setMetaMsg(null);
    try {
      const list = await searchMetaCandidates({ title: query.title, artist: query.artist });
      setMetaCandidates(list);
      if (list.length === 0) setMetaMsg({ tone: "info", text: "iTunes 未找到匹配，可手动填写" });
    } catch (e) {
      setMetaCandidates([]);
      setMetaMsg({ tone: "error", text: `信息源获取失败：${errText(e)}，可重试` });
    } finally {
      setMetaBusy(false);
    }
  };

  // 「自动」= AMLL 优先、空则换 LRCLIB
  const lyricSources = (): LyricSource[] =>
    lyricSourceChoice === "auto" ? ["amll", "lrclib"] : [lyricSourceChoice];

  const fetchLyric = async (): Promise<void> => {
    const query = buildQuery();
    if (!query.title) {
      setLyricCandidates([]);
      setLyricMsg({ tone: "info", text: "先载入音频或填写标题" });
      return;
    }
    setLyricBusy(true);
    setLyricMsg(null);
    const problems: string[] = [];
    try {
      for (const src of lyricSources()) {
        try {
          const list = await searchLyricCandidates(query, src);
          if (list.length > 0) {
            setLyricCandidates(list);
            setLyricMsg({
              tone: "success",
              text: src === "amll" ? `AMLL 逐字歌词 · ${list.length} 条` : `LRCLIB 行级歌词 · ${list.length} 条`,
            });
            return;
          }
          problems.push(`${src} 无结果`);
        } catch (e) {
          problems.push(`${src}：${errText(e)}`);
        }
      }
      setLyricCandidates([]);
      setLyricMsg({ tone: "error", text: `${problems.join("；")}，可换源重试` });
    } finally {
      setLyricBusy(false);
    }
  };

  const applyMeta = async (cand: MetaCandidate, overwriteCover: boolean): Promise<{ coverOk: boolean }> => {
    const stage = stageRef.current;
    if (!stage) return { coverOk: false };
    const next: StageMeta = { title: cand.title, artist: cand.artist };
    setMetaInput(next);
    setMetaDefault(next);
    setAutoAlbum(cand.album);
    stage.setMeta(resolveMeta(next, next));
    stage.render();
    let coverOk = false;
    if (cand.coverUrl && (overwriteCover || !coverUrlRef.current || coverAutoRef.current)) {
      const blob = await fetchCoverBlob(cand);
      if (blob) {
        coverOk = await applyCoverBlob(blob);
        if (coverOk) coverAutoRef.current = true;
      }
    }
    return { coverOk };
  };

  const applyLyric = async (cand: LyricCandidate): Promise<number> => {
    const stage = stageRef.current;
    if (!stage) throw new Error("舞台未就绪");
    const text = await cand.load();
    const parsed = parseLyricsText(text, cand.format);
    if (parsed.length === 0) throw new Error("该候选解析不出歌词行");
    lyricsAutoRef.current = true;
    setLines(parsed);
    stage.setLyricLines(parsed);
    stage.render();
    return parsed.length;
  };

  // 点信息候选：手填过的信息 / 手传的封面都要先确认
  const requestApplyMeta = (cand: MetaCandidate, force = false): void => {
    const overwrites: string[] = [];
    if (metaHandRef.current && (metaInput.title.trim() || metaInput.artist.trim())) overwrites.push("歌曲信息");
    if (coverUrlRef.current && !coverAutoRef.current) overwrites.push("封面");
    if (!force && overwrites.length > 0) {
      setPendingOverwrite({
        label: `将覆盖你手动设置的${overwrites.join("、")}：${cand.title} — ${cand.artist}`,
        run: () => requestApplyMeta(cand, true),
      });
      return;
    }
    setPendingOverwrite(null);
    void (async () => {
      try {
        const { coverOk } = await applyMeta(cand, true);
        setFillNote({
          tone: "success",
          text: `已应用：${cand.title} — ${cand.artist}${coverOk ? "（含封面）" : ""}`,
        });
      } catch (e) {
        setFillNote({ tone: "error", text: `应用失败：${errText(e)}` });
      }
    })();
  };

  // 点歌词候选：手传的歌词要先确认
  const requestApplyLyric = (cand: LyricCandidate, force = false): void => {
    if (!force && lines.length > 0 && !lyricsAutoRef.current) {
      setPendingOverwrite({
        label: `将覆盖你手动载入的歌词：${cand.title}`,
        run: () => requestApplyLyric(cand, true),
      });
      return;
    }
    setPendingOverwrite(null);
    void (async () => {
      try {
        const count = await applyLyric(cand);
        setFillNote({ tone: "success", text: `已应用歌词（${count} 行）` });
      } catch (e) {
        setFillNote({ tone: "error", text: `歌词应用失败：${errText(e)}` });
      }
    })();
  };

  // 一键全补：只覆盖自动填/空槽，手设的跳过（信息手填也跳过）
  const runBundle = async (): Promise<void> => {
    const query = buildQuery();
    if (!query.title) {
      setFillNote({ tone: "info", text: "先载入音频或填写标题" });
      return;
    }
    setAutoBusy(true);
    setFillNote(null);
    setError(null);
    try {
      const meta = await bestMetaCandidate({ title: query.title, artist: query.artist }).catch(() => null);
      let lyric: LyricCandidate | null = null;
      for (const src of lyricSources()) {
        try {
          const list = await searchLyricCandidates(query, src);
          if (list.length > 0) {
            lyric = list[0];
            break;
          }
        } catch {
          // 换下一个源
        }
      }
      const parts: string[] = [];
      const skipped: string[] = [];
      if (meta && !metaHandRef.current) {
        const { coverOk } = await applyMeta(meta, false);
        parts.push(coverOk ? "信息与封面" : "信息");
      } else if (meta) {
        skipped.push("信息");
      }
      if (lyric && (lines.length === 0 || lyricsAutoRef.current)) {
        const count = await applyLyric(lyric);
        parts.push(`歌词（${count} 行）`);
      } else if (lyric) {
        skipped.push("歌词");
      }
      const text =
        parts.length === 0 && skipped.length === 0
          ? "没找到可补的内容"
          : `已补全：${parts.length ? parts.join(" · ") : "无"}${skipped.length ? `（跳过手设的${skipped.join("、")}）` : ""}`;
      setFillNote({ tone: parts.length > 0 ? "success" : "info", text });
      setAutoNote(text);
    } catch (e) {
      setFillNote({ tone: "error", text: `自动补全失败：${errText(e)}` });
    } finally {
      setAutoBusy(false);
    }
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

  // 离线逐帧导出：不播放、不等实时。画面走独立 StageRenderer（与预览同一帧路径），
  // 音频取解码缓冲 → OfflineAudioContext 下混立体声 → WebCodecs 编码 → mp4-muxer 封 MP4。
  const exportOffline = async (): Promise<void> => {
    const engine = engineRef.current;
    if (!engine || !source) return;
    const buffer = engine.decodedBuffer;
    if (!buffer) {
      setError("音频缓冲尚未就绪，无法离线渲染");
      return;
    }

    const width = snapEvenSize(outWidth);
    const height = snapEvenSize(outHeight);
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setExporting(true);
    setExportProgress(0);
    engine.pause(); // 离线不驱动播放时钟；避免播放与渲染争抢 CPU

    // 独立舞台实例：装上与预览一致的状态，但尺寸为目标分辨率（scale 参数化），不干扰预览画布
    const offStage = new StageRenderer(width, height);
    offStage.setCover(coverImg);
    offStage.setLyricLines(lines);
    offStage.setMeta(resolveMeta(metaInput, metaDefault));
    offStage.setDuration((engine.duration || source.durationSec) * 1000);
    offStage.setAdm(adm, adm ? admActivityRef.current : null);
    offStage.setViewOptions({
      activityEnabled: hideSilent,
      activityDelayMs: silentDelaySec * 1000,
      trailMs: trailOn ? trailSec * 1000 : 0,
      particles: particlesOn,
    });
    // bgCanvas 挂进预览的流体背景宿主：StageRenderer 靠 parentElement 里的 canvas 找到 AMLL
    // 流体背景（宿主是空的 React 节点，追加的 canvas 不会被 React 回收）。
    // ponytail: AMLL 流体画布由 AMLL 自身按真实时间驱动、无法按时间轴重放，离线导出里它只按
    // 渲染墙钟推进，与音乐的对应关系是近似的；要精确重放需改为由时间轴驱动的背景。
    bgHostRef.current?.appendChild(offStage.bgCanvas);

    try {
      const blob = await exportOfflineRender({
        canvas: offStage.canvas,
        buffer,
        fps: outFps,
        renderFrame: (t) => {
          offStage.setTime(t);
          offStage.render();
        },
        onProgress: setExportProgress,
        signal: controller.signal,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${baseName(source.fileName)}.mp4`;
      a.click();
      // ponytail: 延迟回收；立刻 revoke 在部分浏览器会打断下载
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      if ((e as Error).name === "AbortError") setError("离线渲染已取消");
      else setError(`离线渲染失败：${errText(e)}`);
    } finally {
      offStage.bgCanvas.remove();
      offStage.dispose();
      abortRef.current = null;
      setExporting(false);
    }
  };

  // HDR10+ 导出：复用离线逐帧的舞台渲染，把每帧转成 10-bit PQ 流式送给本机 HdrHost，
  // 由 ffmpeg/libx265 编码 + hdr10plus_tool 注入 ST2094-40 元数据。
  const exportHdr = async (): Promise<void> => {
    const engine = engineRef.current;
    if (!engine || !source) return;
    const buffer = engine.decodedBuffer;
    if (!buffer) {
      setError("音频缓冲尚未就绪，无法 HDR 导出");
      return;
    }

    const width = snapEvenSize(outWidth);
    const height = snapEvenSize(outHeight);
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setExporting(true);
    setExportProgress(0);
    engine.pause();

    const offStage = new StageRenderer(width, height);
    offStage.setCover(coverImg);
    offStage.setLyricLines(lines);
    offStage.setMeta(resolveMeta(metaInput, metaDefault));
    offStage.setDuration((engine.duration || source.durationSec) * 1000);
    offStage.setAdm(adm, adm ? admActivityRef.current : null);
    offStage.setViewOptions({
      activityEnabled: hideSilent,
      activityDelayMs: silentDelaySec * 1000,
      trailMs: trailOn ? trailSec * 1000 : 0,
      particles: particlesOn,
    });
    bgHostRef.current?.appendChild(offStage.bgCanvas);

    try {
      if (!(await isHdrHostAvailable(HDR_HOST))) {
        throw new Error(`本机 HdrHost 未运行（${HDR_HOST}），请先启动 tools/hdr-host`);
      }
      const durationSec = engine.duration || source.durationSec;
      const frameCount = Math.max(1, Math.round(durationSec * outFps));
      const res = await exportHdrStream({
        canvas: offStage.canvas,
        renderFrame: (t) => {
          offStage.setTime(t);
          offStage.render();
        },
        emissive: () => offStage.getEmissiveCanvas(),
        fps: outFps,
        frameCount,
        buffer,
        host: HDR_HOST,
        onProgress: setExportProgress,
        signal: controller.signal,
      });
      setAutoNote(`HDR10+ 已导出：${res.path}（${res.frames} 帧，转换后端 ${res.backend}）`);
    } catch (e) {
      if ((e as Error).name === "AbortError") setError("HDR 导出已取消");
      else setError(`HDR 导出失败：${errText(e)}`);
    } finally {
      offStage.bgCanvas.remove();
      offStage.dispose();
      abortRef.current = null;
      setExporting(false);
    }
  };

  const handleExport = async (): Promise<void> => {
    const engine = engineRef.current;
    const stage = stageRef.current;
    if (!engine || !stage || exporting) return;
    if (!source) {
      setError("请先载入音频文件，再导出视频");
      return;
    }
    if (exportMode === "offline") {
      await exportOffline();
      return;
    }
    if (exportMode === "hdr") {
      await exportHdr();
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
  // WebCodecs 能力检测：不支持时离线模式在 UI 上禁用并回退实时录制
  const offlineSupported = isOfflineRenderSupported();
  // 只在完全空白时盖住舞台：只有歌词或只有封面时仍显示既有画面
  const stageEmpty = !source && lines.length === 0 && !coverUrl;

  const loadedAssets = (source ? 1 : 0) + (lines.length > 0 ? 1 : 0) + (coverUrl ? 1 : 0);
  const stageMode = adm
    ? `Dolby Atmos · ${adm.objects.length} 对象`
    : source
      ? "立体声"
      : "等待音频";
  const noteTone = autoNote?.startsWith("已补全") ? "success" : "info";
  const exportLabel =
    exportMode === "offline" || exportMode === "hdr"
      ? exporting
        ? `渲染中 ${Math.round(exportProgress * 100)}%`
        : exportMode === "hdr"
          ? "HDR10+ 导出"
          : "离线渲染导出"
      : exporting
        ? `导出中 ${Math.round(exportProgress * 100)}%`
        : "导出视频";

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
        <div className="brand-lockup">
          <h1 className="brand">
            <span className="brand-mark" aria-hidden="true">律</span>
            <span className="brand-name">Ritsu</span>
          </h1>
          <p className="tagline">歌词视频渲染器 · 支持 Dolby Atmos 空间摆位</p>
        </div>
        <div className="header-status" aria-live="polite">
          {busy ? (
            <span className="chip chip-accent t-shimmer" data-text="处理中…">
              处理中…
            </span>
          ) : null}
          {source ? (
            <span className="chip">
              <span className="chip-dot is-live" />
              {source.channelCount} 声道
            </span>
          ) : null}
          {source ? (
            <span className="chip">{(source.sampleRate / 1000).toFixed(1)} kHz</span>
          ) : null}
          {adm ? <span className="chip chip-accent">Dolby Atmos</span> : null}
          {adm ? <span className="chip">{adm.objects.length} 对象</span> : null}
          {lines.length > 0 ? <span className="chip">{lines.length} 行歌词</span> : null}
          {!source && lines.length === 0 && !busy ? (
            <span className="chip chip-muted">
              <span className="chip-dot" />
              等待载入素材
            </span>
          ) : null}
          <span className="header-rule" aria-hidden="true" />
          <span className="header-meta">v0.1 / AGPL-3.0</span>
        </div>
      </header>

      <main className="app-main">
        <aside className="panel" aria-busy={busy}>
          <div className="panel-head">
            <div>
              <p className="panel-eyebrow">Input / Parameters</p>
              <h2 className="panel-title">素材与参数</h2>
            </div>
            <span className="panel-count">{adm ? "05" : "04"} / 05</span>
          </div>

          <Section index="01" title="素材" meta={`${loadedAssets}/3`}>
            <AssetField
              label="音频文件"
              hint="WAV · BWF · RF64 · FLAC · MP3 · M4A"
              accept={AUDIO_ACCEPT}
              fileName={source?.fileName}
              detail={
                source
                  ? `${(source.sampleRate / 1000).toFixed(1)} kHz · ${source.channelCount} 声道`
                  : undefined
              }
              disabled={locked}
              icon="audio"
              onFile={(file) => void handleAudio(file)}
            />
            <AssetField
              label="歌词文件"
              hint="LRC · YRC · QRC · Lyricify · TTML"
              accept={LYRIC_ACCEPT}
              fileName={lines.length > 0 ? "歌词已载入" : null}
              detail={lines.length > 0 ? `${lines.length} 行歌词` : undefined}
              disabled={locked}
              icon="lyrics"
              onFile={(file) => void handleLyric(file)}
            />
            <AssetField
              label="封面图片"
              hint="建议 1:1 方图 · PNG / JPG"
              accept={COVER_ACCEPT}
              fileName={coverUrl ? "封面已载入" : null}
              detail={
                coverImg
                  ? `${coverImg.naturalWidth} × ${coverImg.naturalHeight}`
                  : coverUrl
                    ? "自动匹配"
                    : undefined
              }
              disabled={locked}
              icon="image"
              preview={coverUrl ? <CoverSlot url={coverUrl} /> : undefined}
              onFile={handleCover}
            />
          </Section>

          <Section index="02" title="歌曲信息" meta={autoAlbum ? "已补全" : "手动输入"}>
            <div className="meta-row">
              <TextField
                label="标题"
                value={metaInput.title}
                placeholder={metaDefault.title || META_PLACEHOLDER.title}
                disabled={locked}
                onChange={(value) => updateMeta({ title: value })}
              />
              <TextField
                label="歌手"
                value={metaInput.artist}
                placeholder={metaDefault.artist || META_PLACEHOLDER.artist}
                disabled={locked}
                onChange={(value) => updateMeta({ artist: value })}
              />
            </div>
            <Button
              block
              disabled={locked || autoBusy}
              onClick={openFill}
            >
              <Icon name="spark" size={14} />
              <SwapText text="自动补全信息与歌词" />
            </Button>
            {autoAlbum ? (
              <p className="micro-note">
                <span>ALBUM</span>
                {autoAlbum}
              </p>
            ) : null}
          </Section>

          <Section index="03" title="播放" meta={source ? formatTime(durationMs) : "未载入"}>
            <div className="transport">
              <Tooltip label={playing ? "暂停" : "播放"}>
                <button
                  type="button"
                  className="play-btn"
                  onClick={togglePlay}
                  disabled={!source || locked}
                  aria-label={playing ? "暂停" : "播放"}
                >
                  <span
                    className="t-icon-swap"
                    data-state={playing ? "b" : "a"}
                    aria-hidden="true"
                  >
                    <span className="t-icon" data-icon="a">
                      <Icon name="play" size={17} />
                    </span>
                    <span className="t-icon" data-icon="b">
                      <Icon name="pause" size={17} />
                    </span>
                  </span>
                </button>
              </Tooltip>
              <div className="time-block">
                <div className="time-main">
                  <span className="time-current">{formatTime(timeMs)}</span>
                  <span className="time-total">/ {formatTime(durationMs)}</span>
                </div>
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
          </Section>

          <Section
            index="04"
            title="导出"
            meta={
              exportMode === "offline" || exportMode === "hdr"
                ? `${snapEvenSize(outWidth)} × ${snapEvenSize(outHeight)}`
                : "实时录制"
            }
          >
            <Segmented
              label="模式"
              value={exportMode}
              options={EXPORT_MODE_OPTIONS}
              disabled={locked}
              onChange={(value) =>
                setExportMode(value === "offline" ? "offline" : value === "hdr" ? "hdr" : "realtime")
              }
            />

            {exportMode === "offline" || exportMode === "hdr" ? (
              <Reveal>
                <div className="stack">
                  <div className="meta-row">
                    <SelectField
                      label="分辨率"
                      value={resPreset}
                      options={RESOLUTION_OPTIONS}
                      disabled={locked}
                      onChange={(value) => {
                        setResPreset(value);
                        const preset = RESOLUTION_PRESETS.find((item) => item.id === value);
                        if (preset) {
                          setOutWidth(preset.width);
                          setOutHeight(preset.height);
                        }
                      }}
                    />
                    <SelectField
                      label="帧率"
                      value={String(outFps)}
                      options={FPS_OPTIONS}
                      disabled={locked}
                      onChange={(value) => setOutFps(Number(value))}
                    />
                  </div>
                  {resPreset === "custom" ? (
                    <Reveal>
                      <div className="meta-row">
                        <NumberField
                          label="宽度"
                          value={outWidth}
                          min={2}
                          max={7680}
                          step={2}
                          unit="px"
                          disabled={locked}
                          onChange={setOutWidth}
                        />
                        <NumberField
                          label="高度"
                          value={outHeight}
                          min={2}
                          max={7680}
                          step={2}
                          unit="px"
                          disabled={locked}
                          onChange={setOutHeight}
                        />
                      </div>
                    </Reveal>
                  ) : null}
                </div>
              </Reveal>
            ) : null}

            <Button
              variant="primary"
              onClick={() => void handleExport()}
              disabled={!source || locked}
            >
              {exporting ? <span>{exportLabel}</span> : exportLabel}
            </Button>

            {exporting ? (
              <>
                <ProgressBar
                  value={exportProgress * 100}
                  label={exportMode === "offline" || exportMode === "hdr" ? "逐帧编码" : "实时录制"}
                />
                {exportMode === "offline" || exportMode === "hdr" ? (
                  <Button block onClick={() => abortRef.current?.abort()}>
                    取消渲染
                  </Button>
                ) : null}
              </>
            ) : null}

            <p className="hint">
              {exportMode === "hdr"
                ? `HDR10+ 导出：逐帧转 10-bit PQ 并流式送给本机 HdrHost（${HDR_HOST}），先运行 tools/hdr-host。4K 走 CPU 转换较慢。`
                : exportMode === "offline"
                ? offlineSupported
                  ? `离线渲染 ${snapEvenSize(outWidth)}×${snapEvenSize(outHeight)} @ ${outFps}fps，逐帧编码；非 16:9 分辨率会等比居中留黑边。`
                  : "当前浏览器不支持 WebCodecs，离线渲染不可用，请使用实时录制。"
                : "实时导出：录制耗时约等于歌曲时长，期间请保持页面在前台。"}
            </p>
          </Section>

          {adm ? (
            <Reveal>
              <Section
                index="05"
                title="摆位显示"
                meta={`${adm.objects.length} 对象`}
                defaultOpen
              >
                <CheckRow
                  label="隐藏未发声对象"
                  description="对象停止发声后淡出，重新发声立即恢复"
                  checked={hideSilent}
                  disabled={locked}
                  onChange={() => updateView({ hideSilent: !hideSilent })}
                />
                <div className="indent-field">
                  <NumberField
                    label="消失延迟"
                    value={silentDelaySec}
                    min={0}
                    max={30}
                    step={0.5}
                    unit="秒"
                    disabled={!hideSilent || locked}
                    onChange={(value) => updateView({ silentDelaySec: value })}
                  />
                </div>
                <CheckRow
                  label="辉光轨迹"
                  description="对象移动时留下由时间驱动的轨迹"
                  checked={trailOn}
                  disabled={locked}
                  onChange={() => updateView({ trailOn: !trailOn })}
                />
                <div className="indent-field">
                  <NumberField
                    label="轨迹时长"
                    value={trailSec}
                    min={0}
                    max={2}
                    step={0.1}
                    unit="秒"
                    disabled={!trailOn || locked}
                    onChange={(value) => updateView({ trailSec: value })}
                  />
                </div>
                <CheckRow
                  label="粒子云雾"
                  description="房间粒子的固定 seed，预览与导出逐帧一致"
                  checked={particlesOn}
                  disabled={locked}
                  onChange={() => updateView({ particlesOn: !particlesOn })}
                />
                <p className="hint hint--muted">
                  摆位仅读取 ADM 元数据，不参与音频解码；所有动画都是 timeMs 的纯函数。
                </p>
              </Section>
            </Reveal>
          ) : null}

        </aside>

        <section className="stage-panel">
          <div className="stage-topline">
            <div className="stage-heading">
              <span className="stage-title">预览</span>
              <span className="stage-res">1920 × 1080</span>
            </div>
            <span className="stage-mode">
              <span className="stage-live-dot" aria-hidden="true" />
              {stageMode}
            </span>
          </div>

          <div className="stage-frame" ref={stageHostRef}>
            {stageEmpty ? <StageEmpty /> : null}
          </div>

          <div className="stage-foot">
            <span>AMLL 流体背景 · 实时合成</span>
            <span>
              {exportMode === "offline" ? "离线逐帧" : "实时录制"} ·{" "}
              {offlineSupported ? "WebCodecs 就绪" : "WebCodecs 不可用"}
            </span>
          </div>
        </section>
      </main>

      <Dialog
        open={fillOpen}
        title="自动补全信息与歌词"
        description="按需获取，结果先列出来由你挑；应用前不写入舞台。"
        onClose={closeFill}
      >
        <div className="fill-unit">
          <div className="fill-unit-head">
            <span className="fill-unit-title">信息与封面</span>
            <span className="fill-unit-src">iTunes</span>
          </div>
          <div className="fill-unit-actions">
            <Button size="sm" onClick={() => void fetchMeta()} disabled={metaBusy}>
              {metaBusy ? "获取中…" : "获取候选"}
            </Button>
          </div>
          {metaMsg ? (
            <p className="fill-status" data-tone={metaMsg.tone}>
              {metaMsg.text}
            </p>
          ) : null}
          {metaCandidates.length > 0 ? (
            <ul className="fill-list">
              {metaCandidates.map((cand) => (
                <li key={cand.id}>
                  <button type="button" className="fill-item" onClick={() => requestApplyMeta(cand)}>
                    <span className="fill-item-thumb">
                      {cand.coverUrl ? <img src={cand.coverUrl} alt="" loading="lazy" /> : null}
                    </span>
                    <span className="fill-item-copy">
                      <span className="fill-item-title">{cand.title || "（无标题）"}</span>
                      <span className="fill-item-artist">
                        {cand.artist || "未知歌手"}
                        {cand.album ? ` · ${cand.album}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="fill-unit">
          <div className="fill-unit-head">
            <span className="fill-unit-title">歌词</span>
            <SelectField
              label="来源"
              value={lyricSourceChoice}
              options={LYRIC_SOURCE_OPTIONS}
              disabled={lyricBusy}
              onChange={(value) => {
                setLyricSourceChoice(value as "auto" | LyricSource);
                setLyricCandidates([]);
                setLyricMsg(null);
              }}
            />
          </div>
          <div className="fill-unit-actions">
            <Button size="sm" onClick={() => void fetchLyric()} disabled={lyricBusy}>
              {lyricBusy ? "获取中…" : "获取候选"}
            </Button>
          </div>
          {lyricMsg ? (
            <p className="fill-status" data-tone={lyricMsg.tone}>
              {lyricMsg.text}
            </p>
          ) : null}
          {lyricCandidates.length > 0 ? (
            <ul className="fill-list">
              {lyricCandidates.map((cand) => (
                <li key={cand.id}>
                  <button type="button" className="fill-item" onClick={() => requestApplyLyric(cand)}>
                    <span className="fill-item-copy">
                      <span className="fill-item-title">{cand.title}</span>
                      <span className="fill-item-artist">
                        {cand.artist || "未知歌手"}
                        {cand.album ? ` · ${cand.album}` : ""}
                        {cand.synced ? " · 有时间轴" : ""}
                        {typeof cand.lineCount === "number" ? ` · ${cand.lineCount} 行` : ""}
                      </span>
                    </span>
                    <span className="fill-item-badge" data-source={cand.source}>
                      {cand.source === "amll" ? "AMLL" : "LRCLIB"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {pendingOverwrite ? (
          <div className="fill-confirm" role="alertdialog" aria-live="assertive">
            <p>{pendingOverwrite.label}</p>
            <div className="fill-confirm-actions">
              <Button size="sm" variant="quiet" onClick={() => setPendingOverwrite(null)}>
                取消
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  const pending = pendingOverwrite;
                  setPendingOverwrite(null);
                  pending.run();
                }}
              >
                确认覆盖
              </Button>
            </div>
          </div>
        ) : fillNote ? (
          <p className="fill-status" data-tone={fillNote.tone}>
            {fillNote.text}
          </p>
        ) : null}

        <div className="fill-footer">
          <Button variant="primary" block onClick={() => void runBundle()} disabled={autoBusy || locked}>
            {autoBusy ? "全部补全中…" : "一键全部获取（推荐）"}
          </Button>
        </div>
      </Dialog>

      <div className="toast-stack" aria-live="polite">
        {error ? (
          <Toast
            key={`error-${error}`}
            message={error}
            tone="error"
            onClose={() => setError(null)}
          />
        ) : autoNote ? (
          <Toast
            key={`note-${autoNote}`}
            message={autoNote}
            tone={noteTone}
            onClose={() => setAutoNote(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
