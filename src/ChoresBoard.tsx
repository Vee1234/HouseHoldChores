import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useMemo, useState } from "react";
import {
  type Board,
  type BoardItem,
  type Chore,
  type Completion,
  type HomeData,
  type Member,
  type Schedule,
  type TemplatesData,
  addDays,
  blockingChore,
  creditedMembers,
  describeEstimate,
  describeSchedule,
  formatMinutes,
  goesPerWeek,
  minutesPerCompletion,
  weeklyMinutes,
} from "../shared/core";
import { api } from "./api";
import { announceBoard } from "./BuddyTrack";
import { CalendarView } from "./CalendarView";
import {
  AssigneeAvatars,
  AssigneePicker,
  ChoreForm,
  NEW_SCHEDULE,
  ScheduleEditor,
  type Slot,
  nextSlot,
  slotStatus,
  slotsFor,
} from "./choreParts";
import { Templates } from "./Templates";
import { Avatar, BuddySprite, Sheet, attempt, memberColor, prettyWeek, toast, usePolled } from "./ui";

const UNASSIGNED = "unassigned";
type View = "board" | "calendar" | "templates";
const VIEW_KEY = "cosy.choresView";

interface Props {
  home: HomeData;
  me: Member | null;
  reloadHome: () => void;
}

export interface Ticking {
  board: Board;
  chores: Map<string, Chore>;
  members: Member[];
  me: Member | null;
  today: string;
  toggle: (item: BoardItem, slot: Slot) => void;
  /** The chore a go is still waiting on, if it has an "only after" constraint. */
  waitingFor: (item: BoardItem, slot: Slot) => Chore | undefined;
}

