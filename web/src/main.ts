import { createApp } from "vue";
import { createPinia } from "pinia";
import { autoAnimatePlugin } from "@formkit/auto-animate/vue";
import App from "./App.vue";
import { i18n } from "./i18n";
import { startSignInNudgeSession } from "./lib/sign-in-nudge";
import "./style.css";
import "vue-sonner/style.css";

// Recover from stale-chunk errors. When the daemon ships a new build, its hashed chunk names
// change; a tab still running the old build then lazy-imports a chunk that no longer exists on disk
// and the import rejects (Vite fires `vite:preloadError`). Reload once to pull the fresh build
// instead of showing a dead view. A short timestamp guard prevents a reload loop if the new build
// is genuinely broken (chunk truly missing) — pairs with the server's /assets/* 404 (see
// server/src/http/index.ts).
window.addEventListener("vite:preloadError", (event) => {
  const KEY = "devwebui:last-chunk-reload";
  const now = Date.now();
  if (now - Number(sessionStorage.getItem(KEY) ?? 0) < 10_000) {
    console.error("[devwebui] chunk failed to load again right after a reload", event);
    return;
  }
  sessionStorage.setItem(KEY, String(now));
  event.preventDefault();
  window.location.reload();
});

// Counts one session for the Connections sign-in prompt. Here, not in the store, because the
// store is built lazily: an owner who never opens the settings pane would never accrue a session
// and so could never pass the prompt's gate. Counting only - nothing is shown from this call.
startSignInNudgeSession({ appId: "devwebui", appName: "DevWebUI" });

createApp(App).use(createPinia()).use(i18n).use(autoAnimatePlugin).mount("#app");
