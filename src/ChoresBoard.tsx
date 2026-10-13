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
import { useMemo, useState } from "react";
import {
  type Board,
  type BoardItem,
  type Chore,
  type Completion,
  type HomeData,
  type Member,
  type Per,
  TEMPLATE,
  addDays,
  defaultTimesPerWeek,
  describeEstimate,
  formatMinutes,
  minutesPerCompletion,
  weeklyMinutes,
} from "../shared/core";
import { api } from "./api";
import { Avatar, CHORE_EMOJIS, EmojiChoices, Sheet, attempt, memberColor, prettyWeek, toast, usePolled } from "./ui";

const UNASSIGNED = "unassigned";
const colKey = (memberId: string | null) => memberId ?? UNASSIGNED;

interface Props {
  home: HomeData;
  me: Member | null;
  reloadHome: () => void;
}

export function ChoresBoard({ home, me, reloadHome }: Props) {
  const [mode, setMode] = useState<"week" | "template">("week");
  const [week, setWeek] = useState(home.currentWeek);
  const boardKey = mode === "template" ? TEMPLATE : week;
  const { data: board, setData: setBoard, refresh, error } = usePolled<Board>(
    () => api("GET", `/api/board/${boardKey}`),
    [boardKey],
  );
  const [sheet, setSheet] = useState<
    { kind: "add"; memberId: string | null } | { kind: "item"; itemId: string } | { kind: "menu" } | null
  >(null);

  const chores = useMemo(() => new Map(home.chores.map((c) => [c.id, c])), [home.chores]);
  const isTemplate = boardKey === TEMPLATE;
  const isPast = !isTemplate && week < home.currentWeek;

  // Server writes are fire-and-refresh: the UI updates straight away and the next load settles it.
  const mutate = async (fn: () => Promise<unknown>) => {
    await attempt(fn);
    refresh();
  };

  const columns: { key: string; member: Member | null }[] = [
    ...home.members.map((m) => ({ key: m.id, member: m })),
    { key: UNASSIGNED, member: null },
  ];

  return (
    <section className="page">
      <header className="page-head">
        <div className="segmented" role="tablist" aria-label="Which board">
          <button role="tab" aria-selected={mode === "week"} onClick={() => setMode("week")}>
            📅 This week
          </button>
          <button role="tab" aria-selected={mode === "template"} onClick={() => setMode("template")}>
            📋 Default plan
          </button>
        </div>
        {mode === "week" ? (
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
        ) : (
          <p className="banner">
            This is the plan every new week starts from. Changing it updates upcoming weeks nobody has touched yet —
            this week stays as it is.
          </p>
        )}
      </header>

      {error && !board && <p className="empty">😿 {error}</p>}
      {!board && !error && <p className="empty">Fluffing the cushions…</p>}

      {board && home.chores.length === 0 && (
        <StarterChores onAdded={() => (reloadHome(), refresh())} week={boardKey} />
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
          isTemplate={isTemplate}
          readOnlyAdd={isPast}
          mutate={mutate}
          onAdd={(memberId) => setSheet({ kind: "add", memberId })}
          onOpen={(itemId) => setSheet({ kind: "item", itemId })}
        />
      )}

      {sheet?.kind === "add" && (
        <AddChoreSheet
          week={boardKey}
          memberId={sheet.memberId}
          members={home.members}
          chores={home.chores}
          onClose={() => setSheet(null)}
          onAdded={() => (reloadHome(), refresh())}
        />
      )}
      {sheet?.kind === "item" && board && (
        <ItemSheet
          item={board.items.find((i) => i.id === sheet.itemId)}
          chores={chores}
          members={home.members}
          isTemplate={isTemplate}
          onClose={() => setSheet(null)}
          onChanged={() => (reloadHome(), refresh())}
        />
      )}
      {sheet?.kind === "menu" && (
        <Sheet title={`Week of ${prettyWeek(week)}`} onClose={() => setSheet(null)}>
          <div className="stack">
            <button
              className="btn"
              onClick={() =>
                mutate(async () => {
                  await api("POST", `/api/board/${week}/save-as-template`);
                  toast("Saved as the default plan 📋");
                  setSheet(null);
                })
              }
            >
              📋 Make this week the default plan
            </button>
            <button
              className="btn danger"
              onClick={() =>
                mutate(async () => {
                  if (!confirm("Start this week over from the default plan? Ticks for this week will be cleared.")) return;
                  setBoard(await api("POST", `/api/board/${week}/reset`));
                  toast("Fresh start from the default plan 🌱");
                  setSheet(null);
                })
              }
            >
              🌱 Start this week over from the default plan
            </button>
          </div>
        </Sheet>
      )}
    </section>
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
  isTemplate: boolean;
  readOnlyAdd: boolean;
  mutate: (fn: () => Promise<unknown>) => Promise<void>;
  onAdd: (memberId: string | null) => void;
  onOpen: (itemId: string) => void;
}

function BoardColumns(props: ColumnsProps) {
  const { board, setBoard, columns, chores, members, me, isTemplate, mutate } = props;
  const [activeId, setActiveId] = useState<string | null>(null);
  // While dragging, the layout lives here so background refreshes can't yank cards around.
  const [dragLayout, setDragLayout] = useState<Record<string, string[]> | null>(null);

  const layout = useMemo(() => {
    const out: Record<string, string[]> = Object.fromEntries(columns.map((c) => [c.key, [] as string[]]));
    for (const item of [...board.items].sort((a, b) => a.position - b.position)) {
      (out[colKey(item.memberId)] ?? out[UNASSIGNED]).push(item.id);
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
    const id = String(active.id);
    const col = findColumn(id, lay)!;
    let ids = lay[col];
    const overIndex = ids.indexOf(String(over.id));
    const fromIndex = ids.indexOf(id);
    if (overIndex >= 0 && overIndex !== fromIndex) {
      ids = [...ids];
      ids.splice(fromIndex, 1);
      ids.splice(overIndex, 0, id);
    }
    const index = ids.indexOf(id);
    const before = itemsById.get(ids[index - 1])?.position;
    const after = itemsById.get(ids[index + 1])?.position;
    const position =
      before !== undefined && after !== undefined
        ? (before + after) / 2
        : before !== undefined
          ? before + 1
          : after !== undefined
            ? after - 1
            : 1;
    const memberId = col === UNASSIGNED ? null : col;
    const item = itemsById.get(id)!;
    if (item.memberId === memberId && item.position === position) return;
    setBoard({ ...board, items: board.items.map((i) => (i.id === id ? { ...i, memberId, position } : i)) });
    mutate(() => api("PATCH", `/api/items/${id}`, { memberId, position }));
  };

  const toggleDot = (item: BoardItem, completion: Completion | undefined) => {
    if (completion) {
      setBoard({ ...board, completions: board.completions.filter((c) => c.id !== completion.id) });
      mutate(() => api("DELETE", `/api/completions/${completion.id}`));
      return;
    }
    if (!me) return toast("Pick who you are under Family first 🙂");
    const done = (completionsByItem.get(item.id)?.length ?? 0) + 1;
    if (done === item.timesPerWeek) toast(`${chores.get(item.choreId)?.emoji ?? "✨"} All done — thank you, ${me.name}!`);
    const temp: Completion = { id: `tmp-${Date.now()}`, itemId: item.id, memberId: me.id, doneAt: Date.now() };
    setBoard({ ...board, completions: [...board.completions, temp] });
    mutate(() => api("POST", `/api/items/${item.id}/completions`, { memberId: me.id }));
  };

  const activeItem = activeId ? itemsById.get(activeId) : undefined;

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
          const items = ids.map((id) => itemsById.get(id)!).filter(Boolean);
          const planned = items.reduce((sum, i) => sum + itemMinutes(i, chores), 0);
          const done = board.completions.reduce((sum, c) => {
            const it = itemsById.get(c.itemId);
            return c.memberId === (member?.id ?? null) && it ? sum + tickMinutes(it, chores) : sum;
          }, 0);
          return (
            <Column
              key={key}
              id={key}
              member={member}
              summary={
                isTemplate
                  ? `${formatMinutes(planned)} a week`
                  : member
                    ? `${formatMinutes(done)} done · ${formatMinutes(planned)} planned`
                    : `${items.length} up for grabs`
              }
              onAdd={props.readOnlyAdd ? undefined : () => props.onAdd(member?.id ?? null)}
            >
              <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                {items.map((item) => (
                  <SortableCard
                    key={item.id}
                    item={item}
                    chore={chores.get(item.choreId)}
                    completions={completionsByItem.get(item.id) ?? []}
                    members={members}
                    isTemplate={isTemplate}
                    onToggle={toggleDot}
                    onOpen={() => props.onOpen(item.id)}
                  />
                ))}
              </SortableContext>
            </Column>
          );
        })}
      </div>
      <DragOverlay dropAnimation={{ duration: 180, easing: "ease-out" }}>
        {activeItem && (
          <ChoreCard
            item={activeItem}
            chore={chores.get(activeItem.choreId)}
            completions={completionsByItem.get(activeItem.id) ?? []}
            members={members}
            isTemplate={isTemplate}
            lifted
          />
        )}
      </DragOverlay>
    </DndContext>
  );
}

