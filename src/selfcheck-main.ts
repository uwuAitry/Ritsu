// CI 自检入口：由 tsconfig.selfcheck.json 编译为 CommonJS，Node 直接运行。
// 各模块都导出同名 runSelfCheck，必须取别名。
import { runSelfCheck as checkAudio } from "./audio/selfcheck";
import { runSelfCheck as checkAdm } from "./adm/selfcheck";
import { runSelfCheck as checkLyricLayout } from "./render/selfcheck";
import { runSelfCheck as checkAtmos } from "./atmos/selfcheck";

// ponytail: lyric/load 的格式探测自检不在此运行。它经 ./lyric/load 顶层 import
// @applemusic-like-lyrics/lyric（ESM-only 包），Node 20 的 CommonJS require()
// 会抛 ERR_REQUIRE_ESM；改走 ESM 又要求给现有相对导入补 .js 后缀（不允许改
// 这些源码）。该探测逻辑简单且已被 tsc 类型检查覆盖。
// render/selfcheck 只依赖 render/lyric，后者对 AMLL 的引用是 import type（编译后擦除），
// 无运行时依赖，故可安全在 Node 下运行。

checkAudio();
console.log("selfcheck: audio ok");
checkAdm();
console.log("selfcheck: adm ok");
checkLyricLayout();
console.log("selfcheck: lyric-layout ok");
// atmos/selfcheck 只依赖 adm/parse 的 chunk 解析与 activity 纯逻辑，Node 安全。
checkAtmos();
console.log("selfcheck: atmos ok");
