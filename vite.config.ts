import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Check if running in Tauri environment
const isTauri = process.env.TAURI_ENV === "true" || process.env.TAURI_PLATFORM !== undefined;

// https://vite.dev/config/
export default defineConfig({
  plugins: isTauri 
    ? [react(), tailwindcss()] 
    : [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  // Tauri specific config
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: "0.0.0.0" as const,
    hmr: isTauri ? {
      protocol: "ws",
      host: "127.0.0.1",
      port: 5173,
    } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux
    target: isTauri ? ["es2021", "chrome100", "safari13"] : undefined,
    // Don't minify for debug builds
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    // Produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
