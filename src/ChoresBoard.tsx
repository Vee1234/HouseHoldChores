import { useEffect, useMemo, useState } from "react";
import {
  type Board,
  type BoardItem,
  type Chore,
  type Completion,
  type HomeData,
  type Member,
  type Schedule,
  type Template,
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
  BackButton,
  ChoreForm,
  NEW_SCHEDULE,
  ScheduleEditor,
  type Slot,
  nextSlot,
  slotStatus,
  slotsFor,
} from "./choreParts";
import { Templates } from "./Templates";
import { TodayChores } from "./TodayChores";
import { Avatar, BuddySprite, Sheet, attempt, memberColor, prettyWeek, toast, usePolled } from "./ui";

type View = "upcoming" | "calendar" | "templates";

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

/** Extra actions for the person boxes. */
export interface Planning {
  /** Hands a chore from one person to another (from = null for one nobody's on yet). */
  handOver: (item: BoardItem, from: string | null, to: string) => void;
  onAdd: (memberId: string) => void;
}

/**
 * Everything for working with one week's chores: the board, ticking things
 * off, handing chores over, and the add/edit sheets. Shared by the Today page
 * and the Chores tab so they behave the same.
 */
export function useChorePlanner({ home, me, reloadHome, week }: Props & { week: string }) {
  const { data: board, setData: setBoard, refresh, error } = usePolled<Board>(() => api("GET", `/api/board/${week}`), [week]);
  const templates = usePolled<TemplatesData>(() => api("GET", "/api/templates"), [], 60000);
  const [sheet, setSheet] = useState<
    { kind: "add"; memberId: string } | { kind: "item"; itemId: string } | { kind: "menu" } | null
  >(null);
  const chores = useMemo(() => new Map(home.chores.map((c) => [c.id, c])), [home.chores]);
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

  const handOver = (item: BoardItem, from: string | null, to: string) => {
    if (!board || from === to) return;
    const assigneeIds = [...new Set([...item.assigneeIds.filter((id) => id !== from), to])];
    setBoard({ ...board, items: board.items.map((i) => (i.id === item.id ? { ...i, assigneeIds } : i)) });
    mutate(() => api("PATCH", `/api/items/${item.id}`, { assigneeIds }));
  };

  const ticking: Ticking | null = board ? { board, chores, members: home.members, me, today: home.today, toggle, waitingFor } : null;
  const planning: Planning = { handOver, onAdd: (memberId) => setSheet({ kind: "add", memberId }) };
  const reloadAll = () => (reloadHome(), refresh(), templates.refresh());

  const sheets = (
    <>
      {sheet?.kind === "add" && (
        <AddItemSheet
          week={week}
          currentWeek={home.currentWeek}
          memberId={sheet.memberId}
          members={home.members}
          chores={home.chores}
          template={activeTemplate}
          onClose={() => setSheet(null)}
          onAdded={reloadAll}
        />
      )}
      {sheet?.kind === "item" && board && (
        <ItemSheet
          item={board.items.find((i) => i.id === sheet.itemId)}
          completions={board.completions.filter((c) => c.itemId === sheet.itemId)}
          onUndo={(item, c) => toggle(item, { day: c.day, label: "", completion: c })}
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
    </>
  );

  return {
    board,
    error,
    refresh,
    templates,
    activeTemplate,
    ticking,
    planning,
    reloadAll,
    openItem: (itemId: string) => setSheet({ kind: "item", itemId }),
    openAdd: (memberId: string) => setSheet({ kind: "add", memberId }),
    openMenu: () => setSheet({ kind: "menu" }),
    sheets,
  };
}

/** The Chores tab: what's coming up this week, the calendar and the templates. */
export function ChoresBoard({ home, me, reloadHome }: Props) {
  const [view, setView] = useState<View>("upcoming");
  const planner = useChorePlanner({ home, me, reloadHome, week: home.currentWeek });
  const { board, error, ticking, activeTemplate } = planner;

  return (
    <section className="page">
      <header className="page-head">
        <div className="chores-head">
          <div className="segmented three" role="tablist" aria-label="Chores view">
            <button role="tab" aria-selected={view === "upcoming"} onClick={() => setView("upcoming")}>
              📆 This Week
            </button>
            <button role="tab" aria-selected={view === "calendar"} onClick={() => setView("calendar")}>
              🗓️ Calendar
            </button>
            <button role="tab" aria-selected={view === "templates"} onClick={() => setView("templates")}>
              📋 Templates
            </button>
          </div>
          <button
            className="btn primary add-chore-btn"
            onClick={() => planner.openAdd(me?.id ?? home.members[0]?.id ?? "")}
            disabled={!home.members.length}
          >
            ＋ Add chore
          </button>
        </div>
        {view !== "templates" && activeTemplate && (
          <p className="using-template">
            Planning from <button className="link" onClick={() => setView("templates")}>{activeTemplate.name}</button> ·{" "}
            <button className="link" onClick={planner.openMenu}>
              Week options
            </button>
          </p>
        )}
      </header>

      {view === "templates" && (
        <Templates home={home} data={planner.templates.data} refresh={planner.reloadAll} reloadHome={reloadHome} />
      )}

      {view === "upcoming" &&
        (ticking && board?.week === home.currentWeek ? (
          <>
            {home.chores.length === 0 && activeTemplate && me && (
              <StarterChores templateId={activeTemplate.id} week={home.currentWeek} me={me} onAdded={planner.reloadAll} />
            )}
            <TodayChores show="week" ticking={ticking} planning={planner.planning} onOpenItem={planner.openItem} />
          </>
        ) : (
          <p className="empty">{error ? `😿 ${error}` : "Fluffing the cushions…"}</p>
        ))}

      {view === "calendar" && <CalendarView home={home} me={me} />}

      {planner.sheets}
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

export const itemMinutes = (i: BoardItem, chores: Map<string, Chore>) => {
  const c = chores.get(i.choreId);
  return c ? weeklyMinutes(c.minutes, c.per, goesPerWeek(i), i.everyWeeks) : 0;
};
export const tickMinutes = (i: BoardItem, chores: Map<string, Chore>) => {
  const c = chores.get(i.choreId);
  return c ? minutesPerCompletion(c.minutes, c.per, goesPerWeek(i), i.everyWeeks) : 0;
};

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

/**
 * Adding a chore: either every week (it goes into the template in use, which
 * the board follows) or just for the week being looked at.
 */
function AddItemSheet({
  week,
  currentWeek,
  memberId,
  members,
  chores,
  template,
  onClose,
  onAdded,
}: {
  week: string;
  currentWeek: string;
  memberId: string;
  members: Member[];
  chores: Chore[];
  template: Template | undefined;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [step, setStep] = useState<"pick" | "new" | "details">(chores.length ? "pick" : "new");
  const [chore, setChore] = useState<Chore | null>(null);
  const [schedule, setSchedule] = useState<Schedule>(NEW_SCHEDULE);
  const [assigneeIds, setAssigneeIds] = useState<string[]>([memberId]);
  const [howLong, setHowLong] = useState<"every" | "once">(template ? "every" : "once");
  const [busy, setBusy] = useState(false);
  const existingRule = chore && template?.rules.find((r) => r.choreId === chore.id);
  const everyWeek = howLong === "every" && !!template;

  const choose = (c: Chore) => {
    // Start from how the template in use does this chore, if it has it.
    const rule = template?.rules.find((r) => r.choreId === c.id);
    // Only the schedule fields: the rule's people and ids mustn't ride along into the save.
    setSchedule(
      rule
        ? {
            kind: rule.kind,
            timesPerWeek: rule.timesPerWeek,
            days: rule.days,
            everyWeeks: rule.everyWeeks,
            time: rule.time,
            afterChoreId: rule.afterChoreId,
          }
        : NEW_SCHEDULE,
    );
    if (rule?.assigneeIds.length) setAssigneeIds(rule.assigneeIds);
    setChore(c);
    setStep("details");
  };

  const save = async () => {
    if (!chore) return;
    setBusy(true);
    const ok = await attempt(() =>
      !everyWeek
        ? api("POST", `/api/board/${week}/items`, { choreId: chore.id, assigneeIds, ...schedule, everyWeeks: 1 })
        : existingRule
          ? api("PATCH", `/api/rules/${existingRule.id}`, { assigneeIds, ...schedule })
          : api("POST", `/api/templates/${template!.id}/rules`, { choreId: chore.id, assigneeIds, anchorWeek: currentWeek, ...schedule }),
    );
    setBusy(false);
    if (ok) {
      toast(everyWeek ? `Added to “${template!.name}” — it's on the board from today 🧺` : "Added for that week 🧺");
      onAdded();
      onClose();
    }
  };

  return (
    <Sheet title="Add a chore" onClose={onClose}>
      {step === "new" && (
        <>
          {chores.length > 0 && <BackButton onClick={() => setStep("pick")} />}
          <ChoreForm
            submitLabel="Next →"
            onSubmit={async (c) => {
              const created = await api<Chore>("POST", "/api/chores", c);
              onAdded();
              choose(created);
            }}
          />
        </>
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
          <BackButton onClick={() => setStep("pick")} />
          <p className="picked">
            {chore.emoji} <strong>{chore.title}</strong>
          </p>
          {template && (
            <div className="field">
              <span>For how long?</span>
              <div className="segmented small" role="radiogroup" aria-label="For how long">
                <button type="button" role="radio" aria-checked={everyWeek} aria-selected={everyWeek} onClick={() => setHowLong("every")}>
                  Every week
                </button>
                <button type="button" role="radio" aria-checked={!everyWeek} aria-selected={!everyWeek} onClick={() => setHowLong("once")}>
                  {week === currentWeek ? "Just this week" : "Just that week"}
                </button>
              </div>
              <small className="muted">
                {everyWeek
                  ? existingRule
                    ? `It's already in “${template.name}” — saving updates it there, and on the board from today.`
                    : `Goes into “${template.name}”, so it's on the board from today and every week after.`
                  : `Only for the week of ${prettyWeek(week)}.`}
              </small>
            </div>
          )}
          <div className="field">
            <span>How often?</span>
            <ScheduleEditor
              value={schedule}
              onChange={setSchedule}
              allowRepeat={everyWeek}
              afterOptions={chores.filter((c) => c.id !== chore.id)}
            />
          </div>
          <div className="field">
            <span>Who's doing it?</span>
            <AssigneePicker members={members} value={assigneeIds} onChange={setAssigneeIds} />
          </div>
          <button className="btn primary" disabled={busy || assigneeIds.length === 0} onClick={save}>
            {everyWeek ? (existingRule ? "Save" : "Add chore") : "Add for that week"}
          </button>
        </div>
      )}
    </Sheet>
  );
}

function ItemSheet({
  item,
  completions,
  onUndo,
  chores,
  members,
  onClose,
  onChanged,
}: {
  item: BoardItem | undefined;
  completions: Completion[];
  /** Sets a done go back to not done. */
  onUndo: (item: BoardItem, completion: Completion) => void;
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
          <BackButton onClick={() => setEditingChore(false)} />
          <p className="muted">Changes apply everywhere this chore appears.</p>
          <ChoreForm initial={chore} submitLabel="Save chore" onSubmit={(c) => run(() => api("PATCH", `/api/chores/${chore.id}`, c))} />
        </>
      ) : (
        <div className="stack">
          {completions.length > 0 && (
            <DoneSoFar item={item} completions={completions} members={members} onUndo={(c) => onUndo(item, c)} />
          )}
          <p className="muted small">
            Changes here are for this week only. Editing this chore in the template in use will update it here again.
          </p>
          <div className="field">
            <span>Who's doing it this week?</span>
            <AssigneePicker
              members={members}
              value={item.assigneeIds}
              onChange={(ids) =>
                ids.length
                  ? run(() => api("PATCH", `/api/items/${item.id}`, { assigneeIds: ids }), false)
                  : toast("Every chore needs someone — pick another person first")
              }
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

/** The goes of a chore done this week, each of which can be set back to not done. */
function DoneSoFar({
  item,
  completions,
  members,
  onUndo,
}: {
  item: BoardItem;
  completions: Completion[];
  members: Member[];
  onUndo: (c: Completion) => void;
}) {
  const sorted = [...completions].sort((a, b) => a.doneAt - b.doneAt);
  const allDone = completions.length >= goesPerWeek(item);
  const latest = sorted[sorted.length - 1];
  const dayName = (day: string | null) =>
    day ? new Date(day + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" }) : "";
  return (
    <div className="field done-so-far">
      <span>{allDone ? "✅ Completed" : "Done so far"}</span>
      {allDone && (
        <button className="btn" onClick={() => onUndo(latest)}>
          ↩️ Mark as not done
        </button>
      )}
      <ul className="done-list">
        {sorted.map((c) => {
          const who = members.find((m) => m.id === c.memberId);
          return (
            <li key={c.id}>
              <span>
                ✓ {item.kind === "days" ? dayName(c.day) : dayName(c.day) || "One go"} · done by{" "}
                {who ? (
                  <>
                    <BuddySprite buddy={who.buddy} size={18} className="inline-sprite" /> {who.name}
                  </>
                ) : (
                  "someone"
                )}
              </span>
              <button className="link" onClick={() => onUndo(c)}>
                Undo
              </button>
            </li>
          );
        })}
      </ul>
    </div>
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

function StarterChores({
  templateId,
  week,
  me,
  onAdded,
}: {
  templateId: string;
  week: string;
  me: Member;
  onAdded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="card starter">
      <h3>🌱 An empty board!</h3>
      <p>
        Add chores with the “+ Add a chore” buttons, or start with a handful of common ones. They'll all be yours to begin
        with — drag them onto other people to share them out. They go into the template in use, so every week starts the
        same way.
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
              // Adding the rule puts it on this week's board too (the board follows the template in use).
              await api("POST", `/api/templates/${templateId}/rules`, { choreId: chore.id, assigneeIds: [me.id], anchorWeek: week, ...schedule });
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

