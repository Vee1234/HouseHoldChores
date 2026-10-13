import {
  type Board,
  type CalendarDay,
  type Per,
  type Repeat,
  type Schedule,
  type WeekStats,
  addDays,
  appliesToWeek,
  blockingChore,
  formatTime,
  creditedMembers,
  dayKey,
  goesPerWeek,
  isWeekKey,
  localParts,
  minutesPerCompletion,
  nextDue,
  scheduledDays,
  weekOf,
  weekdayIndex,
  weeklyMinutes,
} from "../shared/core";
import { DEFAULT_BUDDY, buddyById, isBuddyId } from "../shared/pixelBuddies";
import { type PushMessage, type VapidKeys, sendPush } from "./push";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

interface HouseholdRow {
  id: string;
  name: string;
  join_code: string;
  timezone: string;
  active_template_id: string | null;
}

interface Ctx {
  env: Env;
  hh: HouseholdRow;
  body: any;
  url: URL;
  params: string[];
  waitUntil: (p: Promise<unknown>) => void;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const PERS: Per[] = ["each", "day", "week", "month"];
const REPEATS: Repeat[] = ["none", "daily", "weekdays", "weekly", "monthly"];
const NOTE_HOUR = 8; // future-dated announcements are pushed at 8am on the day

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const now = () => Date.now();
const uid = () => crypto.randomUUID();

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function joinCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

// ---- validation -------------------------------------------------------------

function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${field} is required`);
  return v.trim().slice(0, max);
}

function int(v: unknown, field: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${field} must be ${min}–${max}`);
  return Math.round(n);
}

function oneOf<T extends string>(v: unknown, allowed: T[], field: string): T {
  if (!allowed.includes(v as T)) throw new HttpError(400, `${field} is invalid`);
  return v as T;
}

function validTimezone(tz: unknown): string {
  try {
    if (typeof tz === "string") {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    }
  } catch {}
  return "UTC";
}

// ---- row mapping ------------------------------------------------------------

const mapMember = (r: any) => ({
  id: r.id,
  name: r.name,
  emoji: r.emoji,
  buddy: r.buddy,
  color: r.color,
  position: r.position,
});

/** Validates a buddy choice; the emoji always follows the buddy. */
function readBuddy(value: unknown, fallback = DEFAULT_BUDDY) {
  const buddy = value === undefined ? fallback : value;
  if (!isBuddyId(buddy)) throw new HttpError(400, "Unknown buddy");
  return { buddy, emoji: buddyById(buddy).emoji };
}
const mapChore = (r: any) => ({ id: r.id, title: r.title, emoji: r.emoji, minutes: r.minutes, per: r.per });
const splitIds = (ids: string | null): string[] => (ids ? ids.split(",") : []);
const mapSchedule = (r: any): Schedule => ({
  kind: r.kind,
  timesPerWeek: r.times_per_week,
  days: r.days,
  everyWeeks: r.every_weeks,
  time: r.time ?? null,
  afterChoreId: r.after_chore_id ?? null,
});
const mapItem = (r: any) => ({
  id: r.id,
  choreId: r.chore_id,
  assigneeIds: splitIds(r.assignees),
  position: r.position,
  ...mapSchedule(r),
});
const mapRule = (r: any) => ({
  id: r.id,
  choreId: r.chore_id,
  assigneeIds: splitIds(r.assignees),
  anchorWeek: r.anchor_week,
  position: r.position,
  ...mapSchedule(r),
});
const mapAnnouncement = (r: any) => ({
  id: r.id,
  authorId: r.author_id,
  day: r.day,
  text: r.text,
  color: r.color,
  createdAt: r.created_at,
});
const mapReminder = (r: any) => ({
  id: r.id,
  memberId: r.member_id,
  createdBy: r.created_by,
  title: r.title,
  dueAt: r.due_at,
  repeat: r.repeat,
  active: !!r.active,
});

// ---- helpers ----------------------------------------------------------------

const today = (hh: HouseholdRow) => dayKey(now(), hh.timezone);
const currentWeek = (hh: HouseholdRow) => weekOf(today(hh));

async function ownMember(env: Env, hh: HouseholdRow, id: unknown): Promise<string | null> {
  if (id === null || id === undefined || id === "") return null;
  const row = await env.DB.prepare("SELECT id FROM members WHERE id = ? AND household_id = ?")
    .bind(id, hh.id)
    .first();
  if (!row) throw new HttpError(400, "Unknown family member");
  return id as string;
}

// Rows with their assignees folded in as a comma-separated list.
const ITEM_COLUMNS = "bi.*, (SELECT group_concat(member_id) FROM item_assignees a WHERE a.item_id = bi.id) AS assignees";
const RULE_COLUMNS = "r.*, (SELECT group_concat(member_id) FROM rule_assignees a WHERE a.rule_id = r.id) AS assignees";

/** Every chore needs at least one person doing it. */
async function someMembers(env: Env, hh: HouseholdRow, ids: unknown): Promise<string[]> {
  const members = await ownMembers(env, hh, ids);
  if (!members.length) throw new HttpError(400, "Pick at least one person for this chore");
  return members;
}

async function ownMembers(env: Env, hh: HouseholdRow, ids: unknown): Promise<string[]> {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids)) throw new HttpError(400, "assigneeIds must be a list");
  const unique = [...new Set(ids.map(String))];
  if (!unique.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT id FROM members WHERE household_id = ? AND id IN (${unique.map(() => "?").join(",")})`,
  )
    .bind(hh.id, ...unique)
    .all();
  if (results.length !== unique.length) throw new HttpError(400, "Unknown family member");
  return unique;
}

/** Reads schedule fields from a request body, filling gaps from `fallback`. */
function readSchedule(body: any, fallback?: Schedule): Schedule {
  const kind = oneOf(body.kind ?? fallback?.kind ?? "anytime", ["anytime", "days"], "Schedule");
  const days = kind === "days" ? int(body.days ?? fallback?.days, "Days", 1, 127) : 0;
  const timesPerWeek =
    kind === "days"
      ? goesPerWeek({ kind, days, timesPerWeek: 0 })
      : int(body.timesPerWeek ?? fallback?.timesPerWeek ?? 1, "Times per week", 1, 21);
  const everyWeeks = int(body.everyWeeks ?? fallback?.everyWeeks ?? 1, "Every … weeks", 1, 12);
  const rawTime = "time" in body ? body.time : fallback?.time;
  if (rawTime && (typeof rawTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rawTime)))
    throw new HttpError(400, "Time must look like 19:30");
  // A time only makes sense for chores on set days.
  const time = kind === "days" && rawTime ? rawTime : null;
  const rawAfter = "afterChoreId" in body ? body.afterChoreId : fallback?.afterChoreId;
  const afterChoreId = rawAfter ? String(rawAfter) : null;
  return { kind, timesPerWeek, days, everyWeeks, time, afterChoreId };
}

/** Checks an "only after" constraint points at another of this household's chores. */
async function checkAfter(env: Env, hh: HouseholdRow, schedule: Schedule, choreId: string) {
  if (!schedule.afterChoreId) return;
  if (schedule.afterChoreId === choreId) throw new HttpError(400, "A chore can't wait for itself");
  const ok = await env.DB.prepare("SELECT 1 FROM chores WHERE id = ? AND household_id = ? AND archived = 0")
    .bind(schedule.afterChoreId, hh.id)
    .first();
  if (!ok) throw new HttpError(400, "Unknown chore to wait for");
}

function insertItem(
  env: Env,
  hh: HouseholdRow,
  week: string,
  item: Schedule & { choreId: string; position: number },
  assigneeIds: string[],
) {
  const id = uid();
  const statements = [
    env.DB.prepare(
      `INSERT INTO board_items (id, household_id, week, chore_id, member_id, position, times_per_week, kind, days, every_weeks, time, after_chore_id)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      hh.id,
      week,
      item.choreId,
      item.position,
      item.timesPerWeek,
      item.kind,
      item.days,
      item.everyWeeks,
      item.time,
      item.afterChoreId,
    ),
    ...assigneeIds.map((m) =>
      env.DB.prepare("INSERT INTO item_assignees (item_id, member_id) VALUES (?, ?)").bind(id, m),
    ),
  ];
  return { id, statements };
}

