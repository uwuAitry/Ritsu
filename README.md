# Ritsu

[English](#english) | [中文说明](#中文说明)

---

<a id="中文说明"></a>

# Ritsu

> 🎵 将歌词渲染为 Apple Music 质感的动态视频，并用 3D 粒子声场透视 Dolby Atmos 的空间声像轨迹。

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![GitHub Pages](https://img.shields.io/badge/Live-GitHub%20Pages-brightgreen)](https://uwuaitry.github.io/Ritsu/)

Ritsu 是一个开箱即用的 Web 视听渲染工作台。它的核心目标是：在浏览器中还原 Apple Music 级别的高质感流体光影，同时为杜比全景声（Dolby Atmos ADM BWF）母带提供真实、灵动的 3D 空间声像透视。

你可以将它用作本地高品质沉浸播放器，也可以直接将带有逐字光效的歌词与 3D 声场动效导出为 1080p@30fps 视频。

---

## 为什么做 Ritsu？

常规的歌词视频工具往往局限于呆板的滚屏字幕；而 Apple Music 的流体弥散背景与逐字卡拉OK动效，代表了当代数字音乐界面的审美标杆。

另一方面，空间音频（Spatial Audio）正在普及，但在播放 ADM BWF 格式的多声道工程文件时，通常只能依赖耳朵感知。**声轨里的各个音频对象（Audio Objects）在三维空间中究竟如何游走、定位与扩散？**

Ritsu 将两者结合：
- **左侧**：细腻呼吸的动态流体封面与单行逐字卡拉OK歌词；
- **右侧**：由底层真实声轨元数据驱动的 3D 空间声像透视系统。

---

## 核心特性

### 1. Apple Music 级视觉系统
- **动态流体弥散**：基于 PixiJS v7 与 `@applemusic-like-lyrics`（AMLL）底层着色器，实时提取专辑封面的色彩光谱与能量，呈现平滑流动的渐变流体与毛玻璃效果。
- **单行聚焦排版**：底栏单行布局，视线聚焦于当前唱句；原生兼容 Apple Music 官方 TTML 逐字时钟、动态字阶微缩与光辉缓动。

### 2. 杜比全景声 3D 粒子声像透视（ADM BWF）
- **原生二进制元数据解析**：前端直接解析 RIFF 容器内的 `axml` 与 `chna` 块（严格遵循 ITU-R BS.2088 规范），实时提取各个音轨对象的空间坐标 `(x, y, z)`、空间扩散度（Spread）与声道发声能量。
- **有机球状粒子云（2800 点）**：摒弃冰冷生硬的立方体房间线框，采用无边界的球状粒子云勾勒声学空间。
- **声场山峰形变**：发声对象化身为穿梭在云雾中的彩色光核。当对象能量爆发时，粒子云表面会根据空间坐标与扩散度实时顶起平缓起伏的山峰形变，并叠加加色 Sprite 辉光。
- **纯函数时间决定论**：场景中所有粒子游走、物理位移与波纹扰动均为 `timeMs` 的纯数学函数，不依赖墙钟累加或帧率计数。**无论在线实时预览还是离线逐帧导出，同一毫秒的画面绝对像素级一致。**

### 3. 多源元数据与歌词补全工作台
- 支持一键或按类别精细补全：
  - **曲目信息与高清封面**：接入 iTunes Search API，提供多版本弹层预览与点选。
  - **多源歌词引擎**：优先匹配 AMLL 逐字歌词（TTML/YRC），自动降级回退至 LRCLIB 行级歌词。
- **尊重用户输入**：手动导入的封面与音频原生 ID3 标签享有最高优先级，自动补全绝不静默覆盖已有内容。

### 4. 双模式视频导出引擎
- **实时录制**：基于 `canvas.captureStream()` 与 Web Audio API 目标流，在浏览器内零转码直接捕获 1080p MP4 视频，所见即所得。
- **离线逐帧渲染**：集成 WebCodecs 与轻量封装库 `mp4-muxer`，按时间切片（$t = i / \text{fps}$）逐帧合成画面与音频，彻底消除客户端掉帧、性能卡顿导致的音画不同步。

---

## 支持格式

| 类别 | 格式说明 |
| :--- | :--- |
| **音频** | 普通双声道（MP3、FLAC、AAC、WAV）<br>多声道 Dolby Atmos ADM BWF（`.wav`，含 RIFF `axml`/`chna` 元数据） |
| **歌词** | TTML（逐字）、LRC（行级）、YRC、QRC、Lyricify 等 |
| **封面** | 音频内嵌标签（ID3、Vorbis Comment 等）、本地图片（JPEG / PNG / WebP）或在线自动检索 |

---

## 技术架构

```
Ritsu
├── UI & 状态调度 (React 18 + TypeScript + Vite)
├── 歌词与流体渲染 (AMLL Core + PixiJS v7 Filter Pipeline)
├── 3D 空间摆位视图 (Three.js + 自研粒子云/山峰变形着色器)
├── ADM 元数据引擎 (前端 RIFF/BWF axml+chna 原生二进制解析)
└── 视频导出管线 (WebCodecs + mp4-muxer / MediaRecorder)
```

- **极简工作流（Zero-Local-Toolchain）**：
  不依赖本地繁重的编译链。所有提交由 GitHub Actions 自动化执行类型自检、契约验证、静态构建与 GitHub Pages 持续交付。

---

## 本地运行

```bash
# 克隆仓库
git clone https://github.com/uwuAitry/Ritsu.git
cd Ritsu

# 安装依赖
npm install

# 启动本地开发服务
npm run dev

# 编译生产包
npm run build
```

---

## 开源许可与致谢

本项目基于 **[AGPL-3.0](LICENSE)** 协议开源。

- 核心歌词动效与流体着色器源自开源项目 **[AMLL (@applemusic-like-lyrics)](https://github.com/amll-dev/applemusic-like-lyrics)**，遵循 AGPL-3.0 协议。感谢 AMLL 社区在音乐视觉领域的设计与沉淀。
- 视频 MP4 容器封装基于轻量库 [mp4-muxer](https://github.com/Vanilagy/mp4-muxer)。
- 空间声学元数据解析参考 ITU-R BS.2088 与 EBU-ADMBWF 规范。

---

<a id="english"></a>

# Ritsu (English)

> 🎵 Render lyrics into Apple Music-style visualizer videos, with a live 3D particle soundstage projecting Dolby Atmos (ADM BWF) spatial trajectories.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![GitHub Pages](https://img.shields.io/badge/Live-GitHub%20Pages-brightgreen)](https://uwuaitry.github.io/Ritsu/)

Ritsu is an in-browser audio-visual rendering workstation. It was built with a clear intention: bring Apple Music's fluid visual aesthetics and Dolby Atmos's invisible spatial trajectories into a coherent, responsive 3D visualization.

Use it as an ambient, immersive web player, or export clean 1080p@30fps videos complete with syllable-by-syllable lyric illumination and audio-reactive soundstage motion.

---

## Why Ritsu?

Most lyric video tools settle for static scrolling subtitles. Meanwhile, Apple Music's fluid color mesh and syllable-timed transitions represent a high-water mark for contemporary music interfaces.

At the same time, Spatial Audio has become an industry standard. Yet when playing Dolby Atmos ADM BWF master files, listeners can only imagine where objects are moving across the room. **Where are the individual stems drifting, panning, and radiating in 3D space?**

Ritsu bridges this gap:
- **Left**: dynamic fluid album art with focused single-line, syllable-synced karaoke lyrics.
- **Right**: a live Three.js 3D spatial positioning viewport driven by authentic ADM stem metadata.

---

## Key Highlights

### 1. Apple Music Visual Aesthetic
- **Fluid Diffuse Canvas**: Powered by PixiJS v7 and `@applemusic-like-lyrics` (AMLL) shaders, dynamically extracting dominant palettes and energy from the cover art to generate soft chromatic drift and frosted-glass blurs.
- **Focused Single-Line Typography**: A bottom-docked single-line layout that keeps visual attention on the current vocal passage. Full compatibility with Apple Music's TTML word-by-word timing, subtle scaling, and glow easing.

### 2. 3D Dolby Atmos Soundstage (ADM BWF)
- **Binary-Level ADM Parser**: Parses `axml` and `chna` chunks directly in the browser (strictly compliant with ITU-R BS.2088), extracting instantaneous 3D object coordinates `(x, y, z)`, spread coefficients, and active channel loudness.
- **2800-Point Organic Particle Cloud**: Replaces rigid wireframe "room boxes" with a continuous, responsive spherical particle cloud.
- **Acoustic Mountain Peaks**: Audio objects navigate the cloud as glowing energy cores. As channel loudness surges, the particle cloud deforms upward into smooth mountain peaks with additive sprite glows.
- **Strictly Deterministic Time Functions**: Particle drift and peak displacements are pure mathematical functions of `timeMs`—never relying on wall-clock drift or framerate accumulators. **Every millisecond matches byte-for-byte whether in real-time preview or offline frame-by-frame export.**

### 3. Smart Metadata & Lyric Workbench
- Convenient single-click or fine-grained metadata autofill:
  - **Track Details & High-Res Covers**: Search via the iTunes API with multi-candidate modal previews.
  - **Multi-Tier Lyric Sourcing**: Prefers AMLL syllable-synced lyrics (TTML/YRC), gracefully falling back to LRCLIB line-synced lyrics.
  - **User-Input Protection**: Manually uploaded artwork or audio tags are never silently overridden.

### 4. Dual-Pipeline Video Exporter
- **Real-Time Capture**: Direct 1080p recording via `canvas.captureStream()` and Web Audio API destination nodes—zero transcoding wait time.
- **Offline Frame-by-Frame Rendering**: Driven by WebCodecs and `mp4-muxer`. Renders time-sliced frames ($t = i / \text{fps}$) independent of hardware load, eliminating dropped frames or audio desynchronization.

---

## Supported Formats

| Category | Formats |
| :--- | :--- |
| **Audio** | Standard Stereo (MP3, FLAC, AAC, WAV)<br>Dolby Atmos ADM BWF (`.wav` containing RIFF `axml`/`chna` metadata) |
| **Lyrics** | TTML (syllable-level), LRC (line-level), YRC, QRC, Lyricify |
| **Artwork** | Embedded audio tags (ID3, Vorbis Comments), local images (JPEG / PNG / WebP), or online fetch |

---

## Technical Stack

```
Ritsu
├── UI & Orchestration (React 18 + TypeScript + Vite)
├── Lyric & Fluid Shaders (AMLL Core + PixiJS v7 Filter Pipeline)
├── 3D Spatial Soundstage (Three.js + Custom Particle/Deformation Shaders)
├── ADM Metadata Engine (Zero-dependency binary parser for RIFF axml/chna)
└── Video Pipeline (WebCodecs + mp4-muxer / MediaRecorder)
```

- **Cloud-First Philosophy**: No heavy toolchains required locally. Every push triggers GitHub Actions for contract self-checks, builds, and direct GitHub Pages deployment.

---

## Getting Started

```bash
# Clone the repository
git clone https://github.com/uwuAitry/Ritsu.git
cd Ritsu

# Install dependencies
npm install

# Start local development server
npm run dev

# Build production bundle
npm run build
```

---

## License & Acknowledgements

This project is licensed under **[AGPL-3.0](LICENSE)**.

- Lyric presentation and fluid background shaders are built on top of **[AMLL (@applemusic-like-lyrics)](https://github.com/amll-dev/applemusic-like-lyrics)** under the AGPL-3.0 license. Special thanks to the AMLL community for their craft and dedication.
- Video container multiplexing utilizes [mp4-muxer](https://github.com/Vanilagy/mp4-muxer).
- Spatial metadata mapping references ITU-R BS.2088 and EBU-ADMBWF specifications.
