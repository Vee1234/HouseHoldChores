import { useState } from "react";
import { type Board, type HomeData, type Member } from "../shared/core";
import { AssigneeAvatars, slotStatus, slotsFor } from "./choreParts";
import { Avatar, memberColor } from "./ui";

const ICON = { done: "✓", missed: "!", today: "●", upcoming: "○" } as const;
const WORD = { done: "done", missed: "missed", today: "due today", upcoming: "to do" } as const;

/** Everyone's progress this week, and where each of their chores is at. */
export function EveryonesProgress({ board, home, me }: { board: Board; home: HomeData; me: Member | null }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const chores = new Map(home.chores.map((c) => [c.id, c]));
  const memberById = new Map(home.members.map((m) => [m.id, m]));

  const people = home.members.map((member) => {
    const items = board.items
      .filter((i) => i.assigneeIds.includes(member.id))
      .map((item) => ({ item, slots: slotsFor(item, board.week, board.completions.filter((c) => c.itemId === item.id)).slots }));
    const total = items.reduce((n, x) => n + x.slots.length, 0);
    const done = items.reduce((n, x) => n + x.slots.filter((s) => s.completion).length, 0);
    return { member, items, total, done };
  });

  return (
    <div className="card">
      <h2>👨‍👩‍👧 How everyone's doing</h2>
      <ul className="people-progress">
        {people.map(({ member, items, total, done }) => {
          const open = openId === member.id;
          return (
            <li key={member.id} style={{ "--bar": memberColor(member.color) } as React.CSSProperties}>
              <button className="person-row" onClick={() => setOpenId(open ? null : member.id)} aria-expanded={open}>
                <Avatar member={member} size={30} />
                <span className="person-main">
                  <strong>
                    {member.name}
                    {member.id === me?.id ? " (you)" : ""}
                  </strong>
                  <span className="mini-bar" aria-hidden>
                    <span style={{ width: total ? `${(done / total) * 100}%` : 0 }} />
                  </span>
                </span>
                <span className="pill">{total ? `${done}/${total}` : "free"}</span>
                <span className="chev" aria-hidden>
                  {open ? "▾" : "▸"}
                </span>
              </button>
              {open && (
                <ul className="status-list">
                  {items.length === 0 && <li className="muted small">Nothing assigned this week.</li>}
                  {items.map(({ item, slots }) => {
                    const chore = chores.get(item.choreId);
                    if (!chore) return null;
                    return (
                      <li key={item.id}>
                        <span aria-hidden>{chore.emoji}</span>
                        <span className="status-title">{chore.title}</span>
                        {item.assigneeIds.length > 1 && <AssigneeAvatars ids={item.assigneeIds} members={home.members} size={18} />}
                        <span className="status-chips">
                          {slots.map((slot, i) => {
                            const status = slotStatus(slot, home.today);
                            const who = slot.completion?.memberId ? memberById.get(slot.completion.memberId) : undefined;
                            const when = slot.label ? `${slot.label} ` : "";
                            return (
                              <span
                                key={i}
                                className={`status-chip ${status}`}
                                title={`${when}${WORD[status]}${who ? ` by ${who.name}` : ""}`}
                              >
                                {slot.label || ""}
                                {ICON[status]}
                                <span className="sr-only">
                                  {when}
                                  {WORD[status]}
                                  {who ? ` by ${who.name}` : ""}
                                </span>
                              </span>
                            );
                          })}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