function replaceAssignees(env: Env, table: "item_assignees" | "rule_assignees", id: string, memberIds: string[]) {
  const col = table === "item_assignees" ? "item_id" : "rule_id";
  return [
    env.DB.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).bind(id),
    ...memberIds.map((m) => env.DB.prepare(`INSERT INTO ${table} (${col}, member_id) VALUES (?, ?)`).bind(id, m)),
  ];
}

/** Rules of a template, skipping chores that have been deleted. */
async function rulesOf(env: Env, templateId: string | null): Promise<any[]> {
  if (!templateId) return [];
  const { results } = await env.DB.prepare(
    `SELECT ${RULE_COLUMNS} FROM template_rules r JOIN chores c ON c.id = r.chore_id
     WHERE r.template_id = ? AND c.archived = 0 ORDER BY r.position`,
  )
    .bind(templateId)
    .all();
  return results;
}

/** Makes sure a week exists, copying the active template into it. Returns false for an unplanned past week. */
async function ensureWeek(env: Env, hh: HouseholdRow, week: string): Promise<boolean> {
  const existing = await env.DB.prepare("SELECT 1 FROM weeks WHERE household_id = ? AND week = ?")
    .bind(hh.id, week)
    .first();
  if (existing) return true;
  if (week < currentWeek(hh)) return false;
  const res = await env.DB.prepare(
    "INSERT OR IGNORE INTO weeks (household_id, week, modified, created_at, template_id) VALUES (?, ?, 0, ?, ?)",
  )
    .bind(hh.id, week, now(), hh.active_template_id)
    .run();
  // Another request may have copied this week at the same moment.
  if (res.meta.changes === 0) return true;
  const rules = (await rulesOf(env, hh.active_template_id)).filter((r) => appliesToWeek(r.every_weeks, r.anchor_week, week));
  const statements = rules.flatMap(
    (r) => insertItem(env, hh, week, { choreId: r.chore_id, position: r.position, ...mapSchedule(r) }, splitIds(r.assignees)).statements,
  );
  if (statements.length) await env.DB.batch(statements);
  return true;
}

/**
 * Keeps the board in step with the template in use: after a change, every
 * planned week from this one on follows it (for the given chores, or all).
 */
async function templateChanged(env: Env, hh: HouseholdRow, templateId: string, choreIds?: string[]) {
  if (templateId !== hh.active_template_id) return;
  await syncPlannedWeeks(env, hh, await rulesOf(env, templateId), choreIds ? new Set(choreIds) : undefined);
}

async function syncPlannedWeeks(env: Env, hh: HouseholdRow, rules: any[], onlyChores?: Set<string>) {
  const { results } = await env.DB.prepare("SELECT week FROM weeks WHERE household_id = ? AND week >= ? ORDER BY week")
    .bind(hh.id, currentWeek(hh))
    .all<{ week: string }>();
  for (const { week } of results) await syncWeekToRules(env, hh, week, rules, onlyChores);
}

async function markWeekModified(env: Env, hh: HouseholdRow, week: string) {
  await env.DB.prepare("UPDATE weeks SET modified = 1 WHERE household_id = ? AND week = ?").bind(hh.id, week).run();
}

async function loadBoard(env: Env, hh: HouseholdRow, week: string): Promise<Board> {
  const [weekRow, items, completions] = await env.DB.batch([
    env.DB.prepare("SELECT template_id FROM weeks WHERE household_id = ? AND week = ?").bind(hh.id, week),
    env.DB.prepare(`SELECT ${ITEM_COLUMNS} FROM board_items bi WHERE bi.household_id = ? AND bi.week = ? ORDER BY bi.position`).bind(
      hh.id,
      week,
    ),
    env.DB.prepare(
      `SELECT c.* FROM completions c JOIN board_items bi ON bi.id = c.item_id
       WHERE bi.household_id = ? AND bi.week = ? ORDER BY c.done_at`,
    ).bind(hh.id, week),
  ]);
  return {
    week,
    templateId: (weekRow.results[0] as any)?.template_id ?? null,
    items: items.results.map(mapItem),
    completions: completions.results.map((r: any) => ({
      id: r.id,
      itemId: r.item_id,
      memberId: r.member_id,
      doneAt: r.done_at,
      day: r.day,
    })),
  };
}

async function itemOf(env: Env, hh: HouseholdRow, id: string) {
  const row = await env.DB.prepare(`SELECT ${ITEM_COLUMNS} FROM board_items bi WHERE bi.id = ? AND bi.household_id = ?`)
    .bind(id, hh.id)
    .first<any>();
  if (!row) throw new HttpError(404, "That chore isn't on the board any more");
  return row;
}

function boardWeek(param: string): string {
  if (isWeekKey(param)) return param;
  throw new HttpError(400, "Week must be a Monday (YYYY-MM-DD)");
}

async function templateOf(env: Env, hh: HouseholdRow, id: string) {
  const row = await env.DB.prepare("SELECT * FROM templates WHERE id = ? AND household_id = ?").bind(id, hh.id).first<any>();
  if (!row) throw new HttpError(404, "Template not found");
  return row;
}

async function ruleOf(env: Env, hh: HouseholdRow, id: string) {
  const row = await env.DB.prepare(
    `SELECT ${RULE_COLUMNS} FROM template_rules r JOIN templates t ON t.id = r.template_id
     WHERE r.id = ? AND t.household_id = ?`,
  )
    .bind(id, hh.id)
    .first<any>();
  if (!row) throw new HttpError(404, "That rule doesn't exist any more");
  return row;
}

/**
 * Brings one planned week in line with a set of template rules, from today on.
 * What has already happened stays: this week's days that have passed, and any
 * go already ticked. Everything else for the chores in scope follows the rules,
 * including who's on them. Other chores (and any one-off tweaks to them) are
 * left alone when `onlyChores` is given.
 */
