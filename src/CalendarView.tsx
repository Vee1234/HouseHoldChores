import { type ReactNode, useState } from "react";
import {
  type BoardItem,
  type CalendarDay,
  DAY_LETTERS,
  type HomeData,
  type Member,
  addDays,
  describeSchedule,
  formatTime,
  weekOf,
} from "../shared/core";
import { api } from "./api";
import type { Ticking } from "./ChoresBoard";
import { AssigneeAvatars, type Slot, slotStatus, slotsFor } from "./choreParts";
import { BuddySprite, memberColor, usePolled } from "./ui";

type Mode = "week" | "month";

function remembered<T extends string>(key: string, fallback: T, allowed: T[]): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

interface Props {
  home: HomeData;
  me: Member | null;
  week: string;
  setWeek: (w: string) => void;
  weekNav: ReactNode;
  ticking: Ticking | null;
  onOpenItem: (itemId: string) => void;
}

export function CalendarView({ home, me, week, setWeek, weekNav, ticking, onOpenItem }: Props) {
  const [mode, setModeState] = useState<Mode>(() => remembered("cosy.calMode", "week", ["week", "month"]));
  const [onlyMine, setOnlyMineState] = useState(() => remembered("cosy.onlyMine", "no", ["yes", "no"]) === "yes");
  const [month, setMonth] = useState(() => home.today.slice(0, 7));
  const setMode = (m: Mode) => {
    setModeState(m);
    remember("cosy.calMode", m);
  };
  const setOnlyMine = (v: boolean) => {
    setOnlyMineState(v);
    remember("cosy.onlyMine", v ? "yes" : "no");
  };

  return (
    <div className="stack">
      <div className="row spread">
        <div className="segmented small" role="tablist" aria-label="Calendar range">
          <button role="tab" aria-selected={mode === "week"} onClick={() => setMode("week")}>
            Week
          </button>
          <button role="tab" aria-selected={mode === "month"} onClick={() => setMode("month")}>
            Month
          </button>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} disabled={!me} />
          <span>Only show my tasks</span>
        </label>
      </div>

      {mode === "week" ? (
        <>
          {weekNav}
          {ticking ? (
            <WeekCalendar ticking={ticking} onlyMine={onlyMine} onOpenItem={onOpenItem} />
          ) : (
            <p className="empty">Fluffing the cushions…</p>
          )}
        </>
      ) : (
        <MonthCalendar
          home={home}
          me={me}
          month={month}
          setMonth={setMonth}
          onlyMine={onlyMine}
          onPickDay={(day) => {
            setWeek(weekOf(day));
            setMode("week");
          }}
        />
      )}
    </div>
  );
}

// ---- week: every day's chores, by name, with their status ------------------

const STATUS_TEXT = { done: "Done", missed: "Missed", today: "Today", upcoming: "To do" } as const;