const itemMinutes = (i: BoardItem, chores: Map<string, Chore>) => {
  const c = chores.get(i.choreId);
  return c ? weeklyMinutes(c.minutes, c.per, i.timesPerWeek) : 0;
};
const tickMinutes = (i: BoardItem, chores: Map<string, Chore>) => {
  const c = chores.get(i.choreId);
  return c ? minutesPerCompletion(c.minutes, c.per, i.timesPerWeek) : 0;
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
  completions: Completion[];
  members: Member[];
  isTemplate: boolean;
  onToggle?: (item: BoardItem, completion: Completion | undefined) => void;
  onOpen?: () => void;
  lifted?: boolean;
}

function SortableCard(props: CardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.item.id });
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

function ChoreCard({ item, chore, completions, members, isTemplate, onToggle, onOpen, lifted }: CardProps) {
  if (!chore) return null;
  const total = item.timesPerWeek;
  const finished = !isTemplate && completions.length >= total;
  const memberById = new Map(members.map((m) => [m.id, m]));
  return (
    <div className={`chore-card ${finished ? "finished" : ""} ${lifted ? "lifted" : ""}`}>
      <button className="chore-main" onClick={onOpen} aria-label={`${chore.title} details`}>
        <span className="chore-emoji" aria-hidden>
          {chore.emoji}
        </span>
        <span className="chore-text">
          <strong>{chore.title}</strong>
          <small>
            {describeEstimate(chore.minutes, chore.per)}
            {total > 1 ? ` · ${total}× a week` : " · once a week"}
          </small>
        </span>
      </button>
      {!isTemplate && (
        <div className="dots" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {Array.from({ length: total }, (_, i) => {
            const c = completions[i];
            const who = c?.memberId ? memberById.get(c.memberId) : undefined;
            return (
              <button
                key={i}
                className={`dot ${c ? "on" : ""}`}
                style={c ? { background: who ? memberColor(who.color) : "var(--ink-soft)" } : undefined}
                aria-label={c ? `Done${who ? ` by ${who.name}` : ""} — tap to undo` : "Mark one done"}
                title={c ? `${who?.name ?? "Someone"} · ${new Date(c.doneAt).toLocaleString()}` : "Mark done"}
                onClick={() => onToggle?.(item, c)}
              >
                {c ? (who?.emoji ?? "✓") : ""}
              </button>
            );
          })}
          {completions.length > total && <span className="extra">+{completions.length - total}</span>}
        </div>
      )}
    </div>
  );
}

