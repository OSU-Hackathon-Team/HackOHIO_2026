import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
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
        target: "http://localhost:3001",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
