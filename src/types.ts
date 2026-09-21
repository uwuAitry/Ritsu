// Ritsu 共享类型契约（供各功能模块引用）

// 对象发声活动时间线的时间分辨率（100ms 一窗）：解码时逐声道累计 RMS 产出，
// wav.ts（生产）与 atmos/activity.ts（消费）共用，防止两侧窗长漂移
export const ACTIVITY_WINDOW_MS = 100;

// ADM audioBlockFormat 关键帧（时间轴上的一个摆位点）
export interface AdmKeyframe {
  timeMs: number;
  x: number;
  y: number;
  z: number;
  /** jumpPosition=1：跳变（不平滑），保持上一块位置直到本块 rtime */
  jump: boolean;
}

// 一个 Dolby Atmos 音频对象的空间摆位
export interface AdmObject {
  id: string;
  name: string;
  // 归一化笛卡尔坐标（-1..1）
  x: number;
  y: number;
  z: number;
  // 球坐标
  azimuthDeg: number;
  elevationDeg: number;
  distance: number;
  gain: number;
  /** 声音来源的 WAV 声道号（0 基）：由 chna chunk（权威）或 audioTrackUID@trackIndex 推导。
   *  缺省 = 绑定未知，该对象视为始终发声（活动门控对它 no-op） */
  channelIndex?: number;
  /** 摆位时间轴，按 timeMs 升序；缺省或长度 < 2 表示静态摆位 */
  track?: AdmKeyframe[];
}

// 摆位视图的空间形状：盒形房间（默认）或球形空间
export type AtmosRoomShape = "box" | "sphere";

// 摆位视图选项（App → stage → atmos 透传；预览与离线导出共用同一份）
export interface AtmosViewOptions {
  /** 活动门控：隐藏未发声对象 */
  activityEnabled?: boolean;
  activityDelayMs?: number;
  roomShape?: AtmosRoomShape;
  /** 辉光轨迹时长（ms）；0 = 关闭 */
  trailMs?: number;
  /** 房间粒子 */
  particles?: boolean;
}

// ADM BWF 解析结果
export interface AdmMetadata {
  objects: AdmObject[];
  title?: string;
  audioPackFormat?: string;
}

// 已加载的音频源
export interface AudioSource {
  fileName: string;
  channelCount: number;
  sampleRate: number;
  durationSec: number;
  // 已解码的音频缓冲（Web Audio）
  buffer: AudioBuffer | null;
  // 是否为 ADM BWF（含 axml chunk）
  isAdm: boolean;
}
