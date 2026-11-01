// 自动补全模块的自检：只测纯逻辑（归一化、候选挑选、索引行解析），不碰网络。
// 放在 CommonJS 下也能跑 —— 本模块不 import AMLL。
import { matchKey, parseAmllLine, pickItunesTrack, decodeQqBase64, scoreQqSong } from "./sources";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`autofill self-check failed: ${msg}`);
}

export function runSelfCheck(): void {
  // 归一化：大小写、空格、标点全部抹平，CJK 保留
  assert(matchKey("Shape of You") === matchKey("shapeofyou"), "matchKey 应忽略大小写与空格");
  assert(matchKey("夜に駆ける") === "夜に駆ける", "matchKey 应保留 CJK");
  assert(matchKey("Adele - Hello!") === "adelehello", "matchKey 应去掉标点");
  assert(matchKey("") === "", "matchKey 空输入应为空");

  // iTunes 候选：标题完全相同 + 歌手相同的胜出
  const tracks = [
    { trackName: "Hello", artistName: "Adele", collectionName: "25", trackTimeMillis: 295502 },
    { trackName: "Hello", artistName: "Lionel Richie", collectionName: "Can't Slow Down" },
    { trackName: "Hello Goodbye", artistName: "The Beatles" },
    { trackName: "Faded", artistName: "Alan Walker" },
  ];
  const picked = pickItunesTrack(tracks, "hello", "adele");
  assert(picked?.artistName === "Adele", "应挑中标题与歌手都吻合的候选");
  // 歌手对不上时仍选标题吻合的那个，而不是干脆不填
  const titleOnly = pickItunesTrack(tracks, "Hello", "Someone Else");
  assert(titleOnly?.trackName === "Hello", "歌手不吻合时应回退到标题吻合的候选");
  // 标题完全对不上就返回 null，宁可不填也不填错
  assert(pickItunesTrack(tracks, "Bohemian Rhapsody", "Queen") === null, "无标题吻合时应返回 null");
  assert(pickItunesTrack(tracks, "", "Adele") === null, "空标题应返回 null");
  assert(pickItunesTrack([], "Hello", "Adele") === null, "空候选应返回 null");

  // AMLL 索引行：metadata 是 [键, 字符串数组] 对的数组
  const line = JSON.stringify({
    metadata: [
      ["musicName", ["Idol"]],
      ["artists", ["YOASOBI"]],
      ["album", ["Idol"]],
    ],
    rawLyricFile: "1700000000000-1-999.ttml",
  });
  const entry = parseAmllLine(line);
  assert(entry?.musicName === "Idol", "应解析出 musicName");
  assert(entry?.artists[0] === "YOASOBI", "应解析出 artists");
  assert(entry?.file === "1700000000000-1-999.ttml", "应解析出 rawLyricFile");
  // 多歌手用一个字段里带分隔符的写法，展开成多个名字
  const multi = parseAmllLine(
    JSON.stringify({
      metadata: [
        ["musicName", ["Stay"]],
        ["artists", ["The Kid LAROI & Justin Bieber"]],
      ],
      rawLyricFile: "x.ttml",
    }),
  );
  assert(multi?.artists.length === 2, "多歌手应拆成多个");
  // 坏输入一律 null，不抛
  assert(parseAmllLine("not json") === null, "非法 JSON 应返回 null");
  assert(parseAmllLine("{}") === null, "缺 rawLyricFile 应返回 null");
  assert(parseAmllLine('{"rawLyricFile":"a.ttml"}') === null, "缺 metadata 应返回 null");
  // QQ 歌词：base64(UTF-8) 解码，含空白的 base64 也要能解
  assert(decodeQqBase64("5L2g5aW9") === "你好", "decodeQqBase64 应还原 UTF-8 中文");
  assert(decodeQqBase64("5L2g\n5aW9") === "你好", "decodeQqBase64 应忽略空白");

  // QQ 候选打分：标题 + 歌手都命中 > 只命中其一 > 都不命中
  const exact = scoreQqSong({ songname: "Hello", singer: [{ name: "Adele" }] }, "hello", "adele");
  const worse = scoreQqSong({ songname: "Hello", singer: [{ name: "Adele" }] }, "hello", "someone");
  const none = scoreQqSong({ songname: "Faded", singer: [{ name: "Alan Walker" }] }, "hello", "adele");
  assert(exact > worse && worse > none, "scoreQqSong 应随匹配度递减");
  assert(none === 0, "完全不符应得 0 分");
}
