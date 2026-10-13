// Logic shared by the worker and the app: data shapes, time-estimate maths
// and calendar helpers that work in the household's timezone.

export type Per = "each" | "day" | "week" | "month";
export type Repeat = "none" | "daily" | "weekdays" | "weekly" | "monthly";

export interface Household {
  id: string;
  name: string;
  joinCode: string;
  timezone: string;
}

export interface Member {
  id: string;
  name: string;
  emoji: string;
  color: string;
  position: number;
}

export interface Chore {
  id: string;
  title: string;
  emoji: string;
  minutes: number;
  per: Per;
  timesPerWeek: number;
}

export interface BoardItem {
  id: string;
  choreId: string;
  memberId: string | null;
  position: number;
  timesPerWeek: number;
}

export interface Completion {
  id: string;
  itemId: string;
  memberId: string | null;
  doneAt: number;
}

export interface Board {
  week: string; // "template" or the Monday of the week, YYYY-MM-DD
  items: BoardItem[];
  completions: Completion[];
}

export interface Announcement {
  id: string;
  authorId: string | null;
  day: string;
  text: string;
  color: string;
  createdAt: number;
}

export interface Reminder {
  id: string;
  memberId: string | null;
  createdBy: string | null;
  title: string;
  dueAt: number;
  repeat: Repeat;
  active: boolean;
}

export interface HomeData {
  household: Household;
  members: Member[];
  chores: Chore[];
  today: string;
  currentWeek: string;
  vapidPublicKey: string | null;
}

export interface WeekStats {
  week: string;
  // memberId ("" for unassigned) -> minutes
  planned: Record<string, number>;
  done: Record<string, number>;
}

export const TEMPLATE = "template";

const WEEKS_PER_MONTH = 52 / 12;

/** Rough minutes a chore takes over one week, given how often it's done. */
export function weeklyMinutes(minutes: number, per: Per, timesPerWeek: number): number {
  switch (per) {
    case "each":
      return minutes * timesPerWeek;
    case "day":
      return minutes * 7;
    case "week":
      return minutes;
    case "month":
      return minutes / WEEKS_PER_MONTH;
  }
}

/** Minutes credited for a single tick, so a fully ticked week adds up to weeklyMinutes. */
export function minutesPerCompletion(minutes: number, per: Per, timesPerWeek: number): number {
  if (timesPerWeek <= 0) return 0;
  return weeklyMinutes(minutes, per, timesPerWeek) / timesPerWeek;
}

export function defaultTimesPerWeek(per: Per): number {
  return per === "day" ? 7 : 1;
}

export function formatMinutes(total: number): string {
  const m = Math.round(total);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

export function describeEstimate(minutes: number, per: Per): string {
  const label = { each: "each time", day: "a day", week: "a week", month: "a month" }[per];
  return `${formatMinutes(minutes)} ${label}`;
}

// ---- Calendar helpers -------------------------------------------------------

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function localParts(utcMs: number, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const get = (type: string) =>
    Number(fmt.formatToParts(new Date(utcMs)).find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** Converts a wall-clock time in `timeZone` to a UTC timestamp. */
export function zonedToUtc(p: LocalParts, timeZone: string): number {
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  let guess = asUtc;
  // Two passes settle the offset, including across DST changes.
  for (let i = 0; i < 2; i++) {
    const seen = localParts(guess, timeZone);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    guess += asUtc - seenAsUtc;
  }
  return guess;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function dayKey(utcMs: number, timeZone: string): string {
  const p = localParts(utcMs, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** The Monday on or before `day`. */
export function weekOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(day, -((weekday + 6) % 7));
}

export function isWeekKey(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && weekOf(s) === s;
}

/** Next occurrence of a repeating reminder, keeping the same local wall-clock time. */
export function nextDue(dueAt: number, repeat: Repeat, timeZone: string): number | null {
  if (repeat === "none") return null;
  const p = localParts(dueAt, timeZone);
  const step = (days: number) => {
    const dt = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
    return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
  };
  let next: { year: number; month: number; day: number };
  if (repeat === "daily") next = step(1);
  else if (repeat === "weekly") next = step(7);
  else if (repeat === "monthly") {
    // Clamp to the next month's last day so the 31st doesn't spill into the month after.
    const firstOfNext = new Date(Date.UTC(p.year, p.month, 1));
    const lastDay = new Date(Date.UTC(p.year, p.month + 1, 0)).getUTCDate();
    next = {
      year: firstOfNext.getUTCFullYear(),
      month: firstOfNext.getUTCMonth() + 1,
      day: Math.min(p.day, lastDay),
    };
  } else {
    let days = 1;
    while (true) {
      const cand = step(days);
      const wd = new Date(Date.UTC(cand.year, cand.month - 1, cand.day)).getUTCDay();
      if (wd !== 0 && wd !== 6) {
        next = cand;
        break;
      }
      days++;
    }
  }
  return zonedToUtc({ ...next, hour: p.hour, minute: p.minute }, timeZone);
}
