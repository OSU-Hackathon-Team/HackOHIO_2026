import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: { "@fixtures": path.resolve(__dirname, "../../fixtures") },
  },
  server: {
    port: 5173,
    host: true,
    fs: { allow: [path.resolve(__dirname, "../..")] }, // fixtures/ + targets/ live outside the package
    proxy: {
      "/api": {
        target: loadEnv(mode, __dirname, "VITE_").VITE_API_PROXY_TARGET || "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
}));