// ---- sheets -----------------------------------------------------------------

function ChoreForm({
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
  const [times, setTimes] = useState(String(initial?.timesPerWeek ?? 1));
  const [busy, setBusy] = useState(false);
  const weekly = weeklyMinutes(Number(minutes) || 0, per, Number(times) || 1);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await attempt(() => onSubmit({ title, emoji, minutes: Number(minutes), per, timesPerWeek: Number(times) }));
        setBusy(false);
      }}
    >
      <label className="field">
        <span>Chore</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Unload the dishwasher" maxLength={80} />
      </label>
      <div className="field">
        <span>Icon</span>
        <EmojiChoices options={CHORE_EMOJIS} value={emoji} onChange={setEmoji} label="Chore icon" />
      </div>
      <div className="field">
        <span>Roughly how long?</span>
        <div className="row">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className="narrow"
            aria-label="Minutes"
          />
          <span>minutes</span>
          <select
            value={per}
            onChange={(e) => {
              const p = e.target.value as Per;
              setPer(p);
              setTimes(String(defaultTimesPerWeek(p)));
            }}
            aria-label="Measured per"
          >
            <option value="each">each time</option>
            <option value="day">a day</option>
            <option value="week">a week</option>
            <option value="month">a month</option>
          </select>
        </div>
      </div>
      <label className="field">
        <span>Tick boxes per week</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={21}
          value={times}
          onChange={(e) => setTimes(e.target.value)}
          className="narrow"
        />
        <small>How many times it gets ticked off. Counts as about {formatMinutes(weekly)} a week.</small>
      </label>
      <button className="btn primary" disabled={busy || !title.trim() || !(Number(minutes) > 0)}>
        {submitLabel}
      </button>
    </form>
  );
}

