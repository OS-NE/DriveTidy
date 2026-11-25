/// <reference types="vite-plugin-pwa/client" />
// Offline support: registers the generated /sw.js service worker, but only in
// real production deployments. Never registers in dev, iframes, or Lovable
// preview contexts, where a cached app shell would serve stale code.
const PREVIEW_LABEL = /^(?:id-preview|preview)(?:-[a-z0-9]+)?--.+$/;

function registrationRefused(): boolean {
  if (!import.meta.env.PROD) return true;
  if (window.self !== window.top) return true;
  const host = window.location.hostname.toLowerCase();
  const firstLabel = host.split(".")[0] ?? "";
  const onLovableInfra =
    host.endsWith(".lovable.app") ||
    host.endsWith(".gpt-eng.com") ||
    host.endsWith(".gptengineer.run");
  if (onLovableInfra && PREVIEW_LABEL.test(firstLabel)) return true;
  if (host === "lovableproject.com" || host.endsWith(".lovableproject.com")) return true;
  if (host === "lovableproject-dev.com" || host.endsWith(".lovableproject-dev.com")) return true;
  if (host === "beta.lovable.dev" || host.endsWith(".beta.lovable.dev")) return true;
  if (new URLSearchParams(window.location.search).get("sw") === "off") return true;
  return false;
}

async function unregisterAppServiceWorkers() {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.allSettled(
    registrations
      .filter((registration) => registration.active?.scriptURL.endsWith("/sw.js"))
      .map((registration) => registration.unregister()),
  );
}

export async function registerPwa() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  // The installed desktop build is served by its own local Node process; do not
  // let a browser service worker cache or outlive that managed desktop runtime.
  if (/\bElectron\//i.test(navigator.userAgent)) return;
  if (registrationRefused()) {
    await unregisterAppServiceWorkers().catch(() => {});
    return;
  }
  // Register the generated worker directly; the plugin's virtual helper was a
  // no-op in the TanStack client build, so the live site never went offline-ready.
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  void registration.update().catch(() => {});
}