async function syncWeekToRules(env: Env, hh: HouseholdRow, week: string, rules: any[], onlyChores?: Set<string>) {
  const before = week === currentWeek(hh) ? (1 << weekdayIndex(today(hh))) - 1 : 0; // days already gone
  const board = await loadBoard(env, hh, week);
  const doneByItem = new Map<string, { count: number; days: number }>();
  for (const c of board.completions) {
    const d = doneByItem.get(c.itemId) ?? { count: 0, days: 0 };
    d.count++;
    if (c.day) d.days |= 1 << weekdayIndex(c.day);
    doneByItem.set(c.itemId, d);
  }
  const ruleByChore = new Map(
    rules.filter((r) => appliesToWeek(r.every_weeks, r.anchor_week, week)).map((r) => [r.chore_id as string, r]),
  );
  const inScope = (choreId: string) => !onlyChores || onlyChores.has(choreId);
  const countDays = (days: number) => goesPerWeek({ kind: "days", days, timesPerWeek: 0 });
  const statements: D1PreparedStatement[] = [];
  const del = (id: string) => statements.push(env.DB.prepare("DELETE FROM board_items WHERE id = ?").bind(id));
  const handled = new Set<string>();

  for (const item of board.items) {
    if (!inScope(item.choreId)) continue;
    const done = doneByItem.get(item.id) ?? { count: 0, days: 0 };
    const keptDays = item.kind === "days" ? item.days & (before | done.days) : 0;
    // One card per chore: a second card for the same chore is treated as having no rule.
    const rule = handled.has(item.choreId) ? undefined : ruleByChore.get(item.choreId);

    if (!rule) {
      // Not in the template (for this week): keep only what's already happened.
      if (item.kind === "days" && keptDays)
        statements.push(
          env.DB.prepare("UPDATE board_items SET days = ?, times_per_week = ? WHERE id = ?").bind(keptDays, countDays(keptDays), item.id),
        );
      else if (item.kind === "anytime" && done.count)
        statements.push(env.DB.prepare("UPDATE board_items SET times_per_week = ? WHERE id = ?").bind(done.count, item.id));
      else del(item.id);
      continue;
    }

    handled.add(item.choreId);
    const s = mapSchedule(rule);
    let days = 0;
    let times: number;
    if (s.kind === "days") {
      days = keptDays | (s.days & ~before);
      times = countDays(days);
      if (!days) {
        if (done.count) continue; // ticked but nothing left to plan: leave the card as it was
        del(item.id);
        continue;
      }
    } else times = Math.max(s.timesPerWeek, done.count);
    statements.push(
      env.DB.prepare(
        "UPDATE board_items SET kind = ?, days = ?, times_per_week = ?, every_weeks = ?, time = ?, after_chore_id = ? WHERE id = ?",
      ).bind(s.kind, days, times, s.everyWeeks, s.time, s.afterChoreId, item.id),
      ...replaceAssignees(env, "item_assignees", item.id, splitIds(rule.assignees)),
    );
  }

  // Chores in the template that this week doesn't have yet.
  for (const [choreId, rule] of ruleByChore) {
    if (!inScope(choreId) || handled.has(choreId)) continue;
    const s = mapSchedule(rule);
    if (s.kind === "days") {
      s.days &= ~before;
      if (!s.days) continue;
      s.timesPerWeek = countDays(s.days);
    }
    statements.push(...insertItem(env, hh, week, { choreId, position: rule.position, ...s }, splitIds(rule.assignees)).statements);
  }
  if (statements.length) await env.DB.batch(statements);
}

// ---- push -------------------------------------------------------------------

function vapidKeys(env: Env): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || "mailto:cosy-chores@example.com",
  };
}

/** Pushes to one member, or everyone when memberId is null, optionally skipping someone. */
async function notify(
  env: Env,
  householdId: string,
  memberId: string | null,
  message: PushMessage,
  skipMemberId?: string | null,
) {
  const vapid = vapidKeys(env);
  if (!vapid) return;
  const { results } = await env.DB.prepare(
    `SELECT * FROM push_subscriptions WHERE household_id = ?1
       AND (?2 IS NULL OR member_id = ?2) AND (?3 IS NULL OR member_id != ?3)`,
  )
    .bind(householdId, memberId, skipMemberId ?? null)
    .all<any>();
  await Promise.all(
    results.map(async (sub) => {
      const outcome = await sendPush(sub, message, vapid).catch((e) => {
        console.error("push error", e);
        return "error" as const;
      });
      if (outcome === "gone")
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(sub.endpoint).run();
    }),
  );
}

/**
 * After a tick: anyone whose chore was waiting on this one hears they can
 * start, if that tick is what freed their next go.
 */
async function notifyUnblocked(env: Env, hh: HouseholdRow, board: Board, completion: Board["completions"][number]) {
  const done = board.items.find((i) => i.id === completion.itemId);
  if (!done) return;
  const after = { ...board, completions: [...board.completions, completion] };
  const chores = new Map(
    ((await env.DB.prepare("SELECT id, title, emoji FROM chores WHERE household_id = ?").bind(hh.id).all<any>()).results).map(
      (c) => [c.id, c],
    ),
  );
  for (const waiting of board.items.filter((i) => i.afterChoreId === done.choreId)) {
    const day = waiting.kind === "days" ? completion.day : null;
    if (waiting.kind === "days" && !(day && scheduledDays(waiting.days, board.week).includes(day))) continue;
    const wasBlocked = blockingChore(waiting, day, board.items, board.completions);
    const nowBlocked = blockingChore(waiting, day, after.items, after.completions);
    if (!wasBlocked || nowBlocked) continue;
    const doneChore = chores.get(done.choreId);
    const next = chores.get(waiting.choreId);
    for (const memberId of waiting.assigneeIds) {
      if (memberId === completion.memberId) continue;
      await notify(env, hh.id, memberId, {
        title: `✅ ${doneChore?.emoji ?? ""} ${doneChore?.title ?? "A chore"} is done`,
        body: `You can start ${next?.emoji ?? ""} ${next?.title ?? "your chore"} now.`,
        url: "/?tab=chores",
        tag: `unblocked-${waiting.id}-${day ?? ""}`,
      });
    }
  }
}

// ---- routes -----------------------------------------------------------------

type Handler = (c: Ctx) => Promise<Response>;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, path: string, handler: Handler) =>
  routes.push([method, new RegExp("^" + path.replace(/:\w+/g, "([^/]+)") + "$"), handler]);

route("GET", "/api/home", async ({ env, hh }) => {
  const [members, chores] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM members WHERE household_id = ? ORDER BY position, created_at").bind(hh.id),
    env.DB.prepare("SELECT * FROM chores WHERE household_id = ? AND archived = 0 ORDER BY title").bind(hh.id),
  ]);
  return json({
    household: { id: hh.id, name: hh.name, joinCode: hh.join_code, timezone: hh.timezone },
    members: members.results.map(mapMember),
    chores: chores.results.map(mapChore),
    today: today(hh),
    currentWeek: currentWeek(hh),
    vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
  });
});

route("PATCH", "/api/household", async ({ env, hh, body }) => {
  const name = body.name !== undefined ? str(body.name, "Name", 60) : hh.name;
  const tz = body.timezone !== undefined ? validTimezone(body.timezone) : hh.timezone;
  await env.DB.prepare("UPDATE households SET name = ?, timezone = ? WHERE id = ?").bind(name, tz, hh.id).run();
  return json({ ok: true });
});

// Members