/** The Chores tab: the board, the calendar and the templates. */
export function ChoresBoard({ home, me, reloadHome }: Props) {
  const [view, setViewState] = useState<View>(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY) as View | null;
      return saved === "calendar" || saved === "templates" ? saved : "board";
    } catch {
      return "board";
    }
  });
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };
  const [week, setWeek] = useState(home.currentWeek);
  const { data: board, setData: setBoard, refresh, error } = usePolled<Board>(() => api("GET", `/api/board/${week}`), [week]);
  const templates = usePolled<TemplatesData>(() => api("GET", "/api/templates"), [], 60000);
  const [sheet, setSheet] = useState<
    { kind: "add"; memberId: string | null } | { kind: "item"; itemId: string } | { kind: "menu" } | null
  >(null);

  const chores = useMemo(() => new Map(home.chores.map((c) => [c.id, c])), [home.chores]);
  const isPast = week < home.currentWeek;
  const activeTemplate = templates.data?.templates.find((t) => t.id === templates.data?.activeTemplateId);

  // Keeps the buddy track in step with ticks the moment they happen.
  useEffect(() => {
    if (board && board.week === home.currentWeek) announceBoard(board);
  }, [board, home.currentWeek]);

  // Server writes are fire-and-refresh: the UI updates straight away and the next load settles it.
  const mutate = async (fn: () => Promise<unknown>) => {
    await attempt(fn);
    refresh();
  };

  const waitingFor = (item: BoardItem, slot: Slot) => {
    const id = board && blockingChore(item, slot.day, board.items, board.completions);
    return id ? chores.get(id) : undefined;
  };

  const toggle = (item: BoardItem, slot: Slot) => {
    if (!board) return;
    if (slot.completion) {
      const id = slot.completion.id;
      setBoard({ ...board, completions: board.completions.filter((c) => c.id !== id) });
      mutate(() => api("DELETE", `/api/completions/${id}`));
      return;
    }
    if (!me) return toast("Pick who you are under Family first 🙂");
    const blocker = waitingFor(item, slot);
    if (blocker) return toast(`🔒 Waiting for ${blocker.emoji} ${blocker.title} to be done first`);
    const done = board.completions.filter((c) => c.itemId === item.id).length + 1;
    if (done === goesPerWeek(item)) toast(`${chores.get(item.choreId)?.emoji ?? "✨"} All done — thank you, ${me.name}!`);
    const temp: Completion = { id: `tmp-${Date.now()}`, itemId: item.id, memberId: me.id, doneAt: Date.now(), day: slot.day };
    setBoard({ ...board, completions: [...board.completions, temp] });
    mutate(() => api("POST", `/api/items/${item.id}/completions`, { memberId: me.id, day: slot.day ?? undefined }));
  };

  const columns: { key: string; member: Member | null }[] = [
    ...home.members.map((m) => ({ key: m.id, member: m })),
    { key: UNASSIGNED, member: null },
  ];

  const weekNav = (
    <div className="week-nav">
      <button className="icon-btn" aria-label="Previous week" onClick={() => setWeek(addDays(week, -7))}>
        ‹
      </button>
      <button className="week-label" onClick={() => setWeek(home.currentWeek)} title="Jump to this week">
        {week === home.currentWeek ? "This week" : prettyWeek(week)}
        <small>{week === home.currentWeek ? prettyWeek(week) : "tap for this week"}</small>
      </button>
      <button className="icon-btn" aria-label="Next week" onClick={() => setWeek(addDays(week, 7))}>
        ›
      </button>
      {!isPast && (
        <button className="icon-btn" aria-label="Week options" onClick={() => setSheet({ kind: "menu" })}>
          ⋯
        </button>
      )}
    </div>
  );

  return (
    <section className="page">
      <header className="page-head">
        <div className="segmented three" role="tablist" aria-label="Chores view">
          <button role="tab" aria-selected={view === "board"} onClick={() => setView("board")}>
            🧺 Board
          </button>
          <button role="tab" aria-selected={view === "calendar"} onClick={() => setView("calendar")}>
            🗓️ Calendar
          </button>
          <button role="tab" aria-selected={view === "templates"} onClick={() => setView("templates")}>
            📋 Templates
          </button>
        </div>
        {view === "board" && weekNav}
        {view !== "templates" && activeTemplate && (
          <p className="using-template">
            Planning from <button className="link" onClick={() => setView("templates")}>{activeTemplate.name}</button>
          </p>
        )}
      </header>

      {view === "templates" && (
        <Templates
          home={home}
          data={templates.data}
          refresh={() => {
            templates.refresh();
            refresh();
          }}
          reloadHome={reloadHome}
        />
      )}

      {view === "calendar" && (
        <CalendarView
          home={home}
          me={me}
          week={week}
          setWeek={setWeek}
          weekNav={weekNav}
          ticking={board ? { board, chores, members: home.members, me, today: home.today, toggle, waitingFor } : null}
          onOpenItem={(itemId) => setSheet({ kind: "item", itemId })}
        />
      )}

      {view === "board" && (
        <>
          {error && !board && <p className="empty">😿 {error}</p>}
          {!board && !error && <p className="empty">Fluffing the cushions…</p>}
          {board && home.chores.length === 0 && activeTemplate && (
            <StarterChores templateId={activeTemplate.id} week={week} onAdded={() => (reloadHome(), refresh(), templates.refresh())} />
          )}
          {board && isPast && board.items.length === 0 && <p className="empty">🍂 No plan was made for this week.</p>}
          {board && !(isPast && board.items.length === 0) && (
            <BoardColumns
              board={board}
              setBoard={setBoard}
              columns={columns}
              chores={chores}
              members={home.members}
              me={me}
              today={home.today}
              readOnlyAdd={isPast}
              mutate={mutate}
              toggle={toggle}
              waitingFor={waitingFor}
              onAdd={(memberId) => setSheet({ kind: "add", memberId })}
              onOpen={(itemId) => setSheet({ kind: "item", itemId })}
            />
          )}
        </>
      )}

      {sheet?.kind === "add" && (
        <AddItemSheet
          week={week}
          memberId={sheet.memberId}
          members={home.members}
          chores={home.chores}
          templateRules={activeTemplate?.rules ?? []}
          onClose={() => setSheet(null)}
          onAdded={() => (reloadHome(), refresh())}
        />
      )}
      {sheet?.kind === "item" && board && (
        <ItemSheet
          item={board.items.find((i) => i.id === sheet.itemId)}
          chores={chores}
          members={home.members}
          onClose={() => setSheet(null)}
          onChanged={() => (reloadHome(), refresh())}
        />
      )}
      {sheet?.kind === "menu" && (
        <WeekMenu
          week={week}
          templates={templates.data}
          onClose={() => setSheet(null)}
          onReset={async () => {
            if (!confirm("Start this week over from the template in use? Ticks for this week will be cleared.")) return;
            const fresh = await attempt(() => api<Board>("POST", `/api/board/${week}/reset`));
            if (fresh) setBoard(fresh);
            toast("Fresh start 🌱");
            setSheet(null);
          }}
          onSaveTo={(templateId, name) =>
            mutate(async () => {
              await api("POST", `/api/board/${week}/save-to-template`, { templateId });
              toast(`Saved into “${name}” 📋`);
              templates.refresh();
              setSheet(null);
            })
          }
        />
      )}
    </section>
  );
}

