import { useEffect, useState } from "react";

// Each build gives the app's script a new hashed name (/assets/index-<hash>.js),
// so comparing ours with the one the server now serves tells us a newer
// version has been deployed.
const SCRIPT_PATTERN = /\/assets\/index-[\w-]+\.js/;
const CHECK_EVERY_MS = 5 * 60 * 1000;

function runningScript(): string | null {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute("src");
  return src?.match(SCRIPT_PATTERN)?.[0] ?? null;
}

async function latestScript(): Promise<string | null> {
  // The query string keeps the service worker's saved copy of the page out of it.
  const res = await fetch(`/?version-check=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.text()).match(SCRIPT_PATTERN)?.[0] ?? null;
}

/** A short name for the build that's running, e.g. "jyTi_g9i" ("dev" when developing). */
export function runningVersion(): string {
  return runningScript()?.replace(/^\/assets\/index-|\.js$/g, "") ?? "dev";
}

/** True once a newer version of the app has been deployed than the one running. */
export function useUpdateAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const current = runningScript();
    // In development the script isn't hashed, so there's nothing to compare.
    if (!current) return;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      const latest = await latestScript().catch(() => null);
      if (latest && latest !== current) setAvailable(true);
    };
    check();
    const timer = setInterval(check, CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return available;
}

/** Throws away the saved copy of the app and reloads the newest version. */
export async function refreshApp() {
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch {
    // Reloading is what matters; the caches will refill.
  }
  location.reload();
}
