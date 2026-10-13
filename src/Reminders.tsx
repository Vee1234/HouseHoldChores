import { useState } from "react";
import type { HomeData, Member, Reminder, Repeat } from "../shared/core";
import { api } from "./api";
import { Avatar, Sheet, attempt, toast, usePolled } from "./ui";
import { formatWhen } from "./Today";

const REPEAT_LABELS: Record<Repeat, string> = {
  none: "Just once",
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "Every week",
  monthly: "Every month",
};

export function Reminders({ home, me }: { home: HomeData; me: Member | null }) {
  const { data, setData, refresh } = usePolled<Reminder[]>(() => api("GET", "/api/reminders"), []);
  const [editing, setEditing] = useState<Reminder | "new" | null>(null);
  const members = new Map(home.members.map((m) => [m.id, m]));
  const active = (data ?? []).filter((r) => r.active);
  const finished = (data ?? []).filter((r) => !r.active).slice(-10).reverse();

  const remove = async (r: Reminder) => {
    setData((data ?? []).filter((x) => x.id !== r.id));
    await attempt(() => api("DELETE", `/api/reminders/${r.id}`));
    refresh();
  };

  return (
    <section className="page">
      <header className="page-head row spread">
        <h1>⏰ Reminders</h1>
        <button className="btn primary" onClick={() => setEditing("new")}>
          + New
        </button>
      </header>

      {data && active.length === 0 && (
        <p className="empty">
          No reminders yet. Try “Bins out tonight 🗑️” every Wednesday at 7pm.
        </p>
      )}

      <ul className="reminder-list">
        {active.map((r) => {
          const who = r.memberId ? members.get(r.memberId) : null;
          return (
            <li key={r.id} className="reminder">
              <button className="reminder-main" onClick={() => setEditing(r)}>
                {who ? <Avatar member={who} size={32} /> : <span className="avatar everyone">👨‍👩‍👧</span>}
                <span>
                  <strong>{r.title}</strong>
                  <small>
                    {formatWhen(r.dueAt)} · {REPEAT_LABELS[r.repeat]} · {who ? who.name : "Everyone"}
                  </small>
                </span>
              </button>
              <button className="icon-btn" aria-label={`Delete ${r.title}`} onClick={() => remove(r)}>
                🗑️
              </button>
            </li>
          );
        })}
      </ul>

      {finished.length > 0 && (
        <>
          <h2 className="subhead">Done & dusted</h2>
          <ul className="reminder-list faded">
            {finished.map((r) => (
              <li key={r.id} className="reminder">
                <span className="reminder-main">
                  <span>
                    <strong>{r.title}</strong>
                    <small>{formatWhen(r.dueAt)}</small>
                  </span>
                </span>
                <button className="icon-btn" aria-label={`Delete ${r.title}`} onClick={() => remove(r)}>
                  🗑️
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {editing && (
        <ReminderSheet
          reminder={editing === "new" ? null : editing}
          members={home.members}
          me={me}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
    </section>
  );
}

/** Formats a timestamp for <input type="datetime-local"> in the device's timezone. */
function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function ReminderSheet({
  reminder,
  members,
  me,
  onClose,
  onSaved,
}: {
  reminder: Reminder | null;
  members: Member[];
  me: Member | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const inAnHour = Math.ceil((Date.now() + 3600000) / 900000) * 900000;
  const [title, setTitle] = useState(reminder?.title ?? "");
  const [when, setWhen] = useState(toLocalInput(reminder?.dueAt ?? inAnHour));
  const [repeat, setRepeat] = useState<Repeat>(reminder?.repeat ?? "none");
  const [memberId, setMemberId] = useState<string>(reminder?.memberId ?? "");
  const [busy, setBusy] = useState(false);
  const dueAt = new Date(when).getTime();

  return (
    <Sheet title={reminder ? "Edit reminder" : "New reminder"} onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (repeat === "none" && dueAt < Date.now()) return toast("That time has already passed 🕰️");
          setBusy(true);
          const body = { title, dueAt, repeat, memberId: memberId || null, createdBy: me?.id, active: true };
          const ok = await attempt(() =>
            reminder ? api("PATCH", `/api/reminders/${reminder.id}`, body) : api("POST", "/api/reminders", body),
          );
          setBusy(false);
          if (ok) {
            onSaved();
            onClose();
          }
        }}
      >
        <label className="field">
          <span>What?</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bins out tonight 🗑️" maxLength={120} autoFocus />
        </label>
        <label className="field">
          <span>When?</span>
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required />
        </label>
        <label className="field">
          <span>Repeat</span>
          <select value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}>
            {Object.entries(REPEAT_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Who gets nudged?</span>
          <select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
            <option value="">👨‍👩‍👧 Everyone</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.emoji} {m.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary" disabled={busy || !title.trim() || !Number.isFinite(dueAt)}>
          {reminder ? "Save" : "Set reminder"} ⏰
        </button>
      </form>
    </Sheet>
  );
}