function WeekMenu({
  week,
  templates,
  onClose,
  onReset,
  onSaveTo,
}: {
  week: string;
  templates: TemplatesData | null;
  onClose: () => void;
  onReset: () => void;
  onSaveTo: (templateId: string, name: string) => void;
}) {
  const [target, setTarget] = useState(templates?.activeTemplateId ?? "");
  const chosen = templates?.templates.find((t) => t.id === target);
  return (
    <Sheet title={`Week of ${prettyWeek(week)}`} onClose={onClose}>
      <div className="stack">
        <label className="field">
          <span>Save this week's chores into a template</span>
          <div className="row">
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {templates?.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.id === templates.activeTemplateId ? " (in use)" : ""}
                </option>
              ))}
            </select>
            <button className="btn" disabled={!chosen} onClick={() => chosen && onSaveTo(chosen.id, chosen.name)}>
              📋 Save
            </button>
          </div>
          <small>This replaces that template's chores with this week's.</small>
        </label>
        <button className="btn danger" onClick={onReset}>
          🌱 Start this week over from the template in use
        </button>
      </div>
    </Sheet>
  );
}

// ---- board with drag and drop ----------------------------------------------

interface ColumnsProps {
  board: Board;
  setBoard: (b: Board) => void;
  columns: { key: string; member: Member | null }[];
  chores: Map<string, Chore>;
  members: Member[];
  me: Member | null;
  today: string;
  readOnlyAdd: boolean;
  mutate: (fn: () => Promise<unknown>) => Promise<void>;
  toggle: (item: BoardItem, slot: Slot) => void;
  waitingFor: (item: BoardItem, slot: Slot) => Chore | undefined;
  onAdd: (memberId: string | null) => void;
  onOpen: (itemId: string) => void;
}

// A shared chore shows in each of its people's columns, so a card's drag id is item + column.
const cardId = (itemId: string, col: string) => `${itemId}|${col}`;
const parseCardId = (id: string) => {
  const [itemId, col] = id.split("|");
  return { itemId, col };
};

