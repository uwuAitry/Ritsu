// ADM BWF 解析：BW64/RF64/RIFF 容器 → axml chunk → audioObject 摆位
// 仅依赖 ../types，无外部依赖。

import type { AdmKeyframe, AdmMetadata, AdmObject } from "../types";

// ── 容器层 ──────────────────────────────────────────────

export interface RiffChunk {
  id: string;
  /** chunk 数据起始（chunk 头 8 字节之后） */
  offset: number;
  size: number;
}

const CHUNK_ID_RE = /^[a-zA-Z0-9 ]{4}$/;

function fourcc(dv: DataView, off: number): string {
  return String.fromCharCode(
    dv.getUint8(off),
    dv.getUint8(off + 1),
    dv.getUint8(off + 2),
    dv.getUint8(off + 3),
  );
}

// u64 均小于 2^53，用 hi*2^32 + lo 即可，不引入 BigInt。
function readU64(dv: DataView, off: number): number {
  const lo = dv.getUint32(off, true);
  const hi = dv.getUint32(off + 4, true);
  return hi * 4294967296 + lo;
}

// 遍历顶层 chunk。RF64/BW64 的 ds64 覆盖表在此应用。
// 非 RIFF/RF64/BW64 + WAVE 或格式非法时返回 null（不抛）。
export function walkRiffChunks(
  buffer: ArrayBuffer,
): { containerId: string; chunks: RiffChunk[] } | null {
  try {
    if (buffer.byteLength < 12) return null;
    const dv = new DataView(buffer);
    const containerId = fourcc(dv, 0);
    if (
      containerId !== "RIFF" &&
      containerId !== "RF64" &&
      containerId !== "BW64"
    ) {
      return null;
    }
    if (fourcc(dv, 8) !== "WAVE") return null;

    const overrides = new Map<string, number>();
    let dataSizeOverride = -1;
    const chunks: RiffChunk[] = [];

    let offset = 12;
    while (offset + 8 <= buffer.byteLength) {
      const id = fourcc(dv, offset);
      if (!CHUNK_ID_RE.test(id)) return null;

      let size = dv.getUint32(offset + 4, true);

      if (id === "ds64") {
        // u64 riffSize / u64 dataSize / u64 sampleCount / u32 tableLength / table
        const base = offset + 8;
        dataSizeOverride = readU64(dv, base + 8);
        const tableLength = dv.getUint32(base + 24, true);
        let p = base + 28;
        for (let i = 0; i < tableLength; i++) {
          overrides.set(fourcc(dv, p), readU64(dv, p + 4));
          p += 12;
        }
      }

      if (id === "data" && dataSizeOverride >= 0) size = dataSizeOverride;
      const ov = overrides.get(id);
      if (ov !== undefined) size = ov;

      chunks.push({ id, offset: offset + 8, size });
      // 2 字节对齐：size 为奇数时跳过 1 个 pad 字节（不计入 size）。
      offset = offset + 8 + size + (size & 1);
    }
    return { containerId, chunks };
  } catch {
    return null;
  }
}

export function extractAxmlChunk(buffer: ArrayBuffer): string | null {
  const walked = walkRiffChunks(buffer);
  if (!walked) return null;
  const axml = walked.chunks.find((c) => c.id === "axml");
  if (!axml) return null;
  const end = Math.min(axml.offset + axml.size, buffer.byteLength);
  const len = Math.max(0, end - axml.offset);
  const bytes = new Uint8Array(buffer, axml.offset, len);
  return new TextDecoder("utf-8").decode(bytes);
}

export function isAdmBwf(buffer: ArrayBuffer): boolean {
  return extractAxmlChunk(buffer) !== null;
}

// ── XML 层 ──────────────────────────────────────────────

// 命名空间多变，一律按 localName 匹配；属性从不带命名空间，用 getAttribute。
function* walk(el: Element): Generator<Element, void, unknown> {
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    yield c;
    yield* walk(c);
  }
}