route("POST", "/api/members", async ({ env, hh, body }) => {
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE household_id = ?")
    .bind(hh.id)
    .first<number>("n");
  if ((count ?? 0) >= 20) throw new HttpError(400, "That's a big family! 20 members max.");
  const member = {
    id: uid(),
    name: str(body.name, "Name", 40),
    ...readBuddy(body.buddy),
    color: str(body.color, "Colour", 20),
    position: count ?? 0,
  };
  await env.DB.prepare(
    "INSERT INTO members (id, household_id, name, emoji, buddy, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(member.id, hh.id, member.name, member.emoji, member.buddy, member.color, member.position, now())
    .run();
  return json(member, 201);
});

route("PATCH", "/api/members/:id", async ({ env, hh, body, params }) => {
  const row = await env.DB.prepare("SELECT * FROM members WHERE id = ? AND household_id = ?")
    .bind(params[0], hh.id)
    .first<any>();
  if (!row) throw new HttpError(404, "Member not found");
  const { buddy, emoji } = readBuddy(body.buddy, row.buddy);
  await env.DB.prepare("UPDATE members SET name = ?, emoji = ?, buddy = ?, color = ? WHERE id = ?")
    .bind(
      body.name !== undefined ? str(body.name, "Name", 40) : row.name,
      emoji,
      buddy,
      body.color !== undefined ? str(body.color, "Colour", 20) : row.color,
      row.id,
    )
    .run();
  return json({ ok: true });
});

route("DELETE", "/api/members/:id", async ({ env, hh, params }) => {
  await env.DB.prepare("DELETE FROM members WHERE id = ? AND household_id = ?").bind(params[0], hh.id).run();
  return json({ ok: true });
});

// Buddy treats: one earned per go you get credit for, minus the ones already eaten.

// Completions credited to member ?1: ones they ticked, plus ones ticked by a
// fellow assignee of a shared chore they're on (see creditedMembers).
const EARNED_SQL = `(SELECT COUNT(*) FROM completions c JOIN board_items bi ON bi.id = c.item_id
  WHERE c.member_id = ?1 OR (
    EXISTS (SELECT 1 FROM item_assignees a WHERE a.item_id = bi.id AND a.member_id = ?1) AND
    EXISTS (SELECT 1 FROM item_assignees a WHERE a.item_id = bi.id AND a.member_id = c.member_id)))`;

async function treatsFor(env: Env, hh: HouseholdRow, memberId: string) {
  const row = await env.DB.prepare(`SELECT treats_fed AS fed, ${EARNED_SQL} AS earned FROM members WHERE id = ?1 AND household_id = ?2`)
    .bind(memberId, hh.id)
    .first<{ fed: number; earned: number }>();
  if (!row) throw new HttpError(404, "Member not found");
  // Unticking a go takes its treat back, but never below zero.
  return { treats: Math.max(0, row.earned - row.fed) };
}

route("GET", "/api/members/:id/buddy", async ({ env, hh, params }) => json(await treatsFor(env, hh, params[0])));

route("POST", "/api/members/:id/feed", async ({ env, hh, params }) => {
  // Only eats a treat if one is actually available, so double taps can't overspend.
  const res = await env.DB.prepare(
    `UPDATE members SET treats_fed = treats_fed + 1 WHERE id = ?1 AND household_id = ?2 AND treats_fed < ${EARNED_SQL}`,
  )
    .bind(params[0], hh.id)
    .run();
  if (!res.meta.changes) throw new HttpError(400, "No treats yet — finish a chore to earn one 🍪");
  return json(await treatsFor(env, hh, params[0]));
});

// Chore library: just the chore itself. How often and who live on rules and week items.

route("POST", "/api/chores", async ({ env, hh, body }) => {
  const chore = {
    id: uid(),
    title: str(body.title, "Chore name", 80),
    emoji: str(body.emoji ?? "🧹", "Emoji", 16),
    minutes: int(body.minutes, "Minutes", 1, 6000),
    per: oneOf(body.per, PERS, "Time estimate"),
  };
  await env.DB.prepare(
    "INSERT INTO chores (id, household_id, title, emoji, minutes, per, times_per_week, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
  )
    .bind(chore.id, hh.id, chore.title, chore.emoji, chore.minutes, chore.per, now())
    .run();
  return json(chore, 201);
});

route("PATCH", "/api/chores/:id", async ({ env, hh, body, params }) => {
  const row = await env.DB.prepare("SELECT * FROM chores WHERE id = ? AND household_id = ?")
    .bind(params[0], hh.id)
    .first<any>();
  if (!row) throw new HttpError(404, "Chore not found");
  await env.DB.prepare("UPDATE chores SET title = ?, emoji = ?, minutes = ?, per = ? WHERE id = ?")
    .bind(
      body.title !== undefined ? str(body.title, "Chore name", 80) : row.title,
      body.emoji !== undefined ? str(body.emoji, "Emoji", 16) : row.emoji,
      body.minutes !== undefined ? int(body.minutes, "Minutes", 1, 6000) : row.minutes,
      body.per !== undefined ? oneOf(body.per, PERS, "Time estimate") : row.per,
      row.id,
    )
    .run();
  return json({ ok: true });
});

// Deleting a chore keeps past weeks' history but removes it from every template and from this week on.
route("DELETE", "/api/chores/:id", async ({ env, hh, params }) => {
  const cw = currentWeek(hh);
  await env.DB.batch([
    env.DB.prepare("UPDATE chores SET archived = 1 WHERE id = ? AND household_id = ?").bind(params[0], hh.id),
    env.DB.prepare(
      "DELETE FROM template_rules WHERE chore_id = ? AND template_id IN (SELECT id FROM templates WHERE household_id = ?)",
    ).bind(params[0], hh.id),
    env.DB.prepare("DELETE FROM board_items WHERE chore_id = ? AND household_id = ? AND week >= ?").bind(params[0], hh.id, cw),
  ]);
  return json({ ok: true });
});

// Week boards

route("GET", "/api/board/:week", async ({ env, hh, params }) => {
  const week = boardWeek(params[0]);
  const exists = await ensureWeek(env, hh, week);
  if (!exists) return json({ week, templateId: null, items: [], completions: [] } satisfies Board);
  return json(await loadBoard(env, hh, week));
});

route("POST", "/api/board/:week/items", async ({ env, hh, body, params }) => {
  const week = boardWeek(params[0]);
  if (!(await ensureWeek(env, hh, week))) throw new HttpError(400, "That week has already passed");
  const chore = await env.DB.prepare("SELECT id FROM chores WHERE id = ? AND household_id = ? AND archived = 0")
    .bind(body.choreId, hh.id)
    .first<any>();
  if (!chore) throw new HttpError(400, "Unknown chore");
  // Without a schedule given, use what the active template says for this chore.
  const rule = (await rulesOf(env, hh.active_template_id)).find((r) => r.chore_id === chore.id);
  const schedule = readSchedule(body, rule ? mapSchedule(rule) : undefined);
  await checkAfter(env, hh, schedule, chore.id);
  const assigneeIds = await someMembers(env, hh, body.assigneeIds);
  const maxPos = await env.DB.prepare(
    "SELECT COALESCE(MAX(position), 0) AS p FROM board_items WHERE household_id = ? AND week = ?",
  )
    .bind(hh.id, week)
    .first<number>("p");
  const position = (maxPos ?? 0) + 1;
  const { id, statements } = insertItem(env, hh, week, { choreId: chore.id, position, ...schedule }, assigneeIds);
  await env.DB.batch(statements);
  await markWeekModified(env, hh, week);
  return json({ id, choreId: chore.id, assigneeIds, position, ...schedule }, 201);
});

route("PATCH", "/api/items/:id", async ({ env, hh, body, params }) => {
  const row = await itemOf(env, hh, params[0]);
  const position = body.position !== undefined ? Number(body.position) : row.position;
  if (!Number.isFinite(position)) throw new HttpError(400, "Bad position");
  const touchesSchedule = ["kind", "timesPerWeek", "days", "everyWeeks", "time", "afterChoreId"].some((k) => k in body);
  const schedule = touchesSchedule ? readSchedule(body, mapSchedule(row)) : mapSchedule(row);
  await checkAfter(env, hh, schedule, row.chore_id);
  const statements = [
    env.DB.prepare(
      "UPDATE board_items SET position = ?, kind = ?, times_per_week = ?, days = ?, every_weeks = ?, time = ?, after_chore_id = ? WHERE id = ?",
    ).bind(position, schedule.kind, schedule.timesPerWeek, schedule.days, schedule.everyWeeks, schedule.time, schedule.afterChoreId, row.id),
  ];
  if ("assigneeIds" in body)
    statements.push(...replaceAssignees(env, "item_assignees", row.id, await someMembers(env, hh, body.assigneeIds)));
  await env.DB.batch(statements);
  await markWeekModified(env, hh, row.week);
  return json({ ok: true });
});

route("DELETE", "/api/items/:id", async ({ env, hh, params }) => {
  const row = await itemOf(env, hh, params[0]);
  await env.DB.prepare("DELETE FROM board_items WHERE id = ?").bind(row.id).run();
  await markWeekModified(env, hh, row.week);
  return json({ ok: true });
});

route("POST", "/api/items/:id/completions", async ({ env, hh, body, params, waitUntil }) => {
  const row = await itemOf(env, hh, params[0]);
  const lastDay = addDays(row.week, 6);
  let day: string;
  if (typeof body.day === "string") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.day) || body.day < row.week || body.day > lastDay)
      throw new HttpError(400, "That day isn't in this chore's week");
    day = body.day;
  } else {
    // Ticking an "any time" chore counts for today, or the nearest day of that week.
    const t = today(hh);
    day = t < row.week ? row.week : t > lastDay ? lastDay : t;
  }
  const board = await loadBoard(env, hh, row.week);
  const item = board.items.find((i) => i.id === row.id)!;
  const waitingOn = blockingChore(item, item.kind === "days" ? day : null, board.items, board.completions);
  if (waitingOn) {
    const other = await env.DB.prepare("SELECT title FROM chores WHERE id = ?").bind(waitingOn).first<any>();
    throw new HttpError(409, `Waiting for “${other?.title ?? "another chore"}” to be done first`);
  }
  const completion = { id: uid(), itemId: row.id, memberId: await ownMember(env, hh, body.memberId), doneAt: now(), day };
  await env.DB.prepare("INSERT INTO completions (id, item_id, member_id, done_at, day) VALUES (?, ?, ?, ?, ?)")
    .bind(completion.id, completion.itemId, completion.memberId, completion.doneAt, completion.day)
    .run();
  await markWeekModified(env, hh, row.week);
  waitUntil(notifyUnblocked(env, hh, board, { ...completion }));
  return json(completion, 201);
});

