// ADM 解析最小自检：无测试框架，assert 抛错即失败。
// 运行方式（浏览器控制台 / Node>=18）：
//   import { runSelfCheck } from "./src/adm/selfcheck"; runSelfCheck();

import {
  extractAxmlChunk,
  isAdmBwf,
  parseAdmBwf,
  parseAdmXml,
  parseRtime,
  polarToCartesian,
} from "./parse";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("adm selfcheck failed: " + msg);
}

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

// 合成 BW64：header + ds64(dataSize=0) + data(头部 0xFFFFFFFF) + axml
// data 放在 axml 前，确保只有正确套用 ds64 覆盖表才能走到 axml。
function buildBw64(xml: string): ArrayBuffer {
  const axml = new TextEncoder().encode(xml);
  const pad = axml.length & 1;
  const bytes: number[] = [];
  const putStr = (s: string): void => {
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
  };
  const putU32 = (v: number): void => {
    bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  };
  const putU64 = (v: number): void => {
    putU32(v >>> 0);
    putU32(Math.floor(v / 4294967296));
  };

  putStr("BW64");
  putU32(0); // riffSize，随后回填
  putStr("WAVE");

  // ds64: riffSize / dataSize(=0) / sampleCount / tableLength=0
  putStr("ds64");
  putU32(28);
  putU64(0);
  putU64(0);
  putU64(0);
  putU32(0);

  // data：头部 0xFFFFFFFF，真实大小来自 ds64（0）
  putStr("data");
  putU32(0xffffffff);

  putStr("axml");
  putU32(axml.length);
  for (let i = 0; i < axml.length; i++) bytes.push(axml[i]);
  if (pad) bytes.push(0);

  const riffSize = bytes.length - 8;
  bytes[4] = riffSize & 0xff;
  bytes[5] = (riffSize >>> 8) & 0xff;
  bytes[6] = (riffSize >>> 16) & 0xff;
  bytes[7] = (riffSize >>> 24) & 0xff;

  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ebuCoreMain xmlns="urn:ebu:metadata-schema:ebuCore_2017">
  <audioFormatExtended>
    <audioObject audioObjectID="AO_1001" audioObjectName="Obj A">
      <audioPackFormatIDRef>AP_00031001</audioPackFormatIDRef>
    </audioObject>
    <audioObject audioObjectID="AO_1002" audioObjectName="Obj B">
      <audioPackFormatIDRef>AP_00031002</audioPackFormatIDRef>
    </audioObject>
    <audioPackFormat audioPackFormatID="AP_00031001" typeLabel="0003">
      <audioChannelFormatIDRef>AC_00031001</audioChannelFormatIDRef>
    </audioPackFormat>
    <audioPackFormat audioPackFormatID="AP_00031002" typeLabel="0003">
      <audioChannelFormatIDRef>AC_00031002</audioChannelFormatIDRef>
    </audioPackFormat>
    <audioChannelFormat audioChannelFormatID="AC_00031001" typeDefinition="Objects">
      <audioBlockFormat audioBlockFormatID="AB_00031001">
        <position coordinate="azimuth">-30</position>
        <position coordinate="elevation">0</position>
      </audioBlockFormat>
    </audioChannelFormat>
    <audioChannelFormat audioChannelFormatID="AC_00031002" typeDefinition="Objects">
      <audioBlockFormat audioBlockFormatID="AB_00031002">
        <position coordinate="azimuth">90</position>
      </audioBlockFormat>
    </audioChannelFormat>
  </audioFormatExtended>
</ebuCoreMain>`;

// 权威绑定 + 时间轴用例：
// - AO_1001 / AO_1002 共享同一 pack（其首 channel 均为 AC_00031001），
//   但各自 audioTrackUIDRef 指向不同 channel → 必须解析出不同位置。
// - AO_1003 的 channel 有两块，第二块（文档序）rtime 更早且为笛卡尔 1,1,1；
//   第一块带 jumpPosition=1。
const TIMELINE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ebuCoreMain xmlns="urn:ebu:metadata-schema:ebuCore_2017">
  <audioFormatExtended>
    <audioObject audioObjectID="AO_1001" audioObjectName="Shared A">
      <audioPackFormatIDRef>AP_00031001</audioPackFormatIDRef>
      <audioTrackUIDRef>ATU_00000001</audioTrackUIDRef>
    </audioObject>
    <audioObject audioObjectID="AO_1002" audioObjectName="Shared B">
      <audioPackFormatIDRef>AP_00031001</audioPackFormatIDRef>
      <audioTrackUIDRef>ATU_00000002</audioTrackUIDRef>
    </audioObject>
    <audioObject audioObjectID="AO_1003" audioObjectName="Mover">
      <audioPackFormatIDRef>AP_00032001</audioPackFormatIDRef>
    </audioObject>
    <audioPackFormat audioPackFormatID="AP_00031001" typeLabel="0003">
      <audioChannelFormatIDRef>AC_00031001</audioChannelFormatIDRef>
    </audioPackFormat>
    <audioPackFormat audioPackFormatID="AP_00032001" typeLabel="0003">
      <audioChannelFormatIDRef>AC_00032001</audioChannelFormatIDRef>
    </audioPackFormat>
    <audioChannelFormat audioChannelFormatID="AC_00031001" typeDefinition="Objects">
      <audioBlockFormat audioBlockFormatID="AB_00031001">
        <position coordinate="azimuth">-30</position>
      </audioBlockFormat>
    </audioChannelFormat>
    <audioChannelFormat audioChannelFormatID="AC_00031002" typeDefinition="Objects">
      <audioBlockFormat audioBlockFormatID="AB_00031002">
        <position coordinate="azimuth">90</position>
      </audioBlockFormat>
    </audioChannelFormat>
    <audioChannelFormat audioChannelFormatID="AC_00032001" typeDefinition="Objects">
      <audioBlockFormat audioBlockFormatID="AB_00032001" rtime="00:00:01.00000">
        <jumpPosition>1</jumpPosition>
        <position coordinate="azimuth">-90</position>
      </audioBlockFormat>
      <audioBlockFormat audioBlockFormatID="AB_00032002" rtime="00:00:00.00000">
        <position coordinate="X">1</position>
        <position coordinate="Y">1</position>
        <position coordinate="Z">1</position>
      </audioBlockFormat>
    </audioChannelFormat>
    <audioTrackUID UID="ATU_00000001">
      <audioChannelFormatIDRef>AC_00031001</audioChannelFormatIDRef>
    </audioTrackUID>
    <audioTrackUID UID="ATU_00000002">
      <audioChannelFormatIDRef>AC_00031002</audioChannelFormatIDRef>
    </audioTrackUID>
  </audioFormatExtended>
</ebuCoreMain>`;

// 重复 audioObjectID：必须追加序号，避免 renderer 以 id 为 key 合并节点
const DUP_ID_XML = `<?xml version="1.0" encoding="UTF-8"?>
<audioFormatExtended>
  <audioObject audioObjectID="AO_1001" audioObjectName="Dup 1">
    <audioPackFormatIDRef>AP_00031001</audioPackFormatIDRef>
  </audioObject>
  <audioObject audioObjectID="AO_1001" audioObjectName="Dup 2">
    <audioPackFormatIDRef>AP_00031001</audioPackFormatIDRef>
  </audioObject>
  <audioPackFormat audioPackFormatID="AP_00031001" typeLabel="0003">
    <audioChannelFormatIDRef>AC_00031001</audioChannelFormatIDRef>
  </audioPackFormat>
  <audioChannelFormat audioChannelFormatID="AC_00031001" typeDefinition="Objects">
    <audioBlockFormat audioBlockFormatID="AB_00031001">
      <position coordinate="azimuth">0</position>
    </audioBlockFormat>
  </audioChannelFormat>
</audioFormatExtended>`;

export function runSelfCheck(): void {
  const buffer = buildBw64(SAMPLE_XML);

  // rtime：十进制秒 → 毫秒；采样计数语法不支持（返回 NaN）
  assert(parseRtime("00:00:01.00000") === 1000, "parseRtime 1s");
  assert(parseRtime("01:02:03") === 3723000, "parseRtime 1h2m3s");
  assert(parseRtime("00:00:00.5") === 500, "parseRtime 0.5s");
  assert(Number.isNaN(parseRtime("00:00:01S48000")), "sample-based rtime must be NaN");
  // 容器：chunk 遍历 + ds64 覆盖 + UTF-8 解码
  const xml = extractAxmlChunk(buffer);
  assert(xml !== null, "axml chunk not found (ds64 override broken?)");
  assert(xml!.includes("audioFormatExtended"), "axml content mismatch");
  assert(isAdmBwf(buffer), "isAdmBwf should be true");

  // 极坐标 → 笛卡尔（0=front, 正 azimuth=LEFT）
  const front = polarToCartesian(0, 0, 1);
  assert(
    approx(front.x, 0) && approx(front.y, 1) && approx(front.z, 0),
    `polarToCartesian(0,0,1)=${JSON.stringify(front)}`,
  );
  const left = polarToCartesian(90, 0, 1);
  assert(
    approx(left.x, -1) && approx(left.y, 0) && approx(left.z, 0),
    `polarToCartesian(90,0,1)=${JSON.stringify(left)}`,
  );

  // XML 解析仅在存在 DOMParser 时验证（Node 裸环境跳过）
  if (typeof DOMParser !== "undefined") {
    const meta = parseAdmBwf(buffer);
    assert(meta !== null, "parseAdmBwf returned null");
    assert(meta!.objects.length === 2, `expected 2 objects, got ${meta!.objects.length}`);
    assert(approx(meta!.objects[0].azimuthDeg, -30), "object[0] azimuth");
    assert(approx(meta!.objects[0].x, 0.5, 1e-6), "object[0] x");
    assert(approx(meta!.objects[1].azimuthDeg, 90), "object[1] azimuth");
    assert(approx(meta!.objects[1].x, -1), "object[1] x");
    assert(meta!.audioPackFormat === "AP_00031001", "audioPackFormat");

    // 权威绑定：共享 pack 的两个对象经 UID 解析到不同 channel → 不同位置
    const tl = parseAdmXml(TIMELINE_XML);
    assert(tl.objects.length === 3, `timeline: expected 3 objects, got ${tl.objects.length}`);
    assert(tl.objects[0].id === "AO_1001" && tl.objects[1].id === "AO_1002", "timeline ids");
    assert(approx(tl.objects[0].x, 0.5), "uid-bound A x");
    assert(approx(tl.objects[1].x, -1), "uid-bound B x");
    assert(!approx(tl.objects[0].x, tl.objects[1].x), "shared-pack objects must differ");

    // 单块 channel 不挂 track（静态路径零分配）
    assert(tl.objects[0].track === undefined, "single block must have no track");

    // 多块 channel：按 timeMs 升序，rtime 正确
    const mover = tl.objects[2];
    assert(mover.track !== undefined && mover.track!.length === 2, "mover track length");
    assert(mover.track![0].timeMs === 0, "track[0] timeMs");
    assert(mover.track![1].timeMs === 1000, "track[1] timeMs");

    // 笛卡尔 coordinate X/Y/Z = 1,1,1 → x=y=z=1, distance=√3
    assert(
      approx(mover.x, 1) && approx(mover.y, 1) && approx(mover.z, 1),
      `cartesian roundtrip xyz=${mover.x},${mover.y},${mover.z}`,
    );
    assert(approx(mover.distance, Math.sqrt(3)), `cartesian distance=${mover.distance}`);

    // jumpPosition=1 记录在对应关键帧
    assert(mover.track![1].jump === true, "jumpPosition flag");
    assert(mover.track![0].jump === false, "non-jump flag");

    // 重复 audioObjectID 追加序号
    const dup = parseAdmXml(DUP_ID_XML);
    assert(dup.objects.length === 2, `dup: expected 2 objects, got ${dup.objects.length}`);
    assert(dup.objects[0].id === "AO_1001" && dup.objects[1].id === "AO_1001#2", "dup id suffix");
  }
}