function BoardColumns(props: ColumnsProps) {
  const { board, setBoard, columns, chores, members, me, today, mutate } = props;
  const [activeId, setActiveId] = useState<string | null>(null);
  // While dragging, the layout lives here so background refreshes can't yank cards around.
  const [dragLayout, setDragLayout] = useState<Record<string, string[]> | null>(null);

  const layout = useMemo(() => {
    const out: Record<string, string[]> = Object.fromEntries(columns.map((c) => [c.key, [] as string[]]));
    for (const item of [...board.items].sort((a, b) => a.position - b.position)) {
      const cols = item.assigneeIds.filter((id) => id in out);
      for (const col of cols.length ? cols : [UNASSIGNED]) out[col].push(cardId(item.id, col));
    }
    return out;
  }, [board.items, columns]);
  const current = dragLayout ?? layout;
  const itemsById = useMemo(() => new Map(board.items.map((i) => [i.id, i])), [board.items]);
  const completionsByItem = useMemo(() => {
    const map = new Map<string, Completion[]>();
    for (const c of board.completions) map.set(c.itemId, [...(map.get(c.itemId) ?? []), c]);
    return map;
  }, [board.completions]);

  const sensors = useSensors(
    // Mouse only: a pointer sensor would also grab touches, fighting the page scroll on phones.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Touch needs a press-and-hold; moving the finger sooner than that scrolls instead.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const findColumn = (id: string, lay: Record<string, string[]>) =>
    id in lay ? id : Object.keys(lay).find((k) => lay[k].includes(id));

  const onDragStart = (e: DragStartEvent) => {
    // A little buzz so you can feel the card has been picked up (Android only).
    navigator.vibrate?.(12);
    setActiveId(String(e.active.id));
    setDragLayout(layout);
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || !dragLayout) return;
    const from = findColumn(String(active.id), dragLayout);
    const to = findColumn(String(over.id), dragLayout);
    if (!from || !to || from === to) return;
    const target = dragLayout[to];
    const overIndex = target.indexOf(String(over.id));
    const insertAt = overIndex >= 0 ? overIndex : target.length;
    setDragLayout({
      ...dragLayout,
      [from]: dragLayout[from].filter((id) => id !== active.id),
      [to]: [...target.slice(0, insertAt), String(active.id), ...target.slice(insertAt)],
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const lay = dragLayout;
    setActiveId(null);
    setDragLayout(null);
    if (!over || !lay) return;
    const dragId = String(active.id);
    const { itemId, col: fromCol } = parseCardId(dragId);
    const toCol = findColumn(dragId, lay)!;
    let ids = lay[toCol];
    const overIndex = ids.indexOf(String(over.id));
    const fromIndex = ids.indexOf(dragId);
    if (overIndex >= 0 && overIndex !== fromIndex) {
      ids = [...ids];
      ids.splice(fromIndex, 1);
      ids.splice(overIndex, 0, dragId);
    }
    const index = ids.indexOf(dragId);
    const neighbour = (i: number) => (ids[i] ? itemsById.get(parseCardId(ids[i]).itemId)?.position : undefined);
    const before = neighbour(index - 1);
    const after = neighbour(index + 1);
    const position =
      before !== undefined && after !== undefined
        ? (before + after) / 2
        : before !== undefined
          ? before + 1
          : after !== undefined
            ? after - 1
            : 1;
    const item = itemsById.get(itemId)!;
    // Moving a card hands that person's share to whoever it's dropped on.
    let assigneeIds = item.assigneeIds;
    if (fromCol !== toCol) {
      assigneeIds = assigneeIds.filter((id) => id !== fromCol);
      if (toCol !== UNASSIGNED && !assigneeIds.includes(toCol)) assigneeIds = [...assigneeIds, toCol];
    }
    if (assigneeIds === item.assigneeIds && item.position === position) return;
    setBoard({ ...board, items: board.items.map((i) => (i.id === itemId ? { ...i, assigneeIds, position } : i)) });
    mutate(() => api("PATCH", `/api/items/${itemId}`, { assigneeIds, position }));
  };

  const active = activeId ? itemsById.get(parseCardId(activeId).itemId) : undefined;
  const cardProps = (item: BoardItem) => {
    const { slots, extra } = slotsFor(item, board.week, completionsByItem.get(item.id) ?? []);
    return {
      item,
      chore: chores.get(item.choreId),
      slots,
      extra,
      members,
      today,
      waitingFor: (slot: Slot) => props.waitingFor(item, slot),
    };
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => (setActiveId(null), setDragLayout(null))}
    >
      <div className="board">
        {columns.map(({ key, member }) => {
          const ids = current[key] ?? [];
          const items = ids.map((id) => itemsById.get(parseCardId(id).itemId)!).filter(Boolean);
          const planned = items.reduce((sum, i) => sum + itemMinutes(i, chores), 0);
          const done = member
            ? board.completions.reduce((sum, c) => {
                const it = itemsById.get(c.itemId);
                return it && creditedMembers(c.memberId, it.assigneeIds).includes(member.id) ? sum + tickMinutes(it, chores) : sum;
              }, 0)
            : 0;
          return (
            <Column
              key={key}
              id={key}
              member={member}
              summary={member ? `${formatMinutes(done)} done · ${formatMinutes(planned)} planned` : `${items.length} up for grabs`}
              onAdd={props.readOnlyAdd ? undefined : () => props.onAdd(member?.id ?? null)}
            >
              <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                {ids.map((id) => {
                  const item = itemsById.get(parseCardId(id).itemId);
                  if (!item) return null;
                  return (
                    <SortableCard
                      key={id}
                      id={id}
                      {...cardProps(item)}
                      canComplete={!!me && (item.assigneeIds.includes(me.id) || item.assigneeIds.length === 0)}
                      onToggle={(slot) => props.toggle(item, slot)}
                      onOpen={() => props.onOpen(item.id)}
                    />
                  );
                })}
              </SortableContext>
            </Column>
          );
        })}
      </div>
      <DragOverlay dropAnimation={{ duration: 180, easing: "ease-out" }}>
        {active && <ChoreCard {...cardProps(active)} lifted />}
      </DragOverlay>
    </DndContext>
  );
}

export const itemMinutes = (i: BoardItem, chores: Map<string, Chore>) => {
  const c = chores.get(i.choreId);
  return c ? weeklyMinutes(c.minutes, c.per, goesPerWeek(i), i.everyWeeks) : 0;
};
export const tickMinutes = (i: BoardItem, chores: Map<string, Chore>) => {
  const c = chores.get(i.choreId);
  return c ? minutesPerCompletion(c.minutes, c.per, goesPerWeek(i), i.everyWeeks) : 0;
};

function Column({
  id,
  member,
  summary,
  onAdd,
  children,
}: {
  id: string;
  member: Member | null;
  summary: string;
  onAdd?: () => void;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`column ${isOver ? "over" : ""} ${member ? "" : "grabs"}`}
      style={member ? ({ "--col": memberColor(member.color) } as React.CSSProperties) : undefined}
    >
      <div className="column-head">
        {member ? <Avatar member={member} /> : <span className="avatar grabs-avatar">🎁</span>}
        <div>
          <h3>{member ? member.name : "Up for grabs"}</h3>
          <small>{summary}</small>
        </div>
      </div>
      <div className="column-body">{children}</div>
      {onAdd && (
        <button className="add-card" onClick={onAdd}>
          + Add a chore
        </button>
      )}
    </div>
  );
}

