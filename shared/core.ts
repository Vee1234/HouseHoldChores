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
  /** The emoji matching their buddy, for text-only places. */
  emoji: string;
  /** Their pixel-art buddy (see shared/pixelBuddies.ts). */
  buddy: string;
  color: string;
  position: number;
}

export interface Chore {
  id: string;
  title: string;
  emoji: string;
  minutes: number;
  per: Per;
}

/**
 * How often a chore happens. "anytime" = timesPerWeek goes on any days;
 * "days" = on the weekdays in the `days` bitmask (Monday = 1 … Sunday = 64).
 * Either way it only happens every `everyWeeks` weeks.
 */
export interface Schedule {
  kind: "anytime" | "days";
  timesPerWeek: number;
  days: number;
  everyWeeks: number;
  /** Optional time of day ("HH:MM") for chores on set days; a reminder goes out then. */
  time: string | null;
  /** Optional constraint: this chore can only be done after this other chore. */
  afterChoreId: string | null;
}

export interface Rule extends Schedule {
  id: string;
  choreId: string;
  assigneeIds: string[];
  /** The week the every-N-weeks count starts from. */
  anchorWeek: string;
  position: number;
}

export interface Template {
  id: string;
  name: string;
  rules: Rule[];
}

export interface TemplatesData {
  templates: Template[];
  /** The template in use. Switching applies from the day it's switched. */
  activeTemplateId: string | null;
}

export interface BoardItem extends Schedule {
  id: string;
  choreId: string;
  assigneeIds: string[];
  position: number;
}

export interface Completion {
  id: string;
  itemId: string;
  memberId: string | null;
  doneAt: number;
  day: string | null;
}

export interface Board {
  week: string; // the Monday of the week, YYYY-MM-DD
  templateId: string | null;
  items: BoardItem[];
  completions: Completion[];
}

export interface CalendarEntry {
  choreId: string;
  assigneeIds: string[];
  done: boolean;
}

export interface CalendarDay {
  day: string;
  entries: CalendarEntry[];
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

const WEEKS_PER_MONTH = 52 / 12;

export const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
export const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const WEEKDAYS = 0b0011111;
export const EVERY_DAY = 0b1111111;

const bitCount = (n: number) => [...n.toString(2)].filter((c) => c === "1").length;

/** How many goes a schedule has in a week it applies to. */
export function goesPerWeek(s: Pick<Schedule, "kind" | "timesPerWeek" | "days">): number {
  return s.kind === "days" ? bitCount(s.days) : s.timesPerWeek;
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function weeksBetween(fromWeek: string, toWeek: string): number {
  return Math.round((Date.parse(toWeek + "T00:00:00Z") - Date.parse(fromWeek + "T00:00:00Z")) / (7 * 86400000));
}

/** Whether an every-N-weeks schedule falls on `week`. */
export function appliesToWeek(everyWeeks: number, anchorWeek: string, week: string): boolean {
  if (everyWeeks <= 1) return true;
  const n = weeksBetween(anchorWeek, week);
  return ((n % everyWeeks) + everyWeeks) % everyWeeks === 0;
}

/** The dates a day-scheduled chore falls on in the week starting `week`. */
export function scheduledDays(days: number, week: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < 7; i++) if (days & (1 << i)) out.push(addDays(week, i));
  return out;
}

export function describeDays(days: number): string {
  if (days === EVERY_DAY) return "every day";
  if (days === WEEKDAYS) return "weekdays";
  if (days === 0b1100000) return "weekends";
  const names = DAY_SHORT.filter((_, i) => days & (1 << i));
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}` : (names[0] ?? "no days");
}

export function describeSchedule(s: Schedule): string {
  const often =
    s.kind === "days" ? describeDays(s.days) : s.timesPerWeek === 1 ? "once" : `${s.timesPerWeek}×`;
  const at = s.kind === "days" && s.time ? ` at ${formatTime(s.time)}` : "";
  if (s.everyWeeks > 1)
    return s.kind === "days" ? `every ${s.everyWeeks} weeks on ${often}${at}` : `${often} every ${s.everyWeeks} weeks`;
  return s.kind === "days" ? (s.days === EVERY_DAY ? `every day${at}` : `every ${often}${at}`) : `${often} a week`;
}

/** "19:00" -> "7pm", "07:30" -> "7:30am". */
export function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const suffix = h < 12 ? "am" : "pm";
  const hour = h % 12 || 12;
  return m ? `${hour}:${String(m).padStart(2, "0")}${suffix}` : `${hour}${suffix}`;
}

/**
 * For a chore that can only be done after another one: returns that other
 * chore's id while this go is still waiting on it, or null when it can go
 * ahead. A go on a set day waits for the other chore's go that same day (if it
 * has one); otherwise each go waits for one more go of the other chore.
 */
export function blockingChore(
  item: BoardItem,
  slotDay: string | null,
  items: BoardItem[],
  completions: Completion[],
): string | null {
  if (!item.afterChoreId) return null;
  const before = items.filter((i) => i.choreId === item.afterChoreId && i.id !== item.id);
  if (!before.length) return null;
  const doneOf = (id: string) => completions.filter((c) => c.itemId === id);
  if (slotDay) {
    const sameDay = before.find((i) => i.kind === "days" && scheduledDays(i.days, weekOf(slotDay)).includes(slotDay));
    if (sameDay) return doneOf(sameDay.id).some((c) => c.day === slotDay) ? null : item.afterChoreId;
  }
  const beforeDone = before.reduce((n, i) => n + doneOf(i.id).length, 0);
  return beforeDone > doneOf(item.id).length ? null : item.afterChoreId;
}

/**
 * Rough minutes a chore takes in a week it happens, given how often. Rates
 * ("a day", "a week", "a month") are scaled up by everyWeeks so a chore done
 * every other week carries both weeks' worth.
 */
export function weeklyMinutes(minutes: number, per: Per, goes: number, everyWeeks = 1): number {
  switch (per) {
    case "each":
      return minutes * goes;
    case "day":
      return minutes * 7 * everyWeeks;
    case "week":
      return minutes * everyWeeks;
    case "month":
      return (minutes / WEEKS_PER_MONTH) * everyWeeks;
  }
}

/** Minutes credited for a single tick, so a fully ticked week adds up to weeklyMinutes. */
export function minutesPerCompletion(minutes: number, per: Per, goes: number, everyWeeks = 1): number {
  if (goes <= 0) return 0;
  return weeklyMinutes(minutes, per, goes, everyWeeks) / goes;
}

/**
 * Who gets credit (time and treats) for a tick. A shared chore is done
 * together, so a tick by any assignee counts for all of them; anyone else
 * helping out gets the credit themselves.
 */
export function creditedMembers(tickerId: string | null, assigneeIds: string[]): string[] {
  if (!tickerId) return [];
  return assigneeIds.includes(tickerId) ? assigneeIds : [tickerId];
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
