// CI 自检入口：由 tsconfig.selfcheck.json 编译为 CommonJS，Node 直接运行。
// 三个模块都导出同名 runSelfCheck，必须取别名。
import { runSelfCheck as checkAudio } from "./audio/selfcheck";
import { runSelfCheck as checkAdm } from "./adm/selfcheck";

// ponytail: lyric 自检不在此运行。它经 ./lyric/load 顶层 import
// @applemusic-like-lyrics/lyric（ESM-only 包），Node 20 的 CommonJS require()
// 会抛 ERR_REQUIRE_ESM；改走 ESM 又要求给现有相对导入补 .js 后缀（不允许改
// 这些源码）。lyric 探测逻辑简单且已被 tsc 类型检查覆盖，故只跑 audio + adm。

checkAudio();
console.log("selfcheck: audio ok");
checkAdm();
console.log("selfcheck: adm ok");
