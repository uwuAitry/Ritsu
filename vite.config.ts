import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base 指向 GitHub Pages 的项目路径（仓库名 Ritsu）
export default defineConfig({
  base: "/Ritsu/",
  plugins: [react()],
});
