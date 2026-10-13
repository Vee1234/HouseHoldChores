import {
  type Board,
  type Per,
  type Repeat,
  type WeekStats,
  TEMPLATE,
  addDays,
  dayKey,
  isWeekKey,
  localParts,
  minutesPerCompletion,
  nextDue,
  weekOf,
  weeklyMinutes,
} from "../shared/core";
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

const mapMember = (r: any) => ({ id: r.id, name: r.name, emoji: r.emoji, color: r.color, position: r.position });
const mapChore = (r: any) => ({
  id: r.id,
  title: r.title,
  emoji: r.emoji,
  minutes: r.minutes,
  per: r.per,
  timesPerWeek: r.times_per_week,
});
const mapItem = (r: any) => ({
  id: r.id,
  choreId: r.chore_id,
  memberId: r.member_id,
  position: r.position,
  timesPerWeek: r.times_per_week,
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

function cloneTemplateStatements(env: Env, hh: HouseholdRow, week: string, items: any[]) {
  return items.map((it) =>
    env.DB.prepare(
      "INSERT INTO board_items (id, household_id, week, chore_id, member_id, position, times_per_week) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(uid(), hh.id, week, it.chore_id, it.member_id, it.position, it.times_per_week),
  );
}

/** Makes sure a board exists, cloning the template for new weeks. Returns false for an unplanned past week. */
async function ensureWeek(env: Env, hh: HouseholdRow, week: string): Promise<boolean> {
  const existing = await env.DB.prepare("SELECT 1 FROM weeks WHERE household_id = ? AND week = ?")
    .bind(hh.id, week)
    .first();
  if (existing) return true;
  if (week !== TEMPLATE && week < currentWeek(hh)) return false;

  const insertWeek = env.DB.prepare(
    "INSERT OR IGNORE INTO weeks (household_id, week, modified, created_at) VALUES (?, ?, 0, ?)",
  ).bind(hh.id, week, now());
  if (week === TEMPLATE) {
    await insertWeek.run();
    return true;
  }
  await ensureWeek(env, hh, TEMPLATE);
  const { results } = await env.DB.prepare(
    "SELECT bi.* FROM board_items bi JOIN chores c ON c.id = bi.chore_id WHERE bi.household_id = ? AND bi.week = ? AND c.archived = 0",
  )
    .bind(hh.id, TEMPLATE)
    .all();
  const res = await insertWeek.run();
  // Another request may have cloned this week at the same moment.
  if (res.meta.changes === 0) return true;
  if (results.length) await env.DB.batch(cloneTemplateStatements(env, hh, week, results));
  return true;
}

/**
 * Called after the template changes: future weeks nobody has touched yet are
 * dropped so they re-clone from the new template when next opened.
 */
async function refreshUntouchedFutureWeeks(env: Env, hh: HouseholdRow) {
  const cw = currentWeek(hh);
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM board_items WHERE household_id = ?1 AND week IN
         (SELECT week FROM weeks WHERE household_id = ?1 AND week != 'template' AND week > ?2 AND modified = 0)`,
    ).bind(hh.id, cw),
    env.DB.prepare(
      "DELETE FROM weeks WHERE household_id = ? AND week != 'template' AND week > ? AND modified = 0",
    ).bind(hh.id, cw),
  ]);
}

async function boardChanged(env: Env, hh: HouseholdRow, week: string) {
  if (week === TEMPLATE) await refreshUntouchedFutureWeeks(env, hh);
  else
    await env.DB.prepare("UPDATE weeks SET modified = 1 WHERE household_id = ? AND week = ?")
      .bind(hh.id, week)
      .run();
}

async function loadBoard(env: Env, hh: HouseholdRow, week: string): Promise<Board> {
  const [items, completions] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM board_items WHERE household_id = ? AND week = ? ORDER BY position").bind(
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
    items: items.results.map(mapItem),
    completions: completions.results.map((r: any) => ({
      id: r.id,
      itemId: r.item_id,
      memberId: r.member_id,
      doneAt: r.done_at,
    })),
  };
}

async function itemOf(env: Env, hh: HouseholdRow, id: string) {
  const row = await env.DB.prepare("SELECT * FROM board_items WHERE id = ? AND household_id = ?")
    .bind(id, hh.id)
    .first<any>();
  if (!row) throw new HttpError(404, "That chore isn't on the board any more");
  return row;
}

function boardWeek(param: string): string {
  if (param === TEMPLATE || isWeekKey(param)) return param;
  throw new HttpError(400, "Week must be 'template' or a Monday (YYYY-MM-DD)");
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
    emoji: str(body.emoji, "Emoji", 16),
    color: str(body.color, "Colour", 20),
    position: count ?? 0,
  };
  await env.DB.prepare(
    "INSERT INTO members (id, household_id, name, emoji, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(member.id, hh.id, member.name, member.emoji, member.color, member.position, now())
    .run();
  return json(member, 201);
});

route("PATCH", "/api/members/:id", async ({ env, hh, body, params }) => {
  const row = await env.DB.prepare("SELECT * FROM members WHERE id = ? AND household_id = ?")
    .bind(params[0], hh.id)
    .first<any>();
  if (!row) throw new HttpError(404, "Member not found");
  await env.DB.prepare("UPDATE members SET name = ?, emoji = ?, color = ? WHERE id = ?")
    .bind(
      body.name !== undefined ? str(body.name, "Name", 40) : row.name,
      body.emoji !== undefined ? str(body.emoji, "Emoji", 16) : row.emoji,
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

// Chore library

route("POST", "/api/chores", async ({ env, hh, body }) => {
  const chore = {
    id: uid(),
    title: str(body.title, "Chore name", 80),
    emoji: str(body.emoji ?? "🧹", "Emoji", 16),
    minutes: int(body.minutes, "Minutes", 1, 6000),
    per: oneOf(body.per, PERS, "Time estimate"),
    timesPerWeek: int(body.timesPerWeek ?? 1, "Times per week", 1, 21),
  };
  await env.DB.prepare(
    "INSERT INTO chores (id, household_id, title, emoji, minutes, per, times_per_week, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(chore.id, hh.id, chore.title, chore.emoji, chore.minutes, chore.per, chore.timesPerWeek, now())
    .run();
  return json(chore, 201);
});

route("PATCH", "/api/chores/:id", async ({ env, hh, body, params }) => {
  const row = await env.DB.prepare("SELECT * FROM chores WHERE id = ? AND household_id = ?")
    .bind(params[0], hh.id)
    .first<any>();
  if (!row) throw new HttpError(404, "Chore not found");
  await env.DB.prepare("UPDATE chores SET title = ?, emoji = ?, minutes = ?, per = ?, times_per_week = ? WHERE id = ?")
    .bind(
      body.title !== undefined ? str(body.title, "Chore name", 80) : row.title,
      body.emoji !== undefined ? str(body.emoji, "Emoji", 16) : row.emoji,
      body.minutes !== undefined ? int(body.minutes, "Minutes", 1, 6000) : row.minutes,
      body.per !== undefined ? oneOf(body.per, PERS, "Time estimate") : row.per,
      body.timesPerWeek !== undefined ? int(body.timesPerWeek, "Times per week", 1, 21) : row.times_per_week,
      row.id,
    )
    .run();
  return json({ ok: true });
});

// Removing a chore keeps past weeks' history but takes it off the template and upcoming weeks.
route("DELETE", "/api/chores/:id", async ({ env, hh, params }) => {
  const cw = currentWeek(hh);
  await env.DB.batch([
    env.DB.prepare("UPDATE chores SET archived = 1 WHERE id = ? AND household_id = ?").bind(params[0], hh.id),
    env.DB.prepare(
      "DELETE FROM board_items WHERE chore_id = ? AND household_id = ? AND (week = 'template' OR week >= ?)",
    ).bind(params[0], hh.id, cw),
  ]);
  return json({ ok: true });
});

// Boards (template + weeks)

route("GET", "/api/board/:week", async ({ env, hh, params }) => {
  const week = boardWeek(params[0]);
  const exists = await ensureWeek(env, hh, week);
  if (!exists) return json({ week, items: [], completions: [] } satisfies Board);
  return json(await loadBoard(env, hh, week));
});

route("POST", "/api/board/:week/items", async ({ env, hh, body, params }) => {
  const week = boardWeek(params[0]);
  if (!(await ensureWeek(env, hh, week))) throw new HttpError(400, "That week has already passed");
  const chore = await env.DB.prepare("SELECT * FROM chores WHERE id = ? AND household_id = ? AND archived = 0")
    .bind(body.choreId, hh.id)
    .first<any>();
  if (!chore) throw new HttpError(400, "Unknown chore");
  const memberId = await ownMember(env, hh, body.memberId);
  const maxPos = await env.DB.prepare(
    "SELECT COALESCE(MAX(position), 0) AS p FROM board_items WHERE household_id = ? AND week = ?",
  )
    .bind(hh.id, week)
    .first<number>("p");
  const item = {
    id: uid(),
    choreId: chore.id,
    memberId,
    position: (maxPos ?? 0) + 1,
    timesPerWeek: body.timesPerWeek !== undefined ? int(body.timesPerWeek, "Times per week", 1, 21) : chore.times_per_week,
  };
  await env.DB.prepare(
    "INSERT INTO board_items (id, household_id, week, chore_id, member_id, position, times_per_week) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(item.id, hh.id, week, item.choreId, item.memberId, item.position, item.timesPerWeek)
    .run();
  await boardChanged(env, hh, week);
  return json(item, 201);
});

route("PATCH", "/api/items/:id", async ({ env, hh, body, params }) => {
  const row = await itemOf(env, hh, params[0]);
  const memberId = "memberId" in body ? await ownMember(env, hh, body.memberId) : row.member_id;
  const position = body.position !== undefined ? Number(body.position) : row.position;
  if (!Number.isFinite(position)) throw new HttpError(400, "Bad position");
  const times = body.timesPerWeek !== undefined ? int(body.timesPerWeek, "Times per week", 1, 21) : row.times_per_week;
  await env.DB.prepare("UPDATE board_items SET member_id = ?, position = ?, times_per_week = ? WHERE id = ?")
    .bind(memberId, position, times, row.id)
    .run();
  await boardChanged(env, hh, row.week);
  return json({ ok: true });
});

route("DELETE", "/api/items/:id", async ({ env, hh, params }) => {
  const row = await itemOf(env, hh, params[0]);
  await env.DB.prepare("DELETE FROM board_items WHERE id = ?").bind(row.id).run();
  await boardChanged(env, hh, row.week);
  return json({ ok: true });
});

route("POST", "/api/items/:id/completions", async ({ env, hh, body, params }) => {
  const row = await itemOf(env, hh, params[0]);
  if (row.week === TEMPLATE) throw new HttpError(400, "Tick chores off on a real week, not the template");
  const completion = { id: uid(), itemId: row.id, memberId: await ownMember(env, hh, body.memberId), doneAt: now() };
  await env.DB.prepare("INSERT INTO completions (id, item_id, member_id, done_at) VALUES (?, ?, ?, ?)")
    .bind(completion.id, completion.itemId, completion.memberId, completion.doneAt)
    .run();
  await boardChanged(env, hh, row.week);
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

// Throws away this week's plan (and its ticks) and re-copies the template.
route("POST", "/api/board/:week/reset", async ({ env, hh, params }) => {
  const week = boardWeek(params[0]);
  if (week === TEMPLATE || week < currentWeek(hh)) throw new HttpError(400, "Only this week or later can be reset");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM board_items WHERE household_id = ? AND week = ?").bind(hh.id, week),
    env.DB.prepare("DELETE FROM weeks WHERE household_id = ? AND week = ?").bind(hh.id, week),
  ]);
  await ensureWeek(env, hh, week);
  return json(await loadBoard(env, hh, week));
});

route("POST", "/api/board/:week/save-as-template", async ({ env, hh, params }) => {
  const week = boardWeek(params[0]);
  if (week === TEMPLATE) throw new HttpError(400, "That's already the template");
  await ensureWeek(env, hh, TEMPLATE);
  const { results } = await env.DB.prepare(
    "SELECT bi.* FROM board_items bi JOIN chores c ON c.id = bi.chore_id WHERE bi.household_id = ? AND bi.week = ? AND c.archived = 0",
  )
    .bind(hh.id, week)
    .all();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM board_items WHERE household_id = ? AND week = 'template'").bind(hh.id),
    ...cloneTemplateStatements(env, hh, TEMPLATE, results),
  ]);
  await refreshUntouchedFutureWeeks(env, hh);
  return json({ ok: true });
});

// Stats

route("GET", "/api/stats", async ({ env, hh, url }) => {
  const count = int(url.searchParams.get("weeks") ?? 6, "weeks", 1, 26);
  const last = currentWeek(hh);
  const first = addDays(last, -7 * (count - 1));
  const [items, completions] = await env.DB.batch([
    env.DB.prepare(
      `SELECT bi.week, bi.member_id, bi.times_per_week, c.minutes, c.per FROM board_items bi
       JOIN chores c ON c.id = bi.chore_id
       WHERE bi.household_id = ? AND bi.week != 'template' AND bi.week BETWEEN ? AND ?`,
    ).bind(hh.id, first, last),
    env.DB.prepare(
      `SELECT bi.week, co.member_id, bi.times_per_week, c.minutes, c.per FROM completions co
       JOIN board_items bi ON bi.id = co.item_id JOIN chores c ON c.id = bi.chore_id
       WHERE bi.household_id = ? AND bi.week != 'template' AND bi.week BETWEEN ? AND ?`,
    ).bind(hh.id, first, last),
  ]);
  const weeks: WeekStats[] = [];
  for (let w = first; w <= last; w = addDays(w, 7)) weeks.push({ week: w, planned: {}, done: {} });
  const byWeek = new Map(weeks.map((w) => [w.week, w]));
  const add = (bucket: Record<string, number>, key: string | null, mins: number) => {
    bucket[key ?? ""] = (bucket[key ?? ""] ?? 0) + mins;
  };
  for (const r of items.results as any[])
    add(byWeek.get(r.week)!.planned, r.member_id, weeklyMinutes(r.minutes, r.per, r.times_per_week));
  for (const r of completions.results as any[])
    add(byWeek.get(r.week)!.done, r.member_id, minutesPerCompletion(r.minutes, r.per, r.times_per_week));
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

route("POST", "/api/announcements", async ({ env, hh, body, waitUntil }) => {
  const day = typeof body.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : today(hh);
  const authorId = await ownMember(env, hh, body.authorId);
  // Notes for today (or earlier) are pushed now; future ones by the scheduler on the day.
  const pushedNow = day <= today(hh);
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
    .bind(a.id, hh.id, a.authorId, a.day, a.text, a.color, pushedNow ? 1 : 0, a.createdAt)
    .run();
  if (day === today(hh)) {
    const author = authorId
      ? await env.DB.prepare("SELECT name, emoji FROM members WHERE id = ?").bind(authorId).first<any>()
      : null;
    waitUntil(
      notify(
        env,
        hh.id,
        null,
        {
          title: author ? `📌 ${author.emoji} ${author.name} posted a note` : "📌 New note on the board",
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
    emoji: str(body.member?.emoji ?? "🐻", "Emoji", 16),
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
      "INSERT INTO members (id, household_id, name, emoji, color, position, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    ).bind(member.id, id, member.name, member.emoji, member.color, now()),
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

async function runSchedule(env: Env) {
  const t = now();
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
        tag: `note-${a.id}`,
      });
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
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
