// ADM BWF 解析：BW64/RF64/RIFF 容器 → axml chunk → audioObject 摆位
// 仅依赖 ../types，无外部依赖。

import type { AdmMetadata, AdmObject } from "../types";

// ── 容器层 ──────────────────────────────────────────────

interface ChunkInfo {
  id: string;
  dataOffset: number;
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
function readChunks(buffer: ArrayBuffer): ChunkInfo[] {
  if (buffer.byteLength < 12) throw new Error("adm: buffer too small");
  const dv = new DataView(buffer);
  const topId = fourcc(dv, 0);
  if (topId !== "RIFF" && topId !== "RF64" && topId !== "BW64") {
    throw new Error("adm: not RIFF/RF64/BW64");
  }
  if (fourcc(dv, 8) !== "WAVE") throw new Error("adm: not WAVE");

  const overrides = new Map<string, number>();
  let dataSizeOverride = -1;
  const chunks: ChunkInfo[] = [];

  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const id = fourcc(dv, offset);
    if (!CHUNK_ID_RE.test(id)) throw new Error("adm: bad chunk id");

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

    chunks.push({ id, dataOffset: offset + 8, size });
    // 2 字节对齐：size 为奇数时跳过 1 个 pad 字节（不计入 size）。
    offset = offset + 8 + size + (size & 1);
  }
  return chunks;
}

export function extractAxmlChunk(buffer: ArrayBuffer): string | null {
  try {
    const axml = readChunks(buffer).find((c) => c.id === "axml");
    if (!axml) return null;
    const end = Math.min(axml.dataOffset + axml.size, buffer.byteLength);
    const len = Math.max(0, end - axml.dataOffset);
    const bytes = new Uint8Array(buffer, axml.dataOffset, len);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }
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

export function parseAdmXml(xml: string, doc?: Document): AdmMetadata {
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

  const objects: AdmObject[] = [];
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

    let channelRef = text(findFirst(pack, "audioChannelFormatIDRef"));
    if (!channelRef) channelRef = text(findFirst(obj, "audioChannelFormatIDRef"));
    const channel = channelRef ? channels.get(channelRef) ?? null : null;

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

    // ponytail: 只取第一个 audioBlockFormat，块间插值暂不实现（v1 摆位为静态点）。
    const block = findFirst(channel, "audioBlockFormat");

    const coords = new Map<string, number>();
    for (const pos of block ? findAll(block, "position") : []) {
      const name = attr(pos, "coordinate");
      if (!name) continue; // coordinate 属性必需
      const v = Number(text(pos));
      if (!Number.isFinite(v)) continue;
      coords.set(name.toLowerCase(), v);
    }

    const { az, el, d } = toPolar(coords);
    const cart = polarToCartesian(az, el, d);

    objects.push({
      id,
      name: attr(obj, "audioObjectName") ?? attr(channel, "audioChannelFormatName") ?? id,
      x: cart.x,
      y: cart.y,
      z: cart.z,
      azimuthDeg: az,
      elevationDeg: el,
      distance: d,
      gain: readGain(block),
    });
  }

  return { objects, audioPackFormat };
}

export function parseAdmBwf(buffer: ArrayBuffer): AdmMetadata | null {
  try {
    const xml = extractAxmlChunk(buffer);
    if (!xml) return null;
    return parseAdmXml(xml);
  } catch {
    return null;
  }
}