function WeekCalendar({ ticking, onlyMine, onOpenItem }: { ticking: Ticking; onlyMine: boolean; onOpenItem: (id: string) => void }) {
  const { board, chores, members, me, today, toggle, waitingFor } = ticking;
  const memberById = new Map(members.map((m) => [m.id, m]));
  const visible = board.items.filter((i) => !onlyMine || (me && i.assigneeIds.includes(me.id)));
  const withSlots = visible.map((item) => ({
    item,
    slots: slotsFor(item, board.week, board.completions.filter((c) => c.itemId === item.id)).slots,
  }));
  const anytime = withSlots.filter((x) => x.item.kind === "anytime");

  const row = (item: BoardItem, slots: Slot[], key: string) => {
    const chore = chores.get(item.choreId);
    if (!chore) return null;
    const done = slots.filter((s) => s.completion).length;
    return (
      <li key={key} className="cal-row">
        <button className="cal-chore" onClick={() => onOpenItem(item.id)}>
          <span aria-hidden>{chore.emoji}</span>
          <span className="cal-title">
            <strong>{chore.title}</strong>
            {item.kind === "days" && item.time && <small>{formatTime(item.time)}</small>}
            {item.kind === "anytime" && (
              <small>
                {describeSchedule(item)} · {done} of {slots.length} done
              </small>
            )}
          </span>
        </button>
        <AssigneeAvatars ids={item.assigneeIds} members={members} />
        <span className="cal-ticks">
          {slots.map((slot, i) => {
            const status = slotStatus(slot, today);
            const who = slot.completion?.memberId ? memberById.get(slot.completion.memberId) : undefined;
            const blocker = !slot.completion ? waitingFor(item, slot) : undefined;
            return (
              <button
                key={i}
                className={`cal-status ${status} ${blocker ? "locked" : ""}`}
                title={blocker ? `Waiting for ${blocker.title}` : undefined}
                style={who ? ({ "--who": memberColor(who.color) } as React.CSSProperties) : undefined}
                onClick={() => toggle(item, slot)}
                aria-label={`${chore.title}: ${STATUS_TEXT[status]}${who ? ` by ${who.name}` : ""}. Tap to ${slot.completion ? "undo" : "mark done"}`}
              >
                {slot.completion ? (
                  <>✓ {who && <BuddySprite buddy={who.buddy} size={16} />}</>
                ) : blocker ? (
                  `🔒 after ${blocker.title}`
                ) : (
                  STATUS_TEXT[status]
                )}
              </button>
            );
          })}
        </span>
      </li>
    );
  };

  return (
    <div className="week-cal">
      {anytime.length > 0 && (
        <section className="cal-day anyday">
          <h3>Any day this week</h3>
          <ul>{anytime.map(({ item, slots }) => row(item, slots, item.id))}</ul>
        </section>
      )}
      {Array.from({ length: 7 }, (_, i) => addDays(board.week, i)).map((day) => {
        const entries = withSlots
          .filter((x) => x.item.kind === "days")
          .flatMap(({ item, slots }) => slots.filter((s) => s.day === day).map((slot) => ({ item, slot })))
          // Timed chores first, in time order.
          .sort((a, b) => (a.item.time ?? "99") .localeCompare(b.item.time ?? "99"));
        const label = new Date(day + "T00:00:00Z").toLocaleDateString(undefined, {
          weekday: "long",
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        });
        return (
          <section key={day} className={`cal-day ${day === today ? "is-today" : ""} ${day < today ? "is-past" : ""}`}>
            <h3>
              {label}
              {day === today && <span className="pill">Today</span>}
            </h3>
            {entries.length === 0 ? (
              <p className="muted small">Nothing set for this day.</p>
            ) : (
              <ul>{entries.map(({ item, slot }) => row(item, [slot], `${item.id}-${day}`))}</ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ---- month: coloured dots per person ----------------------------------------

function MonthCalendar({
  home,
  me,
  month,
  setMonth,
  onlyMine,
  onPickDay,
}: {
  home: HomeData;
  me: Member | null;
  month: string; // YYYY-MM
  setMonth: (m: string) => void;
  onlyMine: boolean;
  onPickDay: (day: string) => void;
}) {
  const first = `${month}-01`;
  const gridStart = weekOf(first);
  const gridEnd = addDays(gridStart, 41);
  const { data, error } = usePolled<CalendarDay[]>(() => api("GET", `/api/calendar?from=${gridStart}&to=${gridEnd}`), [gridStart]);
  const memberById = new Map(home.members.map((m) => [m.id, m]));
  const shiftMonth = (n: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  };
  const title = new Date(first + "T00:00:00Z").toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <div className="stack">
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
        {(data ?? []).map(({ day, entries }) => {
          // One dot per person per chore, in that person's colour.
          const dots = entries
            .filter((e) => !onlyMine || (me && e.assigneeIds.includes(me.id)))
            .flatMap((e) =>
              (e.assigneeIds.length ? e.assigneeIds : [null])
                .filter((id) => !onlyMine || id === me?.id)
                .map((id) => ({ member: id ? memberById.get(id) : undefined, done: e.done })),
            );
          const missed = (done: boolean) => !done && day < home.today;
          const doneCount = dots.filter((d) => d.done).length;
          return (
            <button
              key={day}
              role="gridcell"
              className={`month-cell ${day.slice(0, 7) !== month ? "other-month" : ""} ${day === home.today ? "is-today" : ""}`}
              onClick={() => onPickDay(day)}
              aria-label={`${day}: ${dots.length} chores, ${doneCount} done`}
            >
              <span className="month-date">{Number(day.slice(8))}</span>
              <span className="month-dots">
                {dots.slice(0, 12).map((d, i) => (
                  <i
                    key={i}
                    className={d.done ? "done" : missed(d.done) ? "missed" : "todo"}
                    style={{ "--dot": d.member ? memberColor(d.member.color) : "var(--ink-soft)" } as React.CSSProperties}
                  />
                ))}
                {dots.length > 12 && <small>+{dots.length - 12}</small>}
              </span>
            </button>
          );
        })}
      </div>

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
          .filter((m) => !onlyMine || m.id === me?.id)
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