function AddChoreSheet({
  week,
  memberId,
  members,
  chores,
  onClose,
  onAdded,
}: {
  week: string;
  memberId: string | null;
  members: Member[];
  chores: Chore[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [creating, setCreating] = useState(chores.length === 0);
  const who = members.find((m) => m.id === memberId);
  const add = async (choreId: string) => {
    await api("POST", `/api/board/${week}/items`, { choreId, memberId });
    toast("Added 🧺");
    onAdded();
    onClose();
  };
  return (
    <Sheet title={who ? `Add a chore for ${who.name}` : "Add a chore up for grabs"} onClose={onClose}>
      {creating ? (
        <ChoreForm
          submitLabel="Add chore"
          onSubmit={async (c) => {
            const chore = await api<Chore>("POST", "/api/chores", c);
            await add(chore.id);
          }}
        />
      ) : (
        <div className="stack">
          <button className="btn primary" onClick={() => setCreating(true)}>
            ✨ A brand new chore
          </button>
          <p className="muted">…or pick one you've used before:</p>
          <div className="library">
            {chores.map((c) => (
              <button key={c.id} className="library-item" onClick={() => attempt(() => add(c.id))}>
                <span aria-hidden>{c.emoji}</span>
                <span>{c.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Sheet>
  );
}

function ItemSheet({
  item,
  chores,
  members,
  isTemplate,
  onClose,
  onChanged,
}: {
  item: BoardItem | undefined;
  chores: Map<string, Chore>;
  members: Member[];
  isTemplate: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const chore = item && chores.get(item.choreId);
  if (!item || !chore) return null;
  const where = isTemplate ? "the default plan" : "this week";
  const run = (fn: () => Promise<unknown>, close = true) =>
    attempt(async () => {
      await fn();
      onChanged();
      if (close) onClose();
    });
  return (
    <Sheet title={`${chore.emoji} ${chore.title}`} onClose={onClose}>
      {editing ? (
        <>
          <p className="muted">Changes apply everywhere this chore appears.</p>
          <ChoreForm
            initial={chore}
            submitLabel="Save chore"
            onSubmit={(c) => run(() => api("PATCH", `/api/chores/${chore.id}`, c))}
          />
        </>
      ) : (
        <div className="stack">
          <label className="field">
            <span>Who's doing it ({where})</span>
            <select
              value={item.memberId ?? ""}
              onChange={(e) => run(() => api("PATCH", `/api/items/${item.id}`, { memberId: e.target.value || null }), false)}
            >
              <option value="">🎁 Up for grabs</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.emoji} {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Times {where}</span>
            <div className="row">
              <button
                className="icon-btn"
                aria-label="Fewer"
                disabled={item.timesPerWeek <= 1}
                onClick={() => run(() => api("PATCH", `/api/items/${item.id}`, { timesPerWeek: item.timesPerWeek - 1 }), false)}
              >
                −
              </button>
              <strong className="count">{item.timesPerWeek}</strong>
              <button
                className="icon-btn"
                aria-label="More"
                disabled={item.timesPerWeek >= 21}
                onClick={() => run(() => api("PATCH", `/api/items/${item.id}`, { timesPerWeek: item.timesPerWeek + 1 }), false)}
              >
                +
              </button>
            </div>
            <small>
              About {formatMinutes(weeklyMinutes(chore.minutes, chore.per, item.timesPerWeek))} a week (
              {describeEstimate(chore.minutes, chore.per)}).
            </small>
          </label>
          <button className="btn" onClick={() => setEditing(true)}>
            ✏️ Edit chore name, icon or time
          </button>
          <button className="btn" onClick={() => run(() => api("DELETE", `/api/items/${item.id}`))}>
            ➖ Take off {where}
          </button>
          <button
            className="btn danger"
            onClick={() => {
              if (confirm(`Delete "${chore.title}" for good? It'll be removed from the default plan and upcoming weeks.`))
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

const STARTERS: (Omit<Chore, "id">)[] = [
  { title: "Washing up", emoji: "🍽️", minutes: 20, per: "each", timesPerWeek: 7 },
  { title: "Cooking dinner", emoji: "🍳", minutes: 45, per: "each", timesPerWeek: 7 },
  { title: "Laundry", emoji: "🧺", minutes: 40, per: "each", timesPerWeek: 2 },
  { title: "Hoovering", emoji: "🧹", minutes: 30, per: "each", timesPerWeek: 1 },
  { title: "Bins out", emoji: "🗑️", minutes: 10, per: "week", timesPerWeek: 1 },
  { title: "Clean the bathroom", emoji: "🚿", minutes: 30, per: "each", timesPerWeek: 1 },
  { title: "Food shop", emoji: "🛒", minutes: 60, per: "each", timesPerWeek: 1 },
  { title: "Water the plants", emoji: "🪴", minutes: 10, per: "each", timesPerWeek: 2 },
  { title: "Change the bedsheets", emoji: "🛏️", minutes: 60, per: "month", timesPerWeek: 1 },
];

function StarterChores({ week, onAdded }: { week: string; onAdded: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="card starter">
      <h3>🌱 An empty board!</h3>
      <p>Add chores with the “+ Add a chore” buttons, or start with a handful of common ones (all up for grabs, so you can drag them to people).</p>
      <button
        className="btn primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await attempt(async () => {
            for (const s of STARTERS) {
              const chore = await api<Chore>("POST", "/api/chores", s);
              await api("POST", `/api/board/${week}/items`, { choreId: chore.id, memberId: null });
              // Starters also go in the default plan so next week starts the same way.
              if (week !== TEMPLATE) await api("POST", `/api/board/${TEMPLATE}/items`, { choreId: chore.id, memberId: null });
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
