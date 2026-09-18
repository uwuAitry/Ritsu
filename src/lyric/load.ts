// 歌词加载：格式探测 + 解析分发。
// 解析全部交给 @applemusic-like-lyrics/lyric，输出与其 LyricLine 结构一致，
// 可直接赋给 @applemusic-like-lyrics/core 的 LyricLine（无需转换）。
import {
  parseEslrc,
  parseLqe,
  parseLrc,
  parseLrcA2,
  parseLyl,
  parseLys,
  parseQrc,
  parseTTML,
  parseYrc,
} from "@applemusic-like-lyrics/lyric";
import type { LyricLine } from "@applemusic-like-lyrics/core";

export type LyricFormat =
  | "lrc"
  | "lrca2"
  | "eslrc"
  | "yrc"
  | "qrc"
  | "lys"
  | "lyl"
  | "lqe"
  | "ttml";

// 扩展名 → 格式（xml 视作 ttml）
const EXT_FORMAT: Record<string, LyricFormat> = {
  lrc: "lrc",
  yrc: "yrc",
  qrc: "qrc",
  lys: "lys",
  lyl: "lyl",
  lqe: "lqe",
  eslrc: "eslrc",
  ttml: "ttml",
  xml: "ttml",
};

const RE_BRACKET_COMMA = /\[\d+,\d+\]/; // [start,dur] 行时间戳（无冒号）
const RE_WORD_PAREN_END = /\(\d+,\d+\)\s*$/m; // 词组以 (start,end) 结尾 → YRC
const RE_LRC_STAMP = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/; // [mm:ss.xx]
const RE_ESLRC_WORD = /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/; // <mm:ss.xx> 内联词时间

export function detectLyricFormat(text: string, fileName?: string): LyricFormat {
  const ext = fileName?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext && EXT_FORMAT[ext]) return EXT_FORMAT[ext];

  const t = text.trim();
  // ponytail: 纯文本启发式，遇到伪装内容（歌词里恰好含 <tt 等）会误判；
  // 后续可让用户显式选择格式覆盖。
  if (t.startsWith("<?xml") || t.includes("<tt")) return "ttml";
  if (RE_BRACKET_COMMA.test(t)) return RE_WORD_PAREN_END.test(t) ? "yrc" : "qrc";
  if (RE_LRC_STAMP.test(t)) return RE_ESLRC_WORD.test(t) ? "eslrc" : "lrc";
  return "lrc";
}

const PARSERS: Record<LyricFormat, (text: string) => LyricLine[]> = {
  lrc: parseLrc,
  lrca2: parseLrcA2,
  eslrc: parseEslrc,
  yrc: parseYrc,
  qrc: parseQrc,
  lys: parseLys,
  lyl: parseLyl,
  lqe: parseLqe,
  ttml: (text) => parseTTML(text).lines,
};

export function parseLyricsText(text: string, format?: LyricFormat): LyricLine[] {
  if (!text.trim()) return [];
  const fmt = format ?? detectLyricFormat(text);
  try {
    return PARSERS[fmt](text);
  } catch {
    // 解析器抛错时兜底按 LRC 再试一次（空歌词/非歌词文本会走到这里）
    try {
      return parseLrc(text);
    } catch {
      return [];
    }
  }
}

export async function loadLyricFile(file: File): Promise<LyricLine[]> {
  const text = await file.text();
  return parseLyricsText(text, detectLyricFormat(text, file.name));
}
