import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { Member } from "../shared/core";

export const MEMBER_COLORS = ["blueberry", "pumpkin", "mint", "honey", "rose", "leaf", "lavender", "cherry"];
export const AVATARS = ["🐻", "🐰", "🦊", "🐱", "🐶", "🐼", "🐸", "🐨", "🦔", "🐥", "🐹", "🦉", "🐢", "🐝", "🦄", "🐮"];
export const CHORE_EMOJIS = ["🧹", "🧺", "🍽️", "🗑️", "🛏️", "🧽", "🚿", "🪴", "🐾", "🛒", "🍳", "👕", "🚗", "📦", "🪟", "🧸"];
export const NOTE_COLORS = ["butter", "blush", "sage", "sky", "lilac"];

export const memberColor = (key: string) => `var(--m-${MEMBER_COLORS.includes(key) ? key : "blueberry"})`;

export function Avatar({ member, size = 36 }: { member?: Member | null; size?: number }) {
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.58, background: member ? memberColor(member.color) : undefined }}
      aria-hidden
    >
      {member?.emoji ?? "🫧"}
    </span>
  );
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function EmojiChoices({
  options,
  value,
  onChange,
  label,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <div className="emoji-choices" role="radiogroup" aria-label={label}>
      {options.map((e) => (
        <button
          type="button"
          key={e}
          role="radio"
          aria-checked={value === e}
          className={value === e ? "on" : ""}
          onClick={() => onChange(e)}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

export function ColorChoices({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="color-choices" role="radiogroup" aria-label="Colour">
      {MEMBER_COLORS.map((c) => (
        <button
          type="button"
          key={c}
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          className={value === c ? "on" : ""}
          style={{ background: memberColor(c) }}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

// ---- toasts -----------------------------------------------------------------

type ToastFn = (message: string) => void;
let pushToast: ToastFn = () => {};
export const toast: ToastFn = (m) => pushToast(m);

export function Toasts() {
  const [items, setItems] = useState<{ id: number; message: string }[]>([]);
  const next = useRef(0);
  useEffect(() => {
    pushToast = (message) => {
      const id = next.current++;
      setItems((xs) => [...xs, { id, message }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3500);
    };
  }, []);
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast">
          {t.message}
        </div>
      ))}
    </div>
  );
}

/** Runs an action and shows its error as a toast instead of throwing. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    toast(e instanceof Error ? e.message : "Something went wrong");
    return undefined;
  }
}

// ---- data loading -----------------------------------------------------------

/** Loads data, refreshes it every so often while the app is visible, and on focus. */
export function usePolled<T>(load: () => Promise<T>, deps: unknown[], everyMs = 20000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loader = useCallback(load, deps);
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const ticket = ++latest.current;
    try {
      const result = await loader();
      if (ticket === latest.current) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (ticket === latest.current) setError(e instanceof Error ? e.message : "Couldn't load");
    }
  }, [loader]);

  useEffect(() => {
    setData(null);
    refresh();
    const timer = setInterval(() => document.visibilityState === "visible" && refresh(), everyMs);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, everyMs]);

  return { data, setData, error, refresh };
}

export function prettyDay(day: string, today: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const diff = Math.round((date.getTime() - Date.parse(today + "T00:00:00Z")) / 86400000);
  const named = { [-1]: "Yesterday", 0: "Today", 1: "Tomorrow" }[diff];
  const full = date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  return named ? `${named} · ${full}` : full;
}

export function prettyWeek(week: string): string {
  const [y, m, d] = week.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(Date.UTC(y, m - 1, d + 6));
  const fmt = (dt: Date) => dt.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
  return `${fmt(start)} – ${fmt(end)}`;
}
