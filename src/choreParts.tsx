import { useState } from "react";
import {
  type BoardItem,
  type Chore,
  type Completion,
  DAY_LETTERS,
  DAY_SHORT,
  type Member,
  type Per,
  type Schedule,
  WEEKDAYS,
  EVERY_DAY,
  goesPerWeek,
  scheduledDays,
  weekdayIndex,
} from "../shared/core";
import { Avatar, CHORE_EMOJIS, EmojiChoices, attempt, memberColor } from "./ui";

// ---- the goes of a chore in a week -----------------------------------------

export interface Slot {
  /** The scheduled day, for chores on set days. */
  day: string | null;
  label: string;
  completion: Completion | undefined;
}

/**
 * The tick dots for an item: one per scheduled day for set-day chores
 * (matched to ticks by day), or N free dots for "any time" chores.
 */
export function slotsFor(item: BoardItem, week: string, completions: Completion[]): { slots: Slot[]; extra: number } {
  if (item.kind === "days") {
    const used = new Set<string>();
    const slots = scheduledDays(item.days, week).map((day) => {
      const completion = completions.find((c) => c.day === day && !used.has(c.id));
      if (completion) used.add(completion.id);
      return { day, label: DAY_LETTERS[weekdayIndex(day)], completion };
    });
    return { slots, extra: completions.length - used.size };
  }
  const slots = Array.from({ length: item.timesPerWeek }, (_, i) => ({ day: null, label: "", completion: completions[i] }));
  return { slots, extra: Math.max(0, completions.length - item.timesPerWeek) };
}

/** Which go the big Completed button ticks: today's if it's due, otherwise the earliest left. */
export function nextSlot(slots: Slot[], today: string): Slot | undefined {
  const open = slots.filter((s) => !s.completion);
  return open.find((s) => s.day === today) ?? open[0];
}

export type SlotStatus = "done" | "missed" | "today" | "upcoming";

export function slotStatus(slot: Slot, today: string): SlotStatus {
  if (slot.completion) return "done";
  if (!slot.day) return "upcoming";
  return slot.day < today ? "missed" : slot.day === today ? "today" : "upcoming";
}

// ---- forms ------------------------------------------------------------------

/** The chore itself: name, icon and rough time. How often and who live elsewhere. */
export function ChoreForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial?: Chore;
  submitLabel: string;
  onSubmit: (c: Omit<Chore, "id">) => Promise<void>;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [emoji, setEmoji] = useState(initial?.emoji ?? "🧹");
  const [minutes, setMinutes] = useState(String(initial?.minutes ?? 15));
  const [per, setPer] = useState<Per>(initial?.per ?? "each");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await attempt(() => onSubmit({ title, emoji, minutes: Number(minutes), per }));
        setBusy(false);
      }}
    >
      <ChoreFields {...{ title, setTitle, emoji, setEmoji, minutes, setMinutes, per, setPer }} />
      <button className="btn primary" disabled={busy || !title.trim() || !(Number(minutes) > 0)}>
        {submitLabel}
      </button>
    </form>
  );
}

export function ChoreFields(p: {
  title: string;
  setTitle: (v: string) => void;
  emoji: string;
  setEmoji: (v: string) => void;
  minutes: string;
  setMinutes: (v: string) => void;
  per: Per;
  setPer: (v: Per) => void;
}) {
  return (
    <>
      <label className="field">
        <span>Chore</span>
        <input value={p.title} onChange={(e) => p.setTitle(e.target.value)} placeholder="Unload the dishwasher" maxLength={80} />
      </label>
      <div className="field">
        <span>Icon</span>
        <EmojiChoices options={CHORE_EMOJIS} value={p.emoji} onChange={p.setEmoji} label="Chore icon" />
      </div>
      <div className="field">
        <span>Roughly how long?</span>
        <div className="row">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={p.minutes}
            onChange={(e) => p.setMinutes(e.target.value)}
            className="narrow"
            aria-label="Minutes"
          />
          <span>minutes</span>
          <select value={p.per} onChange={(e) => p.setPer(e.target.value as Per)} aria-label="Measured per">
            <option value="each">each time</option>
            <option value="day">a day</option>
            <option value="week">a week</option>
            <option value="month">a month</option>
          </select>
        </div>
      </div>
    </>
  );
}