route("DELETE", "/api/completions/:id", async ({ env, hh, params }) => {
  await env.DB.prepare(
    "DELETE FROM completions WHERE id = ? AND item_id IN (SELECT id FROM board_items WHERE household_id = ?)",
  )
    .bind(params[0], hh.id)
    .run();
  return json({ ok: true });
});

// Throws away a week's plan (and its ticks) and re-copies the active template.
route("POST", "/api/board/:week/reset", async ({ env, hh, params }) => {
  const week = boardWeek(params[0]);
  if (week < currentWeek(hh)) throw new HttpError(400, "Only this week or later can be reset");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM board_items WHERE household_id = ? AND week = ?").bind(hh.id, week),
    env.DB.prepare("DELETE FROM weeks WHERE household_id = ? AND week = ?").bind(hh.id, week),
  ]);
  await ensureWeek(env, hh, week);
  return json(await loadBoard(env, hh, week));
});

// Replaces a template's rules with this week's chores.
route("POST", "/api/board/:week/save-to-template", async ({ env, hh, body, params }) => {
  const week = boardWeek(params[0]);
  const template = await templateOf(env, hh, String(body.templateId ?? hh.active_template_id ?? ""));
  const board = await loadBoard(env, hh, week);
  // A template has one rule per chore; repeats of a chore merge their people.
  const byChore = new Map<string, (typeof board.items)[number]>();
  for (const item of board.items) {
    const seen = byChore.get(item.choreId);
    if (seen) seen.assigneeIds = [...new Set([...seen.assigneeIds, ...item.assigneeIds])];
    else byChore.set(item.choreId, { ...item });
  }
  const statements = [env.DB.prepare("DELETE FROM template_rules WHERE template_id = ?").bind(template.id)];
  for (const item of byChore.values()) {
    const ruleId = uid();
    statements.push(
      env.DB.prepare(
        `INSERT INTO template_rules (id, template_id, chore_id, kind, times_per_week, days, every_weeks, anchor_week, position, time, after_chore_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        ruleId,
        template.id,
        item.choreId,
        item.kind,
        item.timesPerWeek,
        item.days,
        item.everyWeeks,
        week,
        item.position,
        item.time,
        item.afterChoreId,
      ),
      ...item.assigneeIds.map((m) => env.DB.prepare("INSERT INTO rule_assignees (rule_id, member_id) VALUES (?, ?)").bind(ruleId, m)),
    );
  }
  await env.DB.batch(statements);
  await templateChanged(env, hh, template.id);
  return json({ ok: true });
});

// Templates and their rules

route("GET", "/api/templates", async ({ env, hh }) => {
  const [templates, rules] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM templates WHERE household_id = ? ORDER BY created_at").bind(hh.id),
    env.DB.prepare(
      `SELECT ${RULE_COLUMNS} FROM template_rules r JOIN templates t ON t.id = r.template_id JOIN chores c ON c.id = r.chore_id
       WHERE t.household_id = ? AND c.archived = 0 ORDER BY r.position`,
    ).bind(hh.id),
  ]);
  return json({
    templates: templates.results.map((t: any) => ({
      id: t.id,
      name: t.name,
      rules: (rules.results as any[]).filter((r) => r.template_id === t.id).map(mapRule),
    })),
    activeTemplateId: hh.active_template_id,
  });
});

route("POST", "/api/templates", async ({ env, hh, body }) => {
  const id = uid();
  const name = str(body.name, "Template name", 60);
  const statements = [
    env.DB.prepare("INSERT INTO templates (id, household_id, name, created_at) VALUES (?, ?, ?, ?)").bind(id, hh.id, name, now()),
  ];
  if (body.copyFromId) {
    const source = await templateOf(env, hh, String(body.copyFromId));
    for (const r of await rulesOf(env, source.id)) {
      const ruleId = uid();
      statements.push(
        env.DB.prepare(
          `INSERT INTO template_rules (id, template_id, chore_id, kind, times_per_week, days, every_weeks, anchor_week, position, time, after_chore_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(ruleId, id, r.chore_id, r.kind, r.times_per_week, r.days, r.every_weeks, r.anchor_week, r.position, r.time, r.after_chore_id),
        ...splitIds(r.assignees).map((m) =>
          env.DB.prepare("INSERT INTO rule_assignees (rule_id, member_id) VALUES (?, ?)").bind(ruleId, m),
        ),
      );
    }
  }
  await env.DB.batch(statements);
  return json({ id, name, rules: [] }, 201);
});

route("PATCH", "/api/templates/:id", async ({ env, hh, body, params }) => {
  const t = await templateOf(env, hh, params[0]);
  await env.DB.prepare("UPDATE templates SET name = ? WHERE id = ?").bind(str(body.name, "Template name", 60), t.id).run();
  return json({ ok: true });
});

route("DELETE", "/api/templates/:id", async ({ env, hh, params }) => {
  const t = await templateOf(env, hh, params[0]);
  if (t.id === hh.active_template_id) throw new HttpError(400, "That's the template in use — switch to another one first");
  await env.DB.prepare("DELETE FROM templates WHERE id = ?").bind(t.id).run();
  return json({ ok: true });
});

// Switching applies from today: planned weeks follow the new template from here on.
route("POST", "/api/templates/:id/activate", async ({ env, hh, params }) => {
  const t = await templateOf(env, hh, params[0]);
  if (t.id === hh.active_template_id) return json({ ok: true });
  // This week must exist under the old template first, so the days already gone keep it.
  await ensureWeek(env, hh, currentWeek(hh));
  await syncPlannedWeeks(env, hh, await rulesOf(env, t.id));
  await env.DB.batch([
    env.DB.prepare("UPDATE households SET active_template_id = ? WHERE id = ?").bind(t.id, hh.id),
    env.DB.prepare("UPDATE weeks SET template_id = ? WHERE household_id = ? AND week >= ?").bind(t.id, hh.id, currentWeek(hh)),
  ]);
  return json({ ok: true });
});

route("POST", "/api/templates/:id/rules", async ({ env, hh, body, params }) => {
  const t = await templateOf(env, hh, params[0]);
  const chore = await env.DB.prepare("SELECT id FROM chores WHERE id = ? AND household_id = ? AND archived = 0")
    .bind(body.choreId, hh.id)
    .first<any>();
  if (!chore) throw new HttpError(400, "Unknown chore");
  const taken = await env.DB.prepare("SELECT 1 FROM template_rules WHERE template_id = ? AND chore_id = ?")
    .bind(t.id, chore.id)
    .first();
  if (taken) throw new HttpError(409, "That chore is already in this template — edit it instead");
  const schedule = readSchedule(body);
  await checkAfter(env, hh, schedule, chore.id);
  const anchorWeek = typeof body.anchorWeek === "string" && isWeekKey(body.anchorWeek) ? body.anchorWeek : currentWeek(hh);
  const assigneeIds = await someMembers(env, hh, body.assigneeIds);
  const maxPos = await env.DB.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM template_rules WHERE template_id = ?")
    .bind(t.id)
    .first<number>("p");
  const id = uid();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO template_rules (id, template_id, chore_id, kind, times_per_week, days, every_weeks, anchor_week, position, time, after_chore_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      t.id,
      chore.id,
      schedule.kind,
      schedule.timesPerWeek,
      schedule.days,
      schedule.everyWeeks,
      anchorWeek,
      (maxPos ?? 0) + 1,
      schedule.time,
      schedule.afterChoreId,
    ),
    ...assigneeIds.map((m) => env.DB.prepare("INSERT INTO rule_assignees (rule_id, member_id) VALUES (?, ?)").bind(id, m)),
  ]);
  await templateChanged(env, hh, t.id, [chore.id]);
  return json({ id, choreId: chore.id, assigneeIds, anchorWeek, position: (maxPos ?? 0) + 1, ...schedule }, 201);
});

