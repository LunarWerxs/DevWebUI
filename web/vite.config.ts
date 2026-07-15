import path from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// Keep in sync with the daemon's DEFAULT_DAEMON_PORT (server/src/constants.ts).
// Honour DEVWEBUI_PORT so the proxy follows a daemon started on a custom port.
const DAEMON_PORT = Number(process.env.DEVWEBUI_PORT) || 4000;

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: {
    rollupOptions: {
      // @vueuse/core ships /* #__PURE__ */ comments in positions rolldown can't bind to a call
      // expression (e.g. before an object literal); it flags them as INVALID_ANNOTATION even
      // though the annotation is inert there. Silence that one benign check to keep builds quiet.
      checks: { invalidAnnotation: false },
      output: {
        // Split the heavy vendor libraries into their own chunks so no single
        // bundle blows past the 500 kB warning and the browser can cache each
        // independently (app code changes far more often than these do).
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("reka-ui") || id.includes("@floating-ui")) return "vendor-reka";
          if (id.includes("@lucide") || id.includes("lucide")) return "vendor-icons";
          if (id.includes("vue-i18n") || id.includes("@intlify")) return "vendor-i18n";
          if (id.includes("@vueuse")) return "vendor-vueuse";
          return "vendor"; // vue, pinia, vue-sonner, and the long tail
        },
      },
    },
  },
  server: {
    port: 4010,
    strictPort: true,
    proxy: {
      // Everything under /api goes to the DevWebUI daemon (REST + SSE).
      "/api": { target: `http://localhost:${DAEMON_PORT}`, changeOrigin: true },
    },
  },
});
