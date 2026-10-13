import { useCallback, useEffect, useState } from "react";
import type { HomeData } from "../shared/core";
import { ApiError, api, session } from "./api";
import { refreshApp, useUpdateAvailable } from "./appUpdate";
import { BuddyTrack } from "./BuddyTrack";
import { ChoresBoard } from "./ChoresBoard";
import { Family, signOutDevice } from "./Family";
import { Onboarding } from "./Onboarding";
import { Reminders } from "./Reminders";
import { TimeStats } from "./TimeStats";
import { Today } from "./Today";
import { BuddySprite, Toasts, usePolled } from "./ui";

const TABS = [
  { id: "today", label: "Today", icon: "🏡" },
  { id: "chores", label: "Chores", icon: "🧺" },
  { id: "reminders", label: "Reminders", icon: "⏰" },
  { id: "time", label: "Time", icon: "⏳" },
  { id: "family", label: "Family", icon: "🐻" },
] as const;
type Tab = (typeof TABS)[number]["id"];

function initialTab(): Tab {
  const t = new URLSearchParams(location.search).get("tab");
  return TABS.some((x) => x.id === t) ? (t as Tab) : "today";
}

export function App() {
  const [signedIn, setSignedIn] = useState(() => !!session.token() && !!session.me());
  return (
    <>
      {signedIn ? <Main onSignedOut={() => setSignedIn(false)} /> : <Onboarding onDone={() => setSignedIn(true)} />}
      <Toasts />
    </>
  );
}

function Main({ onSignedOut }: { onSignedOut: () => void }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [meId, setMeId] = useState(session.me());
  const { data: home, error, refresh } = usePolled<HomeData>(() => api("GET", "/api/home"), [], 60000);
  const install = useInstallPrompt();
  const updateReady = useUpdateAvailable();

  const signOut = useCallback(() => {
    signOutDevice();
    onSignedOut();
  }, [onSignedOut]);

  // A revoked or unknown token sends you back to the welcome screen.
  useEffect(() => {
    api("GET", "/api/home").catch((e) => e instanceof ApiError && e.status === 401 && signOut());
  }, [signOut]);

  // Opening the app from a notification brings it to the right tab.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "navigate") setTab(new URL(e.data.url, location.origin).searchParams.get("tab") as Tab ?? "today");
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, []);

  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, "", t === "today" ? "/" : `/?tab=${t}`);
    window.scrollTo({ top: 0 });
  };

  if (!home)
    return <main className="loading">{error ? <p>😿 {error}</p> : <p className="bounce">🧸</p>}</main>;

  const me = home.members.find((m) => m.id === meId) ?? null;
  const setMe = (id: string) => {
    session.setMe(id);
    setMeId(id);
  };

  return (
    <div className="shell">
      {me && <BuddyTrack home={home} me={me} />}
      <main className="content">
        {tab === "today" && <Today home={home} me={me} goTo={go} reloadHome={refresh} />}
        {tab === "chores" && <ChoresBoard home={home} me={me} reloadHome={refresh} />}
        {tab === "reminders" && <Reminders home={home} me={me} />}
        {tab === "time" && <TimeStats home={home} />}
        {tab === "family" && (
          <Family home={home} me={me} setMe={setMe} reloadHome={refresh} signOut={signOut} installPrompt={install} />
        )}
      </main>
      {updateReady && (
        <div className="update-banner" role="status">
          <span>✨ A new version of Cosy Chores is ready</span>
          <button className="btn primary" onClick={refreshApp}>
            Refresh
          </button>
        </div>
      )}
      <nav className="tabbar" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => go(t.id)} aria-current={tab === t.id ? "page" : undefined}>
            <span className="tab-icon" aria-hidden>
              {t.id === "family" && me ? <BuddySprite buddy={me.buddy} size={26} /> : t.icon}
            </span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

/** Chrome/Android's install prompt, captured so we can offer a nice button for it. */
function useInstallPrompt(): (() => void) | null {
  const [evt, setEvt] = useState<any>(null);
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvt(e);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);
  return evt
    ? () => {
        evt.prompt();
        setEvt(null);
      }
    : null;
}
