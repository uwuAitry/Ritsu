// Ritsu 共享类型契约（供各功能模块引用）

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
  /** 摆位时间轴，按 timeMs 升序；缺省或长度 < 2 表示静态摆位 */
  track?: AdmKeyframe[];
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
