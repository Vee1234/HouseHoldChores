import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useState } from "react";
import { type BoardItem, type Member, addDays, creditedMembers, formatMinutes, weekOf } from "../shared/core";
import { ChoreCard, type Planning, type Ticking, tickMinutes } from "./ChoresBoard";
import { type Slot, slotsFor } from "./choreParts";
import { Avatar, memberColor, toast } from "./ui";

const ONLY_MINE_KEY = "cosy.todayOnlyMine";
const NOBODY = "nobody";

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

/** One week's board and the actions that work on it. */
export interface WeekPlanner {
  ticking: Ticking;
  planning: Planning;
  onOpenItem: (itemId: string) => void;
}

// Drag ids carry where the card came from: item, day and whose box.
const cardId = (itemId: string, day: string, who: string, part: string) => [itemId, day, who, part].join("|");
const parseCard = (id: string) => {
  const [itemId, day, who] = id.split("|");
  return { itemId, day, who };
};
const boxId = (day: string, who: string) => `${day}|${who}`;

/**
 * Chores by day, split into a box per person: `today` (the Today page) or the
 * next 7 days from today (Chores → Next 7 Days), which runs into `next` week's
 * board. Drag a chore onto someone else's box to hand it over; ticking works
 * exactly as on the cards elsewhere.
 */
