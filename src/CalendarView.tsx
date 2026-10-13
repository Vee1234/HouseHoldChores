import { useState } from "react";
import { type CalendarDay, DAY_LETTERS, type HomeData, type Member, addDays, weekOf } from "../shared/core";
import { api } from "./api";
import { AssigneeAvatars } from "./choreParts";
import { memberColor, usePolled } from "./ui";

const ONLY_MINE_KEY = "cosy.onlyMine";

/** The month at a glance: a dot per person per chore, filled once done. Tap a day for its list. */
export function CalendarView({ home, me }: { home: HomeData; me: Member | null }) {
  const [onlyMine, setOnlyMineState] = useState(() => {
    try {
      return localStorage.getItem(ONLY_MINE_KEY) === "yes";
    } catch {
      return false;
    }
  });
  const setOnlyMine = (v: boolean) => {
    setOnlyMineState(v);
    try {
      localStorage.setItem(ONLY_MINE_KEY, v ? "yes" : "no");
    } catch {}
  };
  const [month, setMonth] = useState(() => home.today.slice(0, 7));
  const [picked, setPicked] = useState<string | null>(home.today);

  const first = `${month}-01`;
  const gridStart = weekOf(first);
  const gridEnd = addDays(gridStart, 41);
  const { data, error } = usePolled<CalendarDay[]>(() => api("GET", `/api/calendar?from=${gridStart}&to=${gridEnd}`), [gridStart]);
  const memberById = new Map(home.members.map((m) => [m.id, m]));
  const chores = new Map(home.chores.map((c) => [c.id, c]));
  const filtering = onlyMine && !!me;
  const shiftMonth = (n: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  };
  const title = new Date(first + "T00:00:00Z").toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  const entriesOf = (day: CalendarDay) => day.entries.filter((e) => !filtering || e.assigneeIds.includes(me!.id));
  const status = (done: boolean, day: string) => (done ? "done" : day < home.today ? "missed" : "todo");
  const pickedDay = picked ? data?.find((d) => d.day === picked) : undefined;

  return (
    <div className="stack">
      <label className="toggle">
        <input type="checkbox" checked={filtering} onChange={(e) => setOnlyMine(e.target.checked)} disabled={!me} />
        <span>Only show my tasks</span>
      </label>

      <div className="week-nav">
        <button className="icon-btn" aria-label="Previous month" onClick={() => shiftMonth(-1)}>
          ‹
        </button>
        <button className="week-label" onClick={() => setMonth(home.today.slice(0, 7))}>
          {title}
          <small>tap a day to see its chores</small>
        </button>
        <button className="icon-btn" aria-label="Next month" onClick={() => shiftMonth(1)}>
          ›
        </button>
      </div>

      {error && !data && <p className="empty">😿 {error}</p>}
      <div className="month-grid" role="grid" aria-label={title}>
        {DAY_LETTERS.map((d, i) => (
          <div key={i} className="month-head" role="columnheader">
            {d}
          </div>
        ))}
        {(data ?? []).map((cal) => {
          const { day } = cal;
          // One dot per person per chore, in that person's colour.
          const dots = entriesOf(cal).flatMap((e) =>
            (e.assigneeIds.length ? e.assigneeIds : [null])
              .filter((id) => !filtering || id === me?.id)
              .map((id) => ({ member: id ? memberById.get(id) : undefined, done: e.done })),
          );
          const doneCount = dots.filter((d) => d.done).length;
          return (
            <button
              key={day}
              role="gridcell"
              aria-selected={picked === day}
              className={`month-cell ${day.slice(0, 7) !== month ? "other-month" : ""} ${day === home.today ? "is-today" : ""} ${picked === day ? "picked" : ""}`}
              onClick={() => setPicked(day)}
              aria-label={`${day}: ${dots.length} chores, ${doneCount} done`}
            >
              <span className="month-date">{Number(day.slice(8))}</span>
              <span className="month-dots">
                {dots.slice(0, 12).map((d, i) => (
                  <i
                    key={i}
                    className={status(d.done, day)}
                    style={{ "--dot": d.member ? memberColor(d.member.color) : "var(--ink-soft)" } as React.CSSProperties}
                  />
                ))}
                {dots.length > 12 && <small>+{dots.length - 12}</small>}
              </span>
            </button>
          );
        })}
      </div>

      {pickedDay && (
        <div className="card picked-day">
          <h3>
            {new Date(pickedDay.day + "T00:00:00Z").toLocaleDateString(undefined, {
              weekday: "long",
              day: "numeric",
              month: "long",
              timeZone: "UTC",
            })}
          </h3>
          {entriesOf(pickedDay).length === 0 ? (
            <p className="muted">No chores for this day.</p>
          ) : (
            <ul className="mini-list">
              {entriesOf(pickedDay).map((e, i) => {
                const chore = chores.get(e.choreId);
                const s = status(e.done, pickedDay.day);
                return (
                  <li key={i}>
                    <span aria-hidden>{chore?.emoji}</span> {chore?.title ?? "Chore"}
                    <AssigneeAvatars ids={e.assigneeIds} members={home.members} size={22} />
                    <span className={`status-chip ${s === "todo" ? "upcoming" : s}`}>
                      {s === "done" ? "✓ done" : s === "missed" ? "missed" : "to do"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="month-legend">
        <span>
          <i className="done" /> done
        </span>
        <span>
          <i className="todo" /> to do
        </span>
        <span>
          <i className="missed" /> missed
        </span>
        {home.members
          .filter((m) => !filtering || m.id === me?.id)
          .map((m) => (
            <span key={m.id}>
              <i className="done" style={{ "--dot": memberColor(m.color) } as React.CSSProperties} /> {m.name}
            </span>
          ))}
      </div>
      <p className="muted small">Shows chores on set days, plus “any day” chores on the day they were done.</p>
    </div>
  );
}
