import { useState } from "react";
import {
  type Announcement,
  type HomeData,
  type Member,
  type Reminder,
  addDays,
  goesPerWeek,
} from "../shared/core";
import { api } from "./api";
import { useChorePlanner } from "./ChoresBoard";
import { EveryonesProgress } from "./EveryonesProgress";
import { TodayChores } from "./TodayChores";
import { Updates } from "./Updates";
import { BuddySprite, NOTE_COLORS, Sheet, attempt, prettyDay, toast, usePolled } from "./ui";

interface Props {
  home: HomeData;
  me: Member | null;
  goTo: (tab: "chores" | "reminders") => void;
  reloadHome: () => void;
}

export function Today({ home, me, goTo, reloadHome }: Props) {
  const [day, setDay] = useState(home.today);
  const [posting, setPosting] = useState(false);
  const notes = usePolled<Announcement[]>(() => api("GET", `/api/announcements?day=${day}`), [day]);
  const planner = useChorePlanner({ home, me, reloadHome, week: home.currentWeek });
  const board = { data: planner.board };
  const reminders = usePolled<Reminder[]>(() => api("GET", "/api/reminders"), []);
  const members = new Map(home.members.map((m) => [m.id, m]));
  const chores = new Map(home.chores.map((c) => [c.id, c]));

  const myItems = (board.data?.items ?? []).filter((i) => me && i.assigneeIds.includes(me.id));
  const doneCount = (itemId: string) => board.data?.completions.filter((c) => c.itemId === itemId).length ?? 0;
  const left = myItems.filter((i) => doneCount(i.id) < goesPerWeek(i));
  const upcoming = (reminders.data ?? [])
    .filter((r) => r.active && (r.memberId === null || r.memberId === me?.id))
    .slice(0, 3);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <section className="page home-page">
      <header className="greeting">
        <h1>
          {greeting}
          {me ? `, ${me.name}` : ""} {me ? <BuddySprite buddy={me.buddy} size={34} className="inline-sprite" /> : "☀️"}
        </h1>
        <p className="muted">{home.household.name}</p>
      </header>

      {planner.ticking ? (
        <TodayChores show="today" ticking={planner.ticking} planning={planner.planning} onOpenItem={planner.openItem} />
      ) : (
        <p className="empty">Fluffing the cushions…</p>
      )}

      <div className="corkboard">
        <div className="corkboard-head">
          <button className="icon-btn" aria-label="Previous day" onClick={() => setDay(addDays(day, -1))}>
            ‹
          </button>
          <button className="day-label" onClick={() => setDay(home.today)}>
            📌 {prettyDay(day, home.today)}
          </button>
          <button className="icon-btn" aria-label="Next day" onClick={() => setDay(addDays(day, 1))}>
            ›
          </button>
        </div>
        <div className="notes">
          {notes.data?.length === 0 && <p className="empty small">Nothing pinned up for this day.</p>}
          {notes.data?.map((n, i) => {
            const author = n.authorId ? members.get(n.authorId) : undefined;
            return (
              <article key={n.id} className={`note note-${n.color}`} style={{ "--tilt": `${((i * 7) % 5) - 2}deg` } as React.CSSProperties}>
                <p>{n.text}</p>
                <footer>
                  <span>
                    {author ? `${author.emoji} ${author.name}` : "Someone"} ·{" "}
                    {new Date(n.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </span>
                  <button
                    className="note-remove"
                    aria-label="Take note down"
                    onClick={async () => {
                      notes.setData(notes.data!.filter((x) => x.id !== n.id));
                      await attempt(() => api("DELETE", `/api/announcements/${n.id}`));
                      notes.refresh();
                    }}
                  >
                    ✕
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
        <button className="btn primary pin-btn" onClick={() => setPosting(true)}>
          📝 Pin a note
        </button>
      </div>

      <Updates
        home={home}
        me={me}
        between={
        <div className="card">
          <div className="card-head">
            <h2>⏰ Upcoming reminders</h2>
            <button className="link" onClick={() => goTo("reminders")}>
              All reminders →
            </button>
          </div>
          {reminders.data && upcoming.length === 0 && <p className="muted">No reminders set.</p>}
          <ul className="mini-list">
            {upcoming.map((r) => (
              <li key={r.id}>
                <span>{r.title}</span>
                <span className="pill">{formatWhen(r.dueAt)}</span>
              </li>
            ))}
          </ul>
        </div>
        }
      />

      <div className="card">
        <div className="card-head">
          <h2>🧺 Your chores this week</h2>
          <button className="link" onClick={() => goTo("chores")}>
            This week →
          </button>
        </div>
        {!me && <p className="muted">Pick who you are under Family to see your chores.</p>}
        {me && board.data && myItems.length === 0 && <p className="muted">Nothing on your list — lucky you! 🌼</p>}
        {me && myItems.length > 0 && left.length === 0 && <p className="cheer">🎉 You've done everything this week!</p>}
        <ul className="mini-list">
          {left.map((i) => {
            const c = chores.get(i.choreId);
            return c ? (
              <li key={i.id}>
                <span aria-hidden>{c.emoji}</span> {c.title}
                <span className="pill">
                  {doneCount(i.id)}/{goesPerWeek(i)}
                </span>
              </li>
            ) : null;
          })}
        </ul>
      </div>

      {board.data && <EveryonesProgress board={board.data} home={home} me={me} />}

      {/* Stays just above the tab bar while you scroll, on a strip of background
          so the page doesn't show through the gap. */}
      <div className="floating-add-bar">
        <button
          className="btn primary floating-add"
          onClick={() => planner.openAdd(me?.id ?? home.members[0]?.id ?? "")}
          disabled={!home.members.length}
        >
          ＋ Add New Chore
        </button>
      </div>

      {planner.sheets}

      {posting && (
        <NoteSheet
          day={day}
          today={home.today}
          me={me}
          onClose={() => setPosting(false)}
          onPosted={(posted) => {
            setDay(posted);
            notes.refresh();
          }}
        />
      )}
    </section>
  );
}

export function formatWhen(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

function NoteSheet({
  day,
  today,
  me,
  onClose,
  onPosted,
}: {
  day: string;
  today: string;
  me: Member | null;
  onClose: () => void;
  onPosted: (day: string) => void;
}) {
  const [text, setText] = useState("");
  const [color, setColor] = useState("butter");
  const [when, setWhen] = useState(day < today ? today : day);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title="Pin a note" onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const ok = await attempt(() => api("POST", "/api/announcements", { text, color, day: when, authorId: me?.id }));
          setBusy(false);
          if (ok) {
            toast(when === today ? "Pinned — everyone's been notified 📣" : "Pinned — everyone gets a nudge that morning 📣");
            onPosted(when);
            onClose();
          }
        }}
      >
        <textarea
          className={`note-input note-${color}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Plumber coming at 10! / Pizza night 🍕 / Don't eat the cake, it's for Gran"
          rows={4}
          maxLength={500}
          autoFocus
        />
        <div className="row spread">
          <div className="color-choices" role="radiogroup" aria-label="Note colour">
            {NOTE_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                role="radio"
                aria-checked={color === c}
                aria-label={c}
                className={`note-${c} ${color === c ? "on" : ""}`}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          <label className="row">
            <span className="muted">For</span>
            <input type="date" value={when} min={today} onChange={(e) => setWhen(e.target.value || today)} />
          </label>
        </div>
        <button className="btn primary" disabled={busy || !text.trim()}>
          📌 Pin it up
        </button>
      </form>
    </Sheet>
  );
}

