// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Electron runs the production app as a private loopback Node server.
  nitro: { preset: "node-server" },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    plugins: [
      VitePWA({
        registerType: "autoUpdate",
        // The guarded wrapper in src/lib/pwa.ts is the only registrar.
        injectRegister: null,
        devOptions: { enabled: false },
        filename: "sw.js",
        manifest: false, // shipped as public/manifest.webmanifest
        workbox: {
          // Navigations are network-first so a stale shell is never served when online.
          runtimeCaching: [
            {
              urlPattern: ({ request, url }) => request.mode === "navigate" && !url.pathname.startsWith("/~oauth"),
              handler: "NetworkFirst",
              options: { cacheName: "pages", networkTimeoutSeconds: 4 },
            },
            {
              urlPattern: ({ url, sameOrigin }) => sameOrigin && /\.(?:js|css|woff2?|png|jpg|svg|ico|webmanifest)$/.test(url.pathname),
              handler: "CacheFirst",
              options: { cacheName: "assets" },
            },
          ],
          // Pages are server-rendered (no index.html), so the default SPA fallback
          // would hijack every navigation and fail; the NetworkFirst route handles them.
          navigateFallback: null,
          // The client build lands in a "client/" folder but is served from the site
          // root; without this the precache 404s and the worker never installs.
          modifyURLPrefix: { "client/": "/" },
        },
      }),
    ],
  },
});
