# AGENTS.md — Ritsu 开发边界

> 本文件规范 Ritsu 项目的开发边界，所有在此仓库工作的 agent 必须遵守。

## 项目定位

Ritsu：把歌词渲染成 Apple Music 风格视频的网页应用。**在线预览 + 导出视频**，支持普通立体声音频与 Dolby Atmos ADM BWF 空间摆位可视化。

## 技术栈（锁定，勿擅自替换）

- 运行时：React 18 + TypeScript + Vite 5
- 歌词 / 背景：`@applemusic-like-lyrics/{core,react,lyric}`（底层 PixiJS **v7** 渲染）
- 3D 摆位：Three.js
- 音频：Web Audio API
- 导出：实时走 MediaRecorder / `canvas.captureStream()`（原生）；离线走 WebCodecs（H.264 + AAC）逐帧编码
- MP4 封装：`mp4-muxer`（MIT、~15KB、零依赖）。理由：WebCodecs 只产裸编码块，浏览器无原生 MP4 封装 API，MediaRecorder 时间戳走墙钟无法离线。`ponytail:` 官方已转向继任者 Mediabunny，需要更强封装能力时再迁移
- 许可：**AGPL-3.0**（AMLL 为强 copyleft，本项目保持 AGPL-3.0 兼容）

## 目录结构

```
src/
  main.tsx          入口
  App.tsx           应用外壳 / 状态编排
  styles.css        全局样式
  types.ts          共享类型契约
  adm/              ADM BWF 解析（axml chunk → 对象摆位）
  audio/            音频解码 + downmix + 播放引擎
  lyric/            歌词加载 + AMLL LyricLine 转换
  render/           视觉场景（封面 / 歌词 / 流体背景 / 徽标 / 进度）
  atmos/            Three.js 空间摆位透视图
  export/           视频导出（实时录制 + 离线逐帧）
.github/workflows/  CI（构建 + 产物 + 部署）
```

## 纯云端工作流（硬约束）

- 代码托管 GitHub；**构建、产物、部署全部由 GitHub Actions 完成**。
- **禁止假设本地有 Node / npm / pnpm**；不要在本地跑 `npm install` / `pnpm install` / 构建命令。
- 一切构建验证走 CI：`npm install && npm run build`。CI 绿灯是唯一可信的验证。

## 许可与引用合规

- 项目整体 AGPL-3.0；仓库根目录保留 `LICENSE`。
- 引用 AMLL 组件库：在 README / 界面显著位置保留其版权与许可证声明（已在 README 声明）。

## v1（MVP）范围

- [ ] 在线预览 + 导出视频（1080p@30fps，实时录制，MP4 优先）
- [ ] 单行歌词左下角滚动（自定义布局，非 AMLL 默认多行）
- [ ] 高斯模糊 + 动态流体背景
- [ ] 左侧方形圆角封面
- [ ] 右侧 Dolby Atmos ADM BWF 空间摆位透视图（Three.js）
- [ ] Dolby Atmos 徽标（封面下 + 歌曲/歌手双行 + 进度条下）
- [ ] 双模式输入：普通立体声 + ADM BWF
- [ ] 歌词格式：LRC / YRC / QRC / Lyricify（`@applemusic-like-lyrics/lyric` 实测含 TTML）
- [ ] 封面：内嵌标签优先，手动上传兜底
- [ ] 离线逐帧渲染导出（自定义分辨率 / 帧率，WebCodecs + mp4-muxer）

## 后续愿景（v1 不做，避免提前实现）

- 真正 binaural / 对象式 Atmos 渲染（WASM）
- i18n 文案切换

## 工程约束（ponytail）

- 不引入无谓抽象、单实现接口、未来脚手架。
- **新增依赖需说明理由**；能原生 / stdlib 解决的不用库。
- 删除优先于新增；最短可工作 diff 优先。
- 非平凡逻辑（分支 / 循环 / 解析 / 涉及钱与安全）必须留一个最小可运行检查（`assert` demo 或单测），不做框架化测试。
- 简化处用 `ponytail:` 注释标注已知上限与升级路径。

## 渲染 / 导出边界

- 实时导出：**播放时长 = 导出时长**；导出走 `canvas.captureStream()` 抓画面 + Web Audio destination stream 抓声音。
- MediaRecorder 优先 MP4(H.264)；浏览器不支持时降级 WebM(VP9)。
- 空间摆位图只读 ADM 元数据，**不触碰音频解码**；音频实际播放简单 downmix（`ponytail:` 标记，后续可升级均衡 downmix）。
- 离线导出：逐帧渲染（t = i/fps）+ WebCodecs 编码 + mp4-muxer 封装 MP4，**导出耗时不再等于播放时长**；非 16:9 的目标分辨率等比缩放居中留黑边，不拉伸；无 WebCodecs 的浏览器回退实时录制。