/** How often: any days (N× a week) or set days, optionally every N weeks. */
export function ScheduleEditor({
  value,
  onChange,
  allowRepeat,
  afterOptions = [],
}: {
  value: Schedule;
  onChange: (s: Schedule) => void;
  /** Templates can repeat every N weeks; a single week's copy can't. */
  allowRepeat: boolean;
  /** Chores this one could be made to wait for. */
  afterOptions?: Chore[];
}) {
  const set = (patch: Partial<Schedule>) => {
    const next = { ...value, ...patch };
    if (next.kind === "days") next.timesPerWeek = goesPerWeek(next);
    onChange(next);
  };
  return (
    <div className="stack schedule">
      <div className="segmented small" role="radiogroup" aria-label="How often">
        <button
          type="button"
          role="radio"
          aria-checked={value.kind === "anytime"}
          aria-selected={value.kind === "anytime"}
          onClick={() => set({ kind: "anytime", days: 0, timesPerWeek: Math.max(1, value.timesPerWeek) })}
        >
          Any days
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={value.kind === "days"}
          aria-selected={value.kind === "days"}
          onClick={() => set({ kind: "days", days: value.days || 1 << ((new Date().getDay() + 6) % 7) })}
        >
          On set days
        </button>
      </div>

      {value.kind === "anytime" ? (
        <div className="row">
          <Stepper value={value.timesPerWeek} min={1} max={21} onChange={(n) => set({ timesPerWeek: n })} label="Times" />
          <span>{value.timesPerWeek === 1 ? "time" : "times"} a week, whichever days suit</span>
        </div>
      ) : (
        <div className="stack tight">
          <div className="day-chips" role="group" aria-label="Days">
            {DAY_SHORT.map((d, i) => {
              const on = !!(value.days & (1 << i));
              return (
                <button
                  type="button"
                  key={d}
                  className={on ? "on" : ""}
                  aria-pressed={on}
                  onClick={() => {
                    const days = value.days ^ (1 << i);
                    if (days) set({ days });
                  }}
                >
                  {d}
                </button>
              );
            })}
          </div>
          <div className="row quick">
            <button type="button" className="link" onClick={() => set({ days: EVERY_DAY })}>
              Every day
            </button>
            <button type="button" className="link" onClick={() => set({ days: WEEKDAYS })}>
              Weekdays
            </button>
            <button type="button" className="link" onClick={() => set({ days: 0b1100000 })}>
              Weekends
            </button>
          </div>
        </div>
      )}

      {value.kind === "days" && (
        <label className="row">
          <span>At</span>
          <input
            type="time"
            value={value.time ?? ""}
            onChange={(e) => set({ time: e.target.value || null })}
            className="narrow-time"
            aria-label="Time (optional)"
          />
          {value.time ? (
            <button type="button" className="link" onClick={() => set({ time: null })}>
              No set time
            </button>
          ) : (
            <small className="muted">optional — we'll nudge them then</small>
          )}
        </label>
      )}

      {afterOptions.length > 0 && (
        <label className="row">
          <span>Only after</span>
          <select value={value.afterChoreId ?? ""} onChange={(e) => set({ afterChoreId: e.target.value || null })}>
            <option value="">no need to wait</option>
            {afterOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.emoji} {c.title} is done
              </option>
            ))}
          </select>
        </label>
      )}

      {allowRepeat && (
        <label className="row">
          <span>Repeats</span>
          <select value={value.everyWeeks} onChange={(e) => set({ everyWeeks: Number(e.target.value) })}>
            <option value={1}>every week</option>
            {[2, 3, 4, 5, 6, 8].map((n) => (
              <option key={n} value={n}>
                every {n} weeks
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  label: string;
}) {
  return (
    <span className="stepper" role="group" aria-label={label}>
      <button type="button" className="icon-btn" aria-label="Fewer" disabled={value <= min} onClick={() => onChange(value - 1)}>
        −
      </button>
      <strong className="count">{value}</strong>
      <button type="button" className="icon-btn" aria-label="More" disabled={value >= max} onClick={() => onChange(value + 1)}>
        +
      </button>
    </span>
  );
}

/** Pick one or several people. Nobody picked = up for grabs. */
export function AssigneePicker({
  members,
  value,
  onChange,
}: {
  members: Member[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <div className="stack tight">
      <div className="people-chips" role="group" aria-label="Who's doing it">
        {members.map((m) => {
          const on = value.includes(m.id);
          return (
            <button
              type="button"
              key={m.id}
              className={on ? "on" : ""}
              aria-pressed={on}
              style={{ "--chip": memberColor(m.color) } as React.CSSProperties}
              onClick={() => onChange(on ? value.filter((id) => id !== m.id) : [...value, m.id])}
            >
              <Avatar member={m} size={24} /> {m.name}
            </button>
          );
        })}
      </div>
      <small className="muted">
        {value.length === 0
          ? "Nobody picked — it'll be up for grabs."
          : value.length > 1
            ? "Done together: one tick counts for everyone picked."
            : ""}
      </small>
    </div>
  );
}

export function AssigneeAvatars({ ids, members, size = 22 }: { ids: string[]; members: Member[]; size?: number }) {
  const people = ids.map((id) => members.find((m) => m.id === id)).filter(Boolean) as Member[];
  if (!people.length) return <span className="grabs-tag">🎁 up for grabs</span>;
  return (
    <span className="avatar-stack" title={people.map((p) => p.name).join(", ")}>
      {people.map((p) => (
        <Avatar key={p.id} member={p} size={size} />
      ))}
    </span>
  );
}

export const NEW_SCHEDULE: Schedule = { kind: "anytime", timesPerWeek: 1, days: 0, everyWeeks: 1, time: null, afterChoreId: null };


/** Steps back one screen inside a sheet. */
export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="back-btn" onClick={onClick}>
      ‹ Back
    </button>
  );
}
