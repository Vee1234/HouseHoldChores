import { useState } from "react";
import { type BoardItem, addDays } from "../shared/core";
import { ChoreCard, type Ticking } from "./ChoresBoard";
import { type Slot, slotsFor } from "./choreParts";

const ONLY_MINE_KEY = "cosy.todayOnlyMine";

function longDate(day: string): string {
  return new Date(day + "T00:00:00Z").toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

interface Entry {
  item: BoardItem;
  slots: Slot[];
}

/**
 * The Chores tab's first screen: what needs doing today, then the rest of this
 * week day by day. Cards are the board's own, so ticking works the same.
 */
export function TodayChores({ ticking, onOpenItem }: { ticking: Ticking; onOpenItem: (itemId: string) => void }) {
  const { board, chores, members, me, today, toggle, waitingFor } = ticking;
  const [onlyMine, setOnlyMineState] = useState(() => {
    try {
      return localStorage.getItem(ONLY_MINE_KEY) !== "no";
    } catch {
      return true;
    }
  });
  const setOnlyMine = (v: boolean) => {
    setOnlyMineState(v);
    try {
      localStorage.setItem(ONLY_MINE_KEY, v ? "yes" : "no");
    } catch {}
  };
  const filtering = onlyMine && !!me;

  const visible = board.items.filter((i) => !filtering || i.assigneeIds.includes(me!.id));
  const withSlots = visible.map((item) => ({
    item,
    all: slotsFor(item, board.week, board.completions.filter((c) => c.itemId === item.id)),
  }));
  const byTime = (a: Entry, b: Entry) => (a.item.time ?? "99").localeCompare(b.item.time ?? "99");

  // Chores on set days show under their day, with just that day's go.
  const onDay = (day: string): Entry[] =>
    withSlots
      .filter((x) => x.item.kind === "days")
      .flatMap(({ item, all }) => {
        const slot = all.slots.find((s) => s.day === day);
        return slot ? [{ item, slots: [slot] }] : [];
      })
      .sort(byTime);
  // "Any day" chores could be done today, so they sit under Today with the week's dots.
  const anyDay: Entry[] = withSlots.filter((x) => x.item.kind === "anytime").map(({ item, all }) => ({ item, slots: all.slots }));

  const card = ({ item, slots }: Entry, key: string) => (
    <ChoreCard
      key={key}
      item={item}
      chore={chores.get(item.choreId)}
      slots={slots}
      extra={0}
      members={members}
      today={today}
      canComplete={!!me && (item.assigneeIds.includes(me.id) || item.assigneeIds.length === 0)}
      waitingFor={(slot) => waitingFor(item, slot)}
      onToggle={(slot) => toggle(item, slot)}
      onOpen={() => onOpenItem(item.id)}
    />
  );

  const todays = onDay(today);
  const laterDays: string[] = [];
  for (let day = addDays(today, 1); day <= addDays(board.week, 6); day = addDays(day, 1)) laterDays.push(day);

  return (
    <div className="today-chores">
      <label className="toggle">
        <input type="checkbox" checked={filtering} onChange={(e) => setOnlyMine(e.target.checked)} disabled={!me} />
        <span>Only show my tasks</span>
      </label>

      <section className="day-section is-today">
        <h2>
          Today <span className="day-date">· {longDate(today)}</span>
        </h2>
        {todays.length === 0 ? (
          <p className="empty-day">No chores for this day</p>
        ) : (
          <div className="day-cards">{todays.map((e) => card(e, `${e.item.id}-today`))}</div>
        )}
        {anyDay.length > 0 && (
          <>
            <h3 className="any-day-head">Any day this week</h3>
            <div className="day-cards">{anyDay.map((e) => card(e, `${e.item.id}-any`))}</div>
          </>
        )}
      </section>

      <section className="day-section">
        <h2>This Week</h2>
        {laterDays.length === 0 ? (
          <p className="empty-day">That's the end of the week — a fresh one starts tomorrow 🌱</p>
        ) : (
          laterDays.map((day) => {
            const entries = onDay(day);
            return (
              <div key={day} className="later-day">
                <h3>{longDate(day)}</h3>
                {entries.length === 0 ? (
                  <p className="empty-day">No chores for this day</p>
                ) : (
                  <div className="day-cards">{entries.map((e) => card(e, `${e.item.id}-${day}`))}</div>
                )}
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}