function findFirst(root: Element | null, localName: string): Element | null {
  if (!root) return null;
  for (const el of walk(root)) {
    if (el.localName === localName) return el;
  }
  return null;
}

function findAll(root: Element, localName: string): Element[] {
  const out: Element[] = [];
  for (const el of walk(root)) {
    if (el.localName === localName) out.push(el);
  }
  return out;
}

function text(el: Element | null): string {
  return (el?.textContent ?? "").trim();
}

function attr(el: Element | null, name: string): string | null {
  return el?.getAttribute(name) ?? null;
}

// 保留 Objects：类型缺失视为对象；出现且不是 0003/Objects 则跳过。
function isObjectType(...vals: Array<string | null>): boolean {
  for (const v of vals) {
    if (v == null) continue;
    const t = v.trim();
    if (!t) continue;
    if (t === "0003" || t.toLowerCase() === "objects") continue;
    return false;
  }
  return true;
}

// ── 坐标 ────────────────────────────────────────────────

export function polarToCartesian(
  azimuthDeg: number,
  elevationDeg: number,
  distance: number,
): { x: number; y: number; z: number } {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  return {
    x: -Math.sin(az) * Math.cos(el) * distance,
    y: Math.cos(az) * Math.cos(el) * distance,
    z: Math.sin(el) * distance,
  };
}

function coordValue(coords: Map<string, number>, name: string): number | undefined {
  const v = coords.get(name);
  return typeof v === "number" ? v : undefined;
}

// coordinate 名称集合决定极坐标 / 笛卡尔，返回统一的极坐标。
function toPolar(coords: Map<string, number>): {
  az: number;
  el: number;
  d: number;
} {
  if (coords.has("azimuth") || coords.has("elevation")) {
    return {
      az: coordValue(coords, "azimuth") ?? 0,
      el: coordValue(coords, "elevation") ?? 0,
      d: coordValue(coords, "distance") ?? 1.0,
    };
  }
  const X = coordValue(coords, "x") ?? 0;
  const Y = coordValue(coords, "y") ?? 0;
  const Z = coordValue(coords, "z") ?? 0;
  return {
    az: (-Math.atan2(X, Y) * 180) / Math.PI,
    el: (Math.atan2(Z, Math.hypot(X, Y)) * 180) / Math.PI,
    d: Math.hypot(X, Y, Z),
  };
}

// 单个 audioBlockFormat 的摆位：position 坐标 → 极坐标 → 笛卡尔。
// 无 position 元素时返回 null（调用方按“继承上一块”处理）。
function readBlockPosition(block: Element): { x: number; y: number; z: number } | null {
  const coords = new Map<string, number>();
  for (const pos of findAll(block, "position")) {
    const name = attr(pos, "coordinate");
    if (!name) continue; // coordinate 属性必需
    const v = Number(text(pos));
    if (!Number.isFinite(v)) continue;
    coords.set(name.toLowerCase(), v);
  }
  if (coords.size === 0) return null;
  const { az, el, d } = toPolar(coords);
  return polarToCartesian(az, el, d);
}