route("PATCH", "/api/rules/:id", async ({ env, hh, body, params }) => {
  const row = await ruleOf(env, hh, params[0]);
  const schedule = readSchedule(body, mapSchedule(row));
  await checkAfter(env, hh, schedule, row.chore_id);
  const anchorWeek = typeof body.anchorWeek === "string" && isWeekKey(body.anchorWeek) ? body.anchorWeek : row.anchor_week;
  const position = body.position !== undefined ? Number(body.position) : row.position;
  if (!Number.isFinite(position)) throw new HttpError(400, "Bad position");
  const statements = [
    env.DB.prepare(
      "UPDATE template_rules SET kind = ?, times_per_week = ?, days = ?, every_weeks = ?, anchor_week = ?, position = ?, time = ?, after_chore_id = ? WHERE id = ?",
    ).bind(schedule.kind, schedule.timesPerWeek, schedule.days, schedule.everyWeeks, anchorWeek, position, schedule.time, schedule.afterChoreId, row.id),
  ];
  if ("assigneeIds" in body)
    statements.push(...replaceAssignees(env, "rule_assignees", row.id, await someMembers(env, hh, body.assigneeIds)));
  await env.DB.batch(statements);
  await templateChanged(env, hh, row.template_id, [row.chore_id]);
  return json({ ok: true });
});

route("DELETE", "/api/rules/:id", async ({ env, hh, params }) => {
  const row = await ruleOf(env, hh, params[0]);
  await env.DB.prepare("DELETE FROM template_rules WHERE id = ?").bind(row.id).run();
  await templateChanged(env, hh, row.template_id, [row.chore_id]);
  return json({ ok: true });
});

// Calendar: what's on each day. Weeks that exist come from their copy; upcoming
// weeks nobody has opened are previewed from the active template without creating them.

route("GET", "/api/calendar", async ({ env, hh, url }) => {
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from || to > addDays(from, 62))
    throw new HttpError(400, "Pick a range of up to two months");
  const firstWeek = weekOf(from);
  const lastWeek = weekOf(to);
  const cw = currentWeek(hh);
  const [weeks, items, completions] = await env.DB.batch([
    env.DB.prepare("SELECT week FROM weeks WHERE household_id = ? AND week BETWEEN ? AND ?").bind(hh.id, firstWeek, lastWeek),
    env.DB.prepare(`SELECT ${ITEM_COLUMNS} FROM board_items bi WHERE bi.household_id = ? AND bi.week BETWEEN ? AND ?`).bind(
      hh.id,
      firstWeek,
      lastWeek,
    ),
    env.DB.prepare(
      `SELECT c.item_id, c.day FROM completions c JOIN board_items bi ON bi.id = c.item_id
       WHERE bi.household_id = ? AND bi.week BETWEEN ? AND ?`,
    ).bind(hh.id, firstWeek, lastWeek),
  ]);
  const existing = new Set((weeks.results as any[]).map((w) => w.week));
  const doneDays = new Map<string, Set<string>>();
  for (const c of completions.results as any[]) {
    if (!doneDays.has(c.item_id)) doneDays.set(c.item_id, new Set());
    if (c.day) doneDays.get(c.item_id)!.add(c.day);
  }
  const rules = await rulesOf(env, hh.active_template_id);

  const byDay = new Map<string, CalendarDay["entries"]>();
  const add = (day: string, entry: CalendarDay["entries"][number]) => {
    if (day < from || day > to) return;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(entry);
  };
  for (let week = firstWeek; week <= lastWeek; week = addDays(week, 7)) {
    if (existing.has(week)) {
      for (const item of (items.results as any[]).filter((i) => i.week === week)) {
        const done = doneDays.get(item.id) ?? new Set<string>();
        const assigneeIds = splitIds(item.assignees);
        if (item.kind === "days")
          for (const day of scheduledDays(item.days, week)) add(day, { choreId: item.chore_id, assigneeIds, done: done.has(day) });
        // "Any time" chores show up on the days they were actually done.
        else for (const day of done) add(day, { choreId: item.chore_id, assigneeIds, done: true });
      }
    } else if (week >= cw) {
      for (const r of rules)
        if (r.kind === "days" && appliesToWeek(r.every_weeks, r.anchor_week, week))
          for (const day of scheduledDays(r.days, week))
            add(day, { choreId: r.chore_id, assigneeIds: splitIds(r.assignees), done: false });
    }
  }
  const days: CalendarDay[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push({ day, entries: byDay.get(day) ?? [] });
  return json(days);
});

// Stats