interface CardProps {
  item: BoardItem;
  chore: Chore | undefined;
  slots: Slot[];
  extra: number;
  members: Member[];
  today: string;
  /** Shows the big Completed button (your own chores and ones up for grabs). */
  canComplete?: boolean;
  waitingFor?: (slot: Slot) => Chore | undefined;
  onToggle?: (slot: Slot) => void;
  onOpen?: () => void;
  lifted?: boolean;
}

function SortableCard({ id, ...props }: CardProps & { id: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}
      {...attributes}
      {...listeners}
      aria-roledescription="Draggable chore. Press space to pick up, arrows to move."
    >
      <ChoreCard {...props} />
    </div>
  );
}

// Stops presses on buttons inside a card from also starting a drag.
export const noDrag = {
  onMouseDown: (e: React.SyntheticEvent) => e.stopPropagation(),
  onTouchStart: (e: React.SyntheticEvent) => e.stopPropagation(),
  onKeyDown: (e: React.SyntheticEvent) => e.stopPropagation(),
};

const SPARKLES = ["✨", "🎉", "⭐", "💛", "✨", "🌟", "🎊", "💚"];

export function ChoreCard({ item, chore, slots, extra, members, today, canComplete, waitingFor, onToggle, onOpen, lifted }: CardProps) {
  // Which dot to pop, and whether to play the big finish. Both are set only by a
  // press here, so cards that load already done don't replay their celebration.
  const [poppedDot, setPoppedDot] = useState<number | null>(null);
  const [celebrating, setCelebrating] = useState(false);
  if (!chore) return null;
  const finished = slots.length > 0 && slots.every((s) => s.completion);
  const memberById = new Map(members.map((m) => [m.id, m]));
  const doneCount = slots.filter((s) => s.completion).length;

  const tick = (slot: Slot) => {
    // A locked go doesn't celebrate; the toggle explains what it's waiting for.
    if (!slot.completion && !waitingFor?.(slot)) {
      setPoppedDot(slots.indexOf(slot));
      if (doneCount + 1 === slots.length) setCelebrating(true);
    }
    onToggle?.(slot);
  };
  const next = nextSlot(slots, today);
  const blocker = next && waitingFor?.(next);

  return (
    <div
      className={`chore-card ${finished ? "finished" : ""} ${celebrating ? "celebrate" : ""} ${lifted ? "lifted" : ""}`}
      onAnimationEnd={(e) => e.target === e.currentTarget && setCelebrating(false)}
    >
      {finished && (
        <div className="done-badge" aria-hidden>
          <span className="done-tick">✔</span>
          {celebrating && (
            <span className="sparkles">
              {SPARKLES.map((s, i) => (
                <span key={i} style={{ "--angle": `${i * 45}deg` } as React.CSSProperties}>
                  {s}
                </span>
              ))}
            </span>
          )}
        </div>
      )}
      <button className="chore-main" onClick={onOpen} aria-label={`${chore.title} details`}>
        <span className="chore-emoji" aria-hidden>
          {chore.emoji}
        </span>
        <span className="chore-text">
          <strong>{chore.title}</strong>
          <small>
            {describeEstimate(chore.minutes, chore.per)} · {describeSchedule(item)}
          </small>
        </span>
        {item.assigneeIds.length > 1 && <AssigneeAvatars ids={item.assigneeIds} members={members} size={20} />}
      </button>
      <div className="dots" {...noDrag}>
        {slots.map((slot, i) => {
          const c = slot.completion;
          const who = c?.memberId ? memberById.get(c.memberId) : undefined;
          const status = slotStatus(slot, today);
          const locked = !c && !!waitingFor?.(slot);
          return (
            <button
              key={i}
              className={`dot ${c ? "on" : status} ${locked ? "locked" : ""} ${c && poppedDot === i ? "popping" : ""}`}
              style={c ? { background: who ? memberColor(who.color) : "var(--ink-soft)" } : undefined}
              aria-label={
                c
                  ? `Done${who ? ` by ${who.name}` : ""}${slot.day ? ` on ${slot.label}` : ""} — tap to undo`
                  : locked
                    ? `${slot.label || "Next go"} is waiting for another chore`
                    : `Mark ${slot.day ? `${slot.label} ` : "one "}done${status === "missed" ? " (missed)" : ""}`
              }
              title={c ? `${who?.name ?? "Someone"} · ${new Date(c.doneAt).toLocaleString()}` : slot.day ?? "Mark done"}
              onClick={() => tick(slot)}
              onAnimationEnd={() => setPoppedDot(null)}
            >
              {c ? who ? <BuddySprite buddy={who.buddy} size={20} /> : "✓" : slot.label}
            </button>
          );
        })}
        {extra > 0 && <span className="extra">+{extra}</span>}
        {slots.length > 1 && !finished && (
          <span className="progress">
            {doneCount} of {slots.length}
          </span>
        )}
      </div>
      {!finished && blocker && (
        <p className="waiting">
          🔒 Waiting for {blocker.emoji} {blocker.title}
        </p>
      )}
      {finished ? (
        <p className="done-label" role="status">
          Completed
        </p>
      ) : (
        canComplete &&
        next && (
          <button className="complete-btn" {...noDrag} disabled={!!blocker} onClick={() => tick(next)}>
            {blocker ? "🔒 Not yet" : "✓ Completed"}
          </button>
        )
      )}
    </div>
  );
}

