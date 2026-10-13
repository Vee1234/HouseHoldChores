import type { ReactNode } from "react";
import { type Board, type HomeData, type Member, addDays, formatTime } from "../shared/core";
import { api } from "./api";
import { AssigneeAvatars, slotStatus, slotsFor } from "./choreParts";
import { Avatar, usePolled } from "./ui";

function timeAgo(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

const dayName = (day: string) =>
  new Date(day + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });

/**
 * What's due or overdue and still not done, then what's been done lately.
 * `between` is shown between the two (the Today page puts reminders there).
 */
export function Updates({ home, me, between }: { home: HomeData; me: Member | null; between?: ReactNode }) {
  const lastWeek = addDays(home.currentWeek, -7);
  const { data } = usePolled<Board[]>(
    () => Promise.all([api("GET", `/api/board/${home.currentWeek}`), api("GET", `/api/board/${lastWeek}`)]),
    [home.currentWeek],
  );
  if (!data) return <p className="empty">Fluffing the cushions…</p>;
  const chores = new Map(home.chores.map((c) => [c.id, c]));
  const members = new Map(home.members.map((m) => [m.id, m]));
  const [thisWeek] = data;

  // Warnings: this week's set-day goes that are overdue or due today and not done.
  const warnings = thisWeek.items
    .flatMap((item) =>
      slotsFor(item, thisWeek.week, thisWeek.completions.filter((c) => c.itemId === item.id))
        .slots.filter((s) => s.day)
        .map((slot) => ({ item, slot, status: slotStatus(slot, home.today) })),
    )
    .filter((w) => w.status === "missed" || w.status === "today")
    .sort((a, b) => (a.status === b.status ? a.slot.day!.localeCompare(b.slot.day!) : a.status === "missed" ? -1 : 1));

  // Any-day chores falling behind once the week is nearly over.
  const daysLeft = 7 - Math.round((Date.parse(home.today) - Date.parse(home.currentWeek)) / 86400000);
  const behind = thisWeek.items.filter((item) => {
    if (item.kind !== "anytime") return false;
    const left = item.timesPerWeek - thisWeek.completions.filter((c) => c.itemId === item.id).length;
    return left > 0 && left >= daysLeft;
  });

  const recent = data
    .flatMap((b) => b.completions.map((c) => ({ c, item: b.items.find((i) => i.id === c.itemId) })))
    .filter((x) => x.item)
    .sort((a, b) => b.c.doneAt - a.c.doneAt)
    .slice(0, 15);

  const isMine = (ids: string[]) => !!me && ids.includes(me.id);

  return (
    <div className="stack">
      <div className="card">
        <h2>⚠️ Needs doing</h2>
        {warnings.length === 0 && behind.length === 0 ? (
          <p className="muted">Nothing overdue — the house is in good shape! 🌼</p>
        ) : (
          <ul className="update-list">
            {warnings.map(({ item, slot, status }) => {
              const chore = chores.get(item.choreId);
              if (!chore) return null;
              return (
                <li key={`${item.id}-${slot.day}`} className={`update ${status === "missed" ? "warn" : "due"} ${isMine(item.assigneeIds) ? "mine" : ""}`}>
                  <span className="update-icon" aria-hidden>
                    {status === "missed" ? "⚠️" : "⏳"}
                  </span>
                  <span className="update-text">
                    <strong>
                      {chore.emoji} {chore.title}
                    </strong>
                    <small>
                      {status === "missed" ? `Not done on ${dayName(slot.day!)}` : `Due today${item.time ? ` at ${formatTime(item.time)}` : ""}`}
                    </small>
                  </span>
                  <AssigneeAvatars ids={item.assigneeIds} members={home.members} />
                </li>
              );
            })}
            {behind.map((item) => {
              const chore = chores.get(item.choreId);
              if (!chore) return null;
              const left = item.timesPerWeek - thisWeek.completions.filter((c) => c.itemId === item.id).length;
              return (
                <li key={item.id} className={`update warn ${isMine(item.assigneeIds) ? "mine" : ""}`}>
                  <span className="update-icon" aria-hidden>
                    ⚠️
                  </span>
                  <span className="update-text">
                    <strong>
                      {chore.emoji} {chore.title}
                    </strong>
                    <small>
                      {left} still to do, {daysLeft} {daysLeft === 1 ? "day" : "days"} left this week
                    </small>
                  </span>
                  <AssigneeAvatars ids={item.assigneeIds} members={home.members} />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {between}

      <div className="card">
        <h2>✅ Recently done</h2>
        {recent.length === 0 ? (
          <p className="muted">Nothing ticked off yet this week.</p>
        ) : (
          <ul className="update-list">
            {recent.map(({ c, item }) => {
              const chore = chores.get(item!.choreId);
              const who = c.memberId ? members.get(c.memberId) : undefined;
              const together = item!.assigneeIds.length > 1 && c.memberId && item!.assigneeIds.includes(c.memberId);
              return (
                <li key={c.id} className="update done">
                  <Avatar member={who} size={30} />
                  <span className="update-text">
                    <span>
                      <strong>{who?.name ?? "Someone"}</strong>
                      {together ? " (with the others)" : ""} completed{" "}
                      <strong>
                        {chore?.emoji} {chore?.title ?? "a chore"}
                      </strong>
                    </span>
                    <small>
                      {timeAgo(c.doneAt)}
                      {item!.kind === "days" && c.day ? ` · ${dayName(c.day)}'s go` : ""}
                    </small>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
