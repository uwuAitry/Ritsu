import { useState } from "react";
import { LyricPlayer } from "@applemusic-like-lyrics/react";
import "@applemusic-like-lyrics/core/style.css";

export default function App() {
  // 构建基线冒烟测试：验证 AMLL + Pixi 依赖链在 CI 中可解析
  const [lyricLines] = useState([]);
  return (
    <div className="app">
      <header className="app-header">
        <h1>Ritsu</h1>
        <p>歌词渲染器 · 构建基线</p>
      </header>
      <main className="stage">
        <LyricPlayer lyricLines={lyricLines} currentTime={0} />
      </main>
    </div>
  );
}