// ---- sheets -----------------------------------------------------------------

function AddItemSheet({
  week,
  memberId,
  members,
  chores,
  templateRules,
  onClose,
  onAdded,
}: {
  week: string;
  memberId: string | null;
  members: Member[];
  chores: Chore[];
  templateRules: (Schedule & { choreId: string })[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [step, setStep] = useState<"pick" | "new" | "details">(chores.length ? "pick" : "new");
  const [chore, setChore] = useState<Chore | null>(null);
  const [schedule, setSchedule] = useState<Schedule>(NEW_SCHEDULE);
  const [assigneeIds, setAssigneeIds] = useState<string[]>(memberId ? [memberId] : []);
  const [busy, setBusy] = useState(false);
  const who = members.find((m) => m.id === memberId);

  const choose = (c: Chore) => {
    // Start from how the template in use does this chore, if it has it.
    const rule = templateRules.find((r) => r.choreId === c.id);
    setSchedule(
      rule
        ? { kind: rule.kind, timesPerWeek: rule.timesPerWeek, days: rule.days, everyWeeks: 1, time: rule.time, afterChoreId: rule.afterChoreId }
        : NEW_SCHEDULE,
    );
    setChore(c);
    setStep("details");
  };

  return (
    <Sheet title={who ? `Add a chore for ${who.name}` : "Add a chore this week"} onClose={onClose}>
      {step === "new" && (
        <ChoreForm
          submitLabel="Next →"
          onSubmit={async (c) => {
            const created = await api<Chore>("POST", "/api/chores", c);
            onAdded();
            choose(created);
          }}
        />
      )}
      {step === "pick" && (
        <div className="stack">
          <button className="btn primary" onClick={() => setStep("new")}>
            ✨ A brand new chore
          </button>
          <p className="muted">…or pick one you've used before:</p>
          <div className="library">
            {chores.map((c) => (
              <button key={c.id} className="library-item" onClick={() => choose(c)}>
                <span aria-hidden>{c.emoji}</span>
                <span>{c.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {step === "details" && chore && (
        <div className="stack">
          <p className="picked">
            {chore.emoji} <strong>{chore.title}</strong>
          </p>
          <div className="field">
            <span>How often this week?</span>
            <ScheduleEditor
              value={schedule}
              onChange={setSchedule}
              allowRepeat={false}
              afterOptions={chores.filter((c) => c.id !== chore.id)}
            />
          </div>
          <div className="field">
            <span>Who's doing it?</span>
            <AssigneePicker members={members} value={assigneeIds} onChange={setAssigneeIds} />
          </div>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const ok = await attempt(() => api("POST", `/api/board/${week}/items`, { choreId: chore.id, assigneeIds, ...schedule }));
              setBusy(false);
              if (ok) {
                toast("Added 🧺");
                onAdded();
                onClose();
              }
            }}
          >
            Add to this week
          </button>
        </div>
      )}
    </Sheet>
  );
}

function ItemSheet({
  item,
  chores,
  members,
  onClose,
  onChanged,
}: {
  item: BoardItem | undefined;
  chores: Map<string, Chore>;
  members: Member[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [editingChore, setEditingChore] = useState(false);
  const [schedule, setSchedule] = useState<Schedule | null>(item ? { ...item } : null);
  const chore = item && chores.get(item.choreId);
  if (!item || !chore || !schedule) return null;
  const run = (fn: () => Promise<unknown>, close = true) =>
    attempt(async () => {
      await fn();
      onChanged();
      if (close) onClose();
    });
  const scheduleChanged = (["kind", "days", "timesPerWeek", "time", "afterChoreId"] as const).some((k) => schedule[k] !== item[k]);
  return (
    <Sheet title={`${chore.emoji} ${chore.title}`} onClose={onClose}>
      {editingChore ? (
        <>
          <p className="muted">Changes apply everywhere this chore appears.</p>
          <ChoreForm initial={chore} submitLabel="Save chore" onSubmit={(c) => run(() => api("PATCH", `/api/chores/${chore.id}`, c))} />
        </>
      ) : (
        <div className="stack">
          <p className="muted small">Changes here are for this week only — edit a template to change every week.</p>
          <div className="field">
            <span>Who's doing it this week?</span>
            <AssigneePicker
              members={members}
              value={item.assigneeIds}
              onChange={(ids) => run(() => api("PATCH", `/api/items/${item.id}`, { assigneeIds: ids }), false)}
            />
          </div>
          <div className="field">
            <span>How often this week?</span>
            <ScheduleEditor
              value={schedule}
              onChange={setSchedule}
              allowRepeat={false}
              afterOptions={[...chores.values()].filter((c) => c.id !== chore.id)}
            />
            {scheduleChanged && (
              <button className="btn primary" onClick={() => run(() => api("PATCH", `/api/items/${item.id}`, schedule), false)}>
                Save
              </button>
            )}
            <small className="muted">
              About {formatMinutes(weeklyMinutes(chore.minutes, chore.per, goesPerWeek(schedule), item.everyWeeks))} this week (
              {describeEstimate(chore.minutes, chore.per)}).
            </small>
          </div>
          <button className="btn" onClick={() => setEditingChore(true)}>
            ✏️ Edit chore name, icon or time
          </button>
          <button className="btn" onClick={() => run(() => api("DELETE", `/api/items/${item.id}`))}>
            ➖ Take off this week
          </button>
          <button
            className="btn danger"
            onClick={() => {
              if (confirm(`Delete "${chore.title}" for good? It'll be removed from every template and from this week on.`))
                run(() => api("DELETE", `/api/chores/${chore.id}`));
            }}
          >
            🗑️ Delete this chore everywhere
          </button>
        </div>
      )}
    </Sheet>
  );
}

const STARTERS: (Omit<Chore, "id"> & Partial<Schedule>)[] = [
  { title: "Washing up", emoji: "🍽️", minutes: 20, per: "each", kind: "days", days: 0b1111111 },
  { title: "Cooking dinner", emoji: "🍳", minutes: 45, per: "each", kind: "days", days: 0b1111111 },
  { title: "Laundry", emoji: "🧺", minutes: 40, per: "each", timesPerWeek: 2 },
  { title: "Hoovering", emoji: "🧹", minutes: 30, per: "each" },
  { title: "Bins out", emoji: "🗑️", minutes: 10, per: "each", kind: "days", days: 0b0001000 },
  { title: "Clean the bathroom", emoji: "🚿", minutes: 30, per: "each" },
  { title: "Food shop", emoji: "🛒", minutes: 60, per: "each", kind: "days", days: 0b0100000 },
  { title: "Water the plants", emoji: "🪴", minutes: 10, per: "each", timesPerWeek: 2 },
  { title: "Change the bedsheets", emoji: "🛏️", minutes: 30, per: "each", kind: "days", days: 0b1000000, everyWeeks: 2 },
];

function StarterChores({ templateId, week, onAdded }: { templateId: string; week: string; onAdded: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="card starter">
      <h3>🌱 An empty board!</h3>
      <p>
        Add chores with the “+ Add a chore” buttons, or start with a handful of common ones. They all start up for grabs,
        so you can drag them to people, and they go into the template in use so every week starts the same way.
      </p>
      <button
        className="btn primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await attempt(async () => {
            for (const { title, emoji, minutes, per, ...rest } of STARTERS) {
              const chore = await api<Chore>("POST", "/api/chores", { title, emoji, minutes, per });
              const schedule = { ...NEW_SCHEDULE, ...rest };
              await api("POST", `/api/templates/${templateId}/rules`, { choreId: chore.id, assigneeIds: [], anchorWeek: week, ...schedule });
              await api("POST", `/api/board/${week}/items`, { choreId: chore.id, assigneeIds: [], ...schedule, everyWeeks: 1 });
            }
          });
          setBusy(false);
          onAdded();
        }}
      >
        {busy ? "Adding…" : "Add starter chores"}
      </button>
    </div>
  );
}