route("GET", "/api/stats", async ({ env, hh, url }) => {
  const count = int(url.searchParams.get("weeks") ?? 6, "weeks", 1, 26);
  const last = currentWeek(hh);
  const first = addDays(last, -7 * (count - 1));
  const [items, completions] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ${ITEM_COLUMNS}, c.minutes, c.per FROM board_items bi JOIN chores c ON c.id = bi.chore_id
       WHERE bi.household_id = ? AND bi.week BETWEEN ? AND ?`,
    ).bind(hh.id, first, last),
    env.DB.prepare(
      `SELECT co.member_id AS ticker, bi.week, bi.kind, bi.times_per_week, bi.days, bi.every_weeks, c.minutes, c.per,
         (SELECT group_concat(member_id) FROM item_assignees a WHERE a.item_id = bi.id) AS assignees
       FROM completions co JOIN board_items bi ON bi.id = co.item_id JOIN chores c ON c.id = bi.chore_id
       WHERE bi.household_id = ? AND bi.week BETWEEN ? AND ?`,
    ).bind(hh.id, first, last),
  ]);
  const weeks: WeekStats[] = [];
  for (let w = first; w <= last; w = addDays(w, 7)) weeks.push({ week: w, planned: {}, done: {} });
  const byWeek = new Map(weeks.map((w) => [w.week, w]));
  const add = (bucket: Record<string, number>, key: string, mins: number) => {
    bucket[key] = (bucket[key] ?? 0) + mins;
  };
  for (const r of items.results as any[]) {
    const mins = weeklyMinutes(r.minutes, r.per, goesPerWeek(mapSchedule(r)), r.every_weeks);
    const assignees = splitIds(r.assignees);
    // Shared chores are done together, so each person spends the full time.
    for (const m of assignees.length ? assignees : [""]) add(byWeek.get(r.week)!.planned, m, mins);
  }
  for (const r of completions.results as any[]) {
    const mins = minutesPerCompletion(r.minutes, r.per, goesPerWeek(mapSchedule(r)), r.every_weeks);
    for (const m of creditedMembers(r.ticker, splitIds(r.assignees))) add(byWeek.get(r.week)!.done, m, mins);
  }
  return json(weeks);
});

// Announcements

route("GET", "/api/announcements", async ({ env, hh, url }) => {
  const day = url.searchParams.get("day") ?? today(hh);
  const { results } = await env.DB.prepare(
    "SELECT * FROM announcements WHERE household_id = ? AND day = ? ORDER BY created_at",
  )
    .bind(hh.id, day)
    .all();
  return json(results.map(mapAnnouncement));
});

/** " for tomorrow" / " for Fri 16 Oct", or nothing for today. */
function noteDayLabel(day: string, todayKey: string): string {
  if (day === todayKey) return "";
  if (day === addDays(todayKey, 1)) return " for tomorrow";
  const label = new Date(day + "T00:00:00Z").toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  return ` for ${label}`;
}

route("POST", "/api/announcements", async ({ env, hh, body, waitUntil }) => {
  const day = typeof body.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : today(hh);
  const authorId = await ownMember(env, hh, body.authorId);
  // Notes for a later day get a second nudge from the scheduler on the morning of that day.
  const morningNudgeDone = day <= today(hh);
  const a = {
    id: uid(),
    authorId,
    day,
    text: str(body.text, "Announcement", 500),
    color: str(body.color ?? "butter", "Colour", 20),
    createdAt: now(),
  };
  await env.DB.prepare(
    "INSERT INTO announcements (id, household_id, author_id, day, text, color, notified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(a.id, hh.id, a.authorId, a.day, a.text, a.color, morningNudgeDone ? 1 : 0, a.createdAt)
    .run();
  // Everyone else hears about a new note straight away, with the note itself
  // as the message. Notes for a later day also get a nudge that morning.
  if (day >= today(hh)) {
    const author = authorId
      ? await env.DB.prepare("SELECT name, emoji FROM members WHERE id = ?").bind(authorId).first<any>()
      : null;
    const who = author ? `${author.emoji} ${author.name}` : "Someone";
    waitUntil(
      notify(
        env,
        hh.id,
        null,
        {
          title: `📌 ${who} posted a note${noteDayLabel(day, today(hh))}`,
          body: a.text,
          url: "/?tab=today",
          tag: `note-${a.id}`,
        },
        authorId,
      ),
    );
  }
  return json(a, 201);
});

route("DELETE", "/api/announcements/:id", async ({ env, hh, params }) => {
  await env.DB.prepare("DELETE FROM announcements WHERE id = ? AND household_id = ?").bind(params[0], hh.id).run();
  return json({ ok: true });
});

// Reminders

route("GET", "/api/reminders", async ({ env, hh }) => {
  const { results } = await env.DB.prepare(
    "SELECT * FROM reminders WHERE household_id = ? ORDER BY active DESC, due_at LIMIT 200",
  )
    .bind(hh.id)
    .all();
  return json(results.map(mapReminder));
});

route("POST", "/api/reminders", async ({ env, hh, body }) => {
  const r = {
    id: uid(),
    memberId: await ownMember(env, hh, body.memberId),
    createdBy: await ownMember(env, hh, body.createdBy),
    title: str(body.title, "Reminder", 120),
    dueAt: int(body.dueAt, "Time", 0, 8.64e15),
    repeat: oneOf(body.repeat ?? "none", REPEATS, "Repeat"),
    active: true,
  };
  await env.DB.prepare(
    "INSERT INTO reminders (id, household_id, member_id, created_by, title, due_at, repeat, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
  )
    .bind(r.id, hh.id, r.memberId, r.createdBy, r.title, r.dueAt, r.repeat, now())
    .run();
  return json(r, 201);
});

route("PATCH", "/api/reminders/:id", async ({ env, hh, body, params }) => {
  const row = await env.DB.prepare("SELECT * FROM reminders WHERE id = ? AND household_id = ?")
    .bind(params[0], hh.id)
    .first<any>();
  if (!row) throw new HttpError(404, "Reminder not found");
  await env.DB.prepare("UPDATE reminders SET title = ?, member_id = ?, due_at = ?, repeat = ?, active = ? WHERE id = ?")
    .bind(
      body.title !== undefined ? str(body.title, "Reminder", 120) : row.title,
      "memberId" in body ? await ownMember(env, hh, body.memberId) : row.member_id,
      body.dueAt !== undefined ? int(body.dueAt, "Time", 0, 8.64e15) : row.due_at,
      body.repeat !== undefined ? oneOf(body.repeat, REPEATS, "Repeat") : row.repeat,
      body.active !== undefined ? (body.active ? 1 : 0) : row.active,
      row.id,
    )
    .run();
  return json({ ok: true });
});

route("DELETE", "/api/reminders/:id", async ({ env, hh, params }) => {
  await env.DB.prepare("DELETE FROM reminders WHERE id = ? AND household_id = ?").bind(params[0], hh.id).run();
  return json({ ok: true });
});

// Push subscriptions

route("POST", "/api/push/subscribe", async ({ env, hh, body }) => {
  const memberId = await ownMember(env, hh, body.memberId);
  if (!memberId) throw new HttpError(400, "Pick who you are first");
  const sub = body.subscription ?? {};
  const endpoint = str(sub.endpoint, "Subscription endpoint", 1000);
  if (!endpoint.startsWith("https://")) throw new HttpError(400, "Bad subscription endpoint");
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, household_id, member_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET household_id = excluded.household_id, member_id = excluded.member_id,
       p256dh = excluded.p256dh, auth = excluded.auth`,
  )
    .bind(endpoint, hh.id, memberId, str(sub.keys?.p256dh, "p256dh"), str(sub.keys?.auth, "auth"), now())
    .run();
  return json({ ok: true });
});

route("POST", "/api/push/unsubscribe", async ({ env, hh, body }) => {
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND household_id = ?")
    .bind(String(body.endpoint ?? ""), hh.id)
    .run();
  return json({ ok: true });
});

route("POST", "/api/push/test", async ({ env, hh, body }) => {
  if (!vapidKeys(env)) throw new HttpError(500, "Notifications aren't set up on the server yet (missing VAPID keys)");
  const memberId = await ownMember(env, hh, body.memberId);
  if (!memberId) throw new HttpError(400, "Pick who you are first");
  await notify(env, hh.id, memberId, { title: "🧸 Hello from Cosy Chores!", body: "Notifications are working.", url: "/" });
  return json({ ok: true });
});

// ---- unauthenticated: create / join ----------------------------------------

async function createHousehold(env: Env, body: any): Promise<Response> {
  const id = uid();
  const secret = uid() + uid();
  const code = joinCode();
  const tz = validTimezone(body.timezone);
  const member = {
    id: uid(),
    name: str(body.member?.name, "Your name", 40),
    ...readBuddy(body.member?.buddy),
    color: str(body.member?.color ?? "pumpkin", "Colour", 20),
    position: 0,
  };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO households (id, name, join_code, timezone, created_at) VALUES (?, ?, ?, ?, ?)").bind(
      id,
      str(body.name, "Household name", 60),
      code,
      tz,
      now(),
    ),
    env.DB.prepare("INSERT INTO device_tokens (token_hash, household_id, created_at) VALUES (?, ?, ?)").bind(
      await sha256(secret),
      id,
      now(),
    ),
    env.DB.prepare(
      "INSERT INTO members (id, household_id, name, emoji, buddy, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
    ).bind(member.id, id, member.name, member.emoji, member.buddy, member.color, now()),
    env.DB.prepare("INSERT INTO templates (id, household_id, name, created_at) VALUES (?, ?, ?, ?)").bind(
      `tpl-${id}`,
      id,
      "Our usual week",
      now(),
    ),
    env.DB.prepare("UPDATE households SET active_template_id = ? WHERE id = ?").bind(`tpl-${id}`, id),
  ]);
  return json({ token: `${id}.${secret}`, memberId: member.id }, 201);
}

