# Ritsu

把歌词渲染成 Apple Music 风格视频的网页应用。在线预览 + 导出视频，支持普通立体声音频与 **Dolby Atmos ADM BWF** 的空间摆位可视化。

## 特性

- 还原 Apple Music 视觉：高斯模糊 + 动态流体背景
- 单行歌词左下角滚动（非多行滚动）
- 主体左侧：方形圆角封面
- 主体右侧：Dolby Atmos ADM BWF 空间摆位渲染透视图（Three.js）
- Dolby Atmos 徽标（封面下方 + 歌曲/歌手双行信息 + 进度条下）
- 导出视频：1080p@30fps，实时录制
- 双模式输入：普通立体声（mp3/flac/aac）+ ADM BWF（.wav）

## 技术栈

React 18 · TypeScript · Vite · [AMLL 组件库](https://github.com/amll-dev/applemusic-like-lyrics)（`@applemusic-like-lyrics/*`）· PixiJS v7 · Three.js · Web Audio API

## 构建（纯云端）

本项目**不在本地安装开发环境**，构建与部署全部由 GitHub Actions 完成：

```bash
npm install
npm run build   # 产物输出到 dist/
```

- 构建产物：GitHub Actions artifact（`ritsu-dist`）+ 自动部署到 GitHub Pages。

## 许可

[AGPL-3.0](LICENSE)。本项目依赖的 [AMLL](https://github.com/amll-dev/applemusic-like-lyrics) 同为 AGPL-3.0，受其 copyleft 约束，特此声明。

## 开发规范

见 [AGENTS.md](AGENTS.md)。