// rtime "HH:MM:SS(.fffff)" → 毫秒；无法解析返回 NaN。
// ponytail: 不支持 ADM 的采样计数语法（...S<sampleRate>，如 00:00:01S48000）；
// 真实 Dolby master 用 5 位小数的十进制秒，需要时再按采样率换算。
export function parseRtime(s: string): number {
  const m = /^(\d+):(\d+):(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return NaN;
  const fracMs = m[4] ? Math.round(Number("0." + m[4]) * 1000) : 0;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + fracMs;
}

function readGain(block: Element | null): number {
  const g = findFirst(block, "gain");
  if (!g) return 1.0;
  const v = Number(text(g));
  if (!Number.isFinite(v)) return 1.0;
  return (attr(g, "gainUnit") ?? "").toLowerCase() === "db"
    ? Math.pow(10, v / 20)
    : v;
}

// ── 主解析 ──────────────────────────────────────────────

/** chna chunk（EBU Tech 3352）→ audioTrackUID ID → 0 基 WAV 声道号。
 *  布局（小端）：ADMType u16 / numTrackUIDs u16 / numTracks u16 / numProgrammes u16，
 *  每项 98 字节 = trackIndex u16 + UID / trackFormatRef / packFormatRef 各 32 字节定长串。
 *  声明数量与实际大小不符时返回空 Map（调用方回落 trackIndex 属性），绝不抛错。 */
export function parseChnaChunk(
  buffer: ArrayBuffer,
  offset: number,
  size: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (size < 8 || offset + size > buffer.byteLength) return out;
  const dv = new DataView(buffer, offset, size);
  const numTrackUids = dv.getUint16(2, true);
  const numTracks = dv.getUint16(4, true);
  const entrySize = 2 + 32 * 3; // trackIndex + 三个定长 ID 串
  if (8 + numTrackUids * entrySize > size) return out;
  for (let i = 0; i < numTrackUids; i++) {
    const base = 8 + i * entrySize;
    const trackIndex = dv.getUint16(base, true);
    let uid = "";
    for (let k = 0; k < 32; k++) {
      const ch = dv.getUint8(base + 2 + k);
      if (ch === 0) break;
      uid += String.fromCharCode(ch);
    }
    // trackIndex 为 1 基 WAV 声道号；0 或超出 numTracks 的条目视为无效
    if (uid && trackIndex >= 1 && trackIndex <= numTracks) out.set(uid, trackIndex - 1);
  }
  return out;
}

export function parseAdmXml(
  xml: string,
  doc?: Document,
  chnaChannels?: ReadonlyMap<string, number>,
): AdmMetadata {
  const docNode =
    doc ?? new DOMParser().parseFromString(xml, "application/xml");
  const root = docNode.documentElement;
  if (!root || root.localName === "parsererror") {
    throw new Error("adm: XML parse error");
  }

  const afx =
    root.localName === "audioFormatExtended"
      ? root
      : findFirst(root, "audioFormatExtended");
  if (!afx) throw new Error("adm: no audioFormatExtended");

  const packs = new Map<string, Element>();
  for (const p of findAll(afx, "audioPackFormat")) {
    const id = attr(p, "audioPackFormatID");
    if (id) packs.set(id, p);
  }
  const channels = new Map<string, Element>();
  for (const c of findAll(afx, "audioChannelFormat")) {
    const id = attr(c, "audioChannelFormatID");
    if (id) channels.set(id, c);
  }

  const trackUids = new Map<string, Element>();
  for (const t of findAll(afx, "audioTrackUID")) {
    const uid = attr(t, "UID"); // UID 为大写属性名
    if (uid) trackUids.set(uid, t);
  }

  const objects: AdmObject[] = [];
  const idCounts = new Map<string, number>();
  let audioPackFormat: string | undefined;

  for (const obj of findAll(afx, "audioObject")) {
    const id = attr(obj, "audioObjectID") ?? "";
    if (!id) continue;

    const packId = text(findFirst(obj, "audioPackFormatIDRef"));
    let pack: Element | null = null;
    if (packId) {
      pack = packs.get(packId) ?? null;
      if (audioPackFormat === undefined) audioPackFormat = packId;
    }

    // 权威绑定：audioObject → audioTrackUIDRef → audioTrackUID.UID → audioChannelFormatIDRef；
    // 其次对象自身的 ref；最后退回 pack 的第一个 ref（兼容无 trackUID 链的文件）。
    let channelRef = "";
    const uidRef = text(findFirst(obj, "audioTrackUIDRef"));
    if (uidRef) channelRef = text(findFirst(trackUids.get(uidRef) ?? null, "audioChannelFormatIDRef"));
    if (!channelRef) channelRef = text(findFirst(obj, "audioChannelFormatIDRef"));
    if (!channelRef) channelRef = text(findFirst(pack, "audioChannelFormatIDRef"));
    const channel = channelRef ? channels.get(channelRef) ?? null : null;

    // 声音来源声道：chna（权威）→ audioTrackUID@trackIndex → 未知（undefined = 视为始终发声）
    let channelIndex: number | undefined;
    if (uidRef) {
      const viaChna = chnaChannels?.get(uidRef);
      if (viaChna !== undefined) {
        channelIndex = viaChna;
      } else {
        const ti = attr(trackUids.get(uidRef) ?? null, "trackIndex");
        if (ti) {
          const n = Number.parseInt(ti, 10) - 1;
          if (Number.isInteger(n) && n >= 0) channelIndex = n;
        }
      }
    }

    // 类型过滤
    if (
      !isObjectType(
        attr(pack, "typeLabel"),
        attr(pack, "typeDefinition"),
        attr(channel, "typeLabel"),
        attr(channel, "typeDefinition"),
      )
    ) {
      continue;
    }

    // 时间轴：解析该 channel 的全部 audioBlockFormat；无 position 的块继承上一块位置。
    const frames: AdmKeyframe[] = [];
    let px = 0;
    let py = 0;
    let pz = 0;
    let firstBlock: Element | null = null;
    for (const block of channel ? findAll(channel, "audioBlockFormat") : []) {
      if (!firstBlock) firstBlock = block;
      const rt = parseRtime(attr(block, "rtime") ?? "");
      const pos = readBlockPosition(block);
      let x = px;
      let y = py;
      let z = pz;
      if (pos) {
        x = pos.x;
        y = pos.y;
        z = pos.z;
        px = x;
        py = y;
        pz = z;
      }
      frames.push({
        timeMs: Number.isFinite(rt) ? rt : 0,
        x,
        y,
        z,
        jump: text(findFirst(block, "jumpPosition")) === "1",
      });
    }
    frames.sort((a, b) => a.timeMs - b.timeMs);

    // 静态字段取第一关键帧（无关键帧时全 0，与旧行为一致）
    const head = frames[0];
    const fx = head ? head.x : 0;
    const fy = head ? head.y : 0;
    const fz = head ? head.z : 0;
    const az = (-Math.atan2(fx, fy) * 180) / Math.PI;
    const el = (Math.atan2(fz, Math.hypot(fx, fy)) * 180) / Math.PI;
    const d = Math.hypot(fx, fy, fz);

    // 重复 audioObjectID 追加序号，避免 renderer 以 id 为 key 合并成同一节点
    const n = idCounts.get(id) ?? 0;
    idCounts.set(id, n + 1);

    objects.push({
      id: n > 0 ? `${id}#${n + 1}` : id,
      name: attr(obj, "audioObjectName") ?? attr(channel, "audioChannelFormatName") ?? id,
      x: fx,
      y: fy,
      z: fz,
      azimuthDeg: az,
      elevationDeg: el,
      distance: d,
      gain: readGain(firstBlock),
      channelIndex,
      track: frames.length >= 2 ? frames : undefined,
    });
  }

  return { objects, audioPackFormat };
}

export function parseAdmBwf(buffer: ArrayBuffer): AdmMetadata | null {
  try {
    const xml = extractAxmlChunk(buffer);
    if (!xml) return null;
    // chna：声道号 → audioTrackUID 的权威映射；缺失/截断 → undefined，绑定回落 trackIndex 属性
    const walked = walkRiffChunks(buffer);
    const chna = walked?.chunks.find((c) => c.id === "chna");
    const chnaChannels = chna ? parseChnaChunk(buffer, chna.offset, chna.size) : undefined;
    return parseAdmXml(xml, undefined, chnaChannels);
  } catch {
    return null;
  }
}