export function TodayChores({
  show,
  ticking,
  planning,
  onOpenItem,
  next,
}: {
  show: "today" | "week";
  ticking: Ticking;
  planning: Planning;
  onOpenItem: (itemId: string) => void;
  next?: WeekPlanner | null;
}) {
  const { board, chores, members, me, today } = ticking;
  const weeks: WeekPlanner[] = [{ ticking, planning, onOpenItem }, ...(next ? [next] : [])];
  /** The board a day belongs to, if it's loaded. */
  const weekFor = (day: string) => weeks.find((w) => w.ticking.board.week === weekOf(day));
  const weekOfItem = new Map(weeks.flatMap((w) => w.ticking.board.items.map((i) => [i.id, w] as const)));
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
  // The Today page always shows everyone; the filter is only offered for Next 7 Days.
  const filtering = show === "week" && onlyMine && !!me;
  const people = filtering ? [me!] : members;
  const [dragging, setDragging] = useState<string | null>(null);

  const itemsById = new Map(weeks.flatMap((w) => w.ticking.board.items.map((i) => [i.id, i] as const)));
  const slotsOf = new Map(
    weeks.flatMap(({ ticking: { board: b } }) =>
      b.items.map((item) => [item.id, slotsFor(item, b.week, b.completions.filter((c) => c.itemId === item.id)).slots] as const),
    ),
  );
  const isFor = (item: BoardItem, who: string) => (who === NOBODY ? item.assigneeIds.length === 0 : item.assigneeIds.includes(who));
  const byTime = (a: Entry, b: Entry) => (a.item.time ?? "99").localeCompare(b.item.time ?? "99");

  /** Someone's chores on a set day, each with just that day's go. */
  const onDay = (who: string, day: string): Entry[] =>
    (weekFor(day)?.ticking.board.items ?? [])
      .filter((i) => i.kind === "days" && isFor(i, who))
      .flatMap((item) => {
        const slot = slotsOf.get(item.id)!.find((s) => s.day === day);
        return slot ? [{ item, slots: [slot] }] : [];
      })
      .sort(byTime);
  /** Someone's "any day" chores, with the week's dots (they could be done today). */
  const anyDay = (who: string): Entry[] =>
    board.items.filter((i) => i.kind === "anytime" && isFor(i, who)).map((item) => ({ item, slots: slotsOf.get(item.id)! }));

  /**
   * That day's minutes for a person. Planned is their set-day goes for the day,
   * plus any "any day" goes they did that day (doing one makes it that day's work).
   * Done is everything they got credit for that day.
   */
  const minutesFor = (who: string, day: string) => {
    let planned = onDay(who, day).reduce((n, e) => n + tickMinutes(e.item, chores), 0);
    let done = 0;
    for (const c of weekFor(day)?.ticking.board.completions ?? []) {
      const item = itemsById.get(c.itemId);
      if (!item || c.day !== day || !creditedMembers(c.memberId, item.assigneeIds).includes(who)) continue;
      done += tickMinutes(item, chores);
      if (item.kind === "anytime") planned += tickMinutes(item, chores);
    }
    return { planned, done };
  };

  const sensors = useSensors(
    // Mouse only: a pointer sensor would also grab touches, fighting the page scroll on phones.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Touch needs a press-and-hold; moving the finger sooner than that scrolls instead.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const onDragStart = (e: DragStartEvent) => {
    navigator.vibrate?.(12);
    setDragging(String(e.active.id));
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!over) return;
    const { itemId, who: from } = parseCard(String(active.id));
    const to = String(over.id).split("|")[1];
    const item = itemsById.get(itemId);
    const target = members.find((m) => m.id === to);
    if (!item || !target || to === from) return;
    if (item.assigneeIds.includes(to)) return toast(`${target.name} is already on that one`);
    weekOfItem.get(itemId)!.planning.handOver(item, from === NOBODY ? null : from, to);
    toast(`Handed to ${target.name} 🤝`);
  };

  const card = (e: Entry, day: string, who: string, part: string) => (
    <DraggableCard
      key={cardId(e.item.id, day, who, part)}
      id={cardId(e.item.id, day, who, part)}
      entry={e}
      ticking={weekOfItem.get(e.item.id)!.ticking}
      onOpen={() => weekOfItem.get(e.item.id)!.onOpenItem(e.item.id)}
    />
  );

  /** One day's boxes: one per person shown, plus "Needs someone" for chores nobody's on. */
  const dayBoxes = (day: string, isToday: boolean) => {
    const unassigned = filtering ? [] : [...onDay(NOBODY, day), ...(isToday ? anyDay(NOBODY) : [])];
    return (
      <div className="person-boxes">
        {people.map((m) => {
          const dated = onDay(m.id, day);
          const anytime = isToday ? anyDay(m.id) : [];
          const { planned, done } = minutesFor(m.id, day);
          return (
            <PersonBox key={m.id} id={boxId(day, m.id)} member={m} summary={`${formatMinutes(done)} done · ${formatMinutes(planned)} planned`}>
              {dated.length === 0 && anytime.length === 0 && <p className="box-empty">{isToday ? "Nothing today 🌼" : "Free"}</p>}
              {dated.map((e) => card(e, day, m.id, "day"))}
              {anytime.length > 0 && (
                <>
                  <h4 className="any-day-head">Any day this week</h4>
                  {anytime.map((e) => card(e, day, m.id, "any"))}
                </>
              )}
              {isToday && (
                <button className="add-card" onClick={() => planning.onAdd(m.id)}>
                  + Add a chore
                </button>
              )}
            </PersonBox>
          );
        })}
        {unassigned.length > 0 && (
          <div className="column needs-someone">
            <div className="column-head">
              <span className="avatar grabs-avatar">🙋</span>
              <div>
                <h3>Needs someone</h3>
                <small>Drag each one onto a person</small>
              </div>
            </div>
            <div className="column-body">
              {unassigned.map((e) => card(e, day, NOBODY, e.item.kind === "anytime" ? "any" : "day"))}
            </div>
          </div>
        )}
      </div>
    );
  };

  // Today always shows (it has the "any day" chores); later days only if someone being shown has something on.
  const laterWithChores: string[] = [];
  for (let i = 1; i < 7; i++) {
    const day = addDays(today, i);
    if (people.some((m) => onDay(m.id, day).length > 0) || (!filtering && onDay(NOBODY, day).length > 0)) laterWithChores.push(day);
  }

  const draggedItem = dragging ? itemsById.get(parseCard(dragging).itemId) : undefined;
  const draggedSlots =
    dragging && draggedItem
      ? draggedItem.kind === "days"
        ? slotsOf.get(draggedItem.id)!.filter((s) => s.day === parseCard(dragging).day)
        : slotsOf.get(draggedItem.id)!
      : [];

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="today-chores">
        {show === "week" && (
          <label className="toggle">
            <input type="checkbox" checked={filtering} onChange={(e) => setOnlyMine(e.target.checked)} disabled={!me} />
            <span>Only show my tasks</span>
          </label>
        )}

        {show === "today" && (
          <section className="day-section is-today">
            <h2>
              🧺 Today's chores <span className="day-date">· {longDate(today)}</span>
            </h2>
            {dayBoxes(today, true)}
          </section>
        )}

        {show === "week" && (
        <section className="day-section">
          <h2>Next 7 days</h2>
          <div className="later-day">
            <h3>Today · {longDate(today)}</h3>
            {dayBoxes(today, true)}
          </div>
          {laterWithChores.length === 0 ? (
            <p className="empty-day">Nothing else planned for the next 7 days 🌼</p>
          ) : (
            laterWithChores.map((day) => (
              <div key={day} className="later-day">
                <h3>{longDate(day)}</h3>
                {dayBoxes(day, false)}
              </div>
            ))
          )}
        </section>
        )}
      </div>
      <DragOverlay dropAnimation={{ duration: 180, easing: "ease-out" }}>
        {draggedItem && (
          <ChoreCard
            item={draggedItem}
            chore={chores.get(draggedItem.choreId)}
            slots={draggedSlots}
            extra={0}
            members={members}
            today={today}
            lifted
          />
        )}
      </DragOverlay>
    </DndContext>
  );
}

function PersonBox({ id, member, summary, children }: { id: string; member: Member; summary: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`column ${isOver ? "over" : ""}`} style={{ "--col": memberColor(member.color) } as React.CSSProperties}>
      <div className="column-head">
        <Avatar member={member} />
        <div>
          <h3>{member.name}</h3>
          <small>{summary}</small>
        </div>
      </div>
      <div className="column-body">{children}</div>
    </div>
  );
}

function DraggableCard({ id, entry, ticking, onOpen }: { id: string; entry: Entry; ticking: Ticking; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id });
  const { chores, members, me, today, toggle, waitingFor } = ticking;
  const { item, slots } = entry;
  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.35 : 1 }}
      {...attributes}
      {...listeners}
      aria-roledescription="Draggable chore. Drag onto someone's box to hand it over."
    >
      <ChoreCard
        item={item}
        chore={chores.get(item.choreId)}
        slots={slots}
        extra={0}
        members={members}
        today={today}
        canComplete={!!me && (item.assigneeIds.includes(me.id) || item.assigneeIds.length === 0)}
        waitingFor={(slot) => waitingFor(item, slot)}
        onToggle={(slot) => toggle(item, slot)}
        onOpen={onOpen}
      />
    </div>
  );
}
