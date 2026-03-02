import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    headers: {
      // CRITICAL: These headers are REQUIRED for WebContainer to boot
      // Without these exact values, SharedArrayBuffer will not be available
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  optimizeDeps: {
    exclude: ["@mlc-ai/web-llm", "@webcontainer/api"],
  },
  build: {
    target: "esnext",
    rollupOptions: {
      output: {
        manualChunks: {
          webllm: ["@mlc-ai/web-llm"],
          // Note: webcontainer is dynamically imported only when needed
          "syntax-highlighter": ["react-syntax-highlighter"],
          xterm: ["@xterm/xterm", "@xterm/addon-fit"],
        },
      },
    },
  },
});