async function joinHousehold(env: Env, body: any): Promise<Response> {
  const code = str(body.code, "Invite code", 20).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const hh = await env.DB.prepare("SELECT * FROM households WHERE join_code = ?").bind(code).first<HouseholdRow>();
  if (!hh) throw new HttpError(404, "Hmm, that code doesn't match a household");
  // Each device gets its own secret, so one can be signed out without affecting the rest.
  const secret = uid() + uid();
  await env.DB.prepare("INSERT INTO device_tokens (token_hash, household_id, created_at) VALUES (?, ?, ?)")
    .bind(await sha256(secret), hh.id, now())
    .run();
  return json({ token: `${hh.id}.${secret}` });
}

async function authenticate(env: Env, req: Request): Promise<HouseholdRow> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const [id, secret] = token.split(".");
  if (!id || !secret) throw new HttpError(401, "Not signed in");
  const hash = await sha256(secret);
  const hh = await env.DB.prepare(
    "SELECT h.* FROM households h JOIN device_tokens d ON d.household_id = h.id WHERE h.id = ? AND d.token_hash = ?",
  )
    .bind(id, hash)
    .first<HouseholdRow>();
  if (!hh) throw new HttpError(401, "Not signed in");
  return hh;
}

async function handleApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const body = req.method === "GET" || req.method === "DELETE" ? {} : await req.json().catch(() => ({}));
  if (req.method === "POST" && url.pathname === "/api/households") return createHousehold(env, body);
  if (req.method === "POST" && url.pathname === "/api/join") return joinHousehold(env, body);

  const hh = await authenticate(env, req);
  for (const [method, pattern, handler] of routes) {
    if (method !== req.method) continue;
    const match = url.pathname.match(pattern);
    if (match)
      return handler({
        env,
        hh,
        body: body ?? {},
        url,
        params: match.slice(1).map(decodeURIComponent),
        waitUntil: (p) => ctx.waitUntil(p),
      });
  }
  throw new HttpError(404, "Not found");
}

// ---- scheduled: reminders and day-ahead notes ------------------------------

/** Records a notification as sent; false if it already was. */
async function sendOnce(env: Env, key: string): Promise<boolean> {
  const res = await env.DB.prepare("INSERT OR IGNORE INTO notification_log (key, created_at) VALUES (?, ?)").bind(key, now()).run();
  return res.meta.changes === 1;
}

const MORNING_HOUR = 8;

/**
 * Chore nudges: a push at a chore's time (if it has one and isn't done yet),
 * and an 8am round-up of each person's set-day chores that have no time.
 */
async function choreNotifications(env: Env, t: number) {
  const { results: households } = await env.DB.prepare("SELECT * FROM households").all<HouseholdRow>();
  for (const hh of households) {
    const local = localParts(t, hh.timezone);
    const todayKey = dayKey(t, hh.timezone);
    const nowMinutes = local.hour * 60 + local.minute;
    const week = weekOf(todayKey);
    if (!(await ensureWeek(env, hh, week))) continue;
    const board = await loadBoard(env, hh, week);
    const todays = board.items.filter((i) => i.kind === "days" && scheduledDays(i.days, week).includes(todayKey));
    if (!todays.length) continue;
    const chores = new Map(
      ((await env.DB.prepare("SELECT id, title, emoji FROM chores WHERE household_id = ?").bind(hh.id).all<any>()).results).map(
        (c) => [c.id, c],
      ),
    );
    const doneToday = (itemId: string) => board.completions.some((c) => c.itemId === itemId && c.day === todayKey);

    for (const item of todays) {
      if (!item.time || doneToday(item.id)) continue;
      const [h, m] = item.time.split(":").map(Number);
      const due = h * 60 + m;
      // Due now, or in the last couple of hours if the scheduler missed it; never older.
      if (nowMinutes < due || nowMinutes - due > 120) continue;
      if (!(await sendOnce(env, `time:${item.id}:${todayKey}`))) continue;
      const chore = chores.get(item.choreId);
      const message = {
        title: `⏰ ${chore?.emoji ?? ""} ${chore?.title ?? "Chore"} — ${formatTime(item.time)}`,
        body: "It's time! Tick it off once it's done 💛",
        url: "/?tab=chores",
        tag: `time-${item.id}-${todayKey}`,
      };
      if (item.assigneeIds.length) for (const id of item.assigneeIds) await notify(env, hh.id, id, message);
      else await notify(env, hh.id, null, message);
    }

    if (local.hour < MORNING_HOUR || local.hour >= 12) continue;
    const { results: members } = await env.DB.prepare("SELECT id FROM members WHERE household_id = ?").bind(hh.id).all<any>();
    for (const member of members) {
      const mine = todays.filter((i) => !i.time && !doneToday(i.id) && i.assigneeIds.includes(member.id));
      if (!mine.length || !(await sendOnce(env, `morning:${member.id}:${todayKey}`))) continue;
      const names = mine.map((i) => `${chores.get(i.choreId)?.emoji ?? ""} ${chores.get(i.choreId)?.title ?? ""}`.trim());
      await notify(env, hh.id, member.id, {
        title: "☀️ Today's chores",
        body: names.join(", "),
        url: "/?tab=chores",
        tag: `morning-${todayKey}`,
      });
    }
  }
  // Keep the log small: nothing older than a fortnight is ever checked again.
  await env.DB.prepare("DELETE FROM notification_log WHERE created_at < ?").bind(t - 14 * 86400000).run();
}

async function runSchedule(env: Env) {
  const t = now();
  await choreNotifications(env, t).catch((e) => console.error("chore notifications failed", e));
  const due = await env.DB.prepare(
    `SELECT r.*, h.timezone FROM reminders r JOIN households h ON h.id = r.household_id
     WHERE r.active = 1 AND r.due_at <= ? LIMIT 100`,
  )
    .bind(t)
    .all<any>();
  for (const r of due.results) {
    // Advance first so a slow push can't cause a duplicate on the next tick.
    let next = nextDue(r.due_at, r.repeat, r.timezone);
    while (next !== null && next <= t) next = nextDue(next, r.repeat, r.timezone);
    await env.DB.prepare("UPDATE reminders SET due_at = ?, active = ? WHERE id = ?")
      .bind(next ?? r.due_at, next === null ? 0 : 1, r.id)
      .run();
    // Skip reminders that were missed by more than a few hours (e.g. after downtime).
    if (t - r.due_at < 3 * 60 * 60 * 1000)
      await notify(env, r.household_id, r.member_id, {
        title: `⏰ ${r.title}`,
        body: r.member_id ? "Friendly reminder 💛" : "Reminder for everyone 💛",
        url: "/?tab=reminders",
        tag: `reminder-${r.id}`,
      });
  }

  const notes = await env.DB.prepare(
    `SELECT a.*, h.timezone FROM announcements a JOIN households h ON h.id = a.household_id
     WHERE a.notified = 0 AND a.day <= ? LIMIT 100`,
  )
    .bind(dayKey(t + 24 * 60 * 60 * 1000, "UTC"))
    .all<any>();
  for (const a of notes.results) {
    const localToday = dayKey(t, a.timezone);
    if (a.day > localToday || (a.day === localToday && localParts(t, a.timezone).hour < NOTE_HOUR)) continue;
    await env.DB.prepare("UPDATE announcements SET notified = 1 WHERE id = ?").bind(a.id).run();
    if (a.day === localToday)
      await notify(env, a.household_id, null, {
        title: "📌 On the board today",
        body: a.text,
        url: "/?tab=today",
        tag: `note-today-${a.id}`,
      });
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/assets/")) {
      // A build file that no longer exists (an old version asking for it) must be
      // a real 404, not the app's page, or it gets used as a script or stylesheet.
      const res = await env.ASSETS.fetch(req);
      if ((res.headers.get("Content-Type") ?? "").includes("text/html"))
        return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
      return res;
    }
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await handleApi(req, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Something went wrong on our side" }, 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runSchedule(env));
  },
} satisfies ExportedHandler<Env>;
