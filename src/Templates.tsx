import { useState } from "react";
import { type Chore, type HomeData, type Rule, type Schedule, type Template, type TemplatesData, describeEstimate, describeSchedule } from "../shared/core";
import { api } from "./api";
import { AssigneeAvatars, AssigneePicker, BackButton, ChoreForm, NEW_SCHEDULE, ScheduleEditor } from "./choreParts";
import { Sheet, attempt, toast } from "./ui";

interface Props {
  home: HomeData;
  data: TemplatesData | null;
  refresh: () => void;
  reloadHome: () => void;
}

/** Templates: named sets of rules; the one in use plans every week until you switch. */
export function Templates({ home, data, refresh, reloadHome }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<
    { kind: "new" } | { kind: "rule"; template: Template; rule: Rule | null } | { kind: "rename"; template: Template } | null
  >(null);
  if (!data) return <p className="empty">Fluffing the cushions…</p>;
  const chores = new Map(home.chores.map((c) => [c.id, c]));
  const open = data.templates.find((t) => t.id === (openId ?? data.activeTemplateId)) ?? data.templates[0];

  const run = async (fn: () => Promise<unknown>, message?: string) => {
    const ok = await attempt(fn);
    if (ok !== undefined && message) toast(message);
    refresh();
  };

  return (
    <div className="stack">
      <p className="banner">
        A template is a set of chores, each with how often it happens and who does it. The one in use plans every week until
        you switch — switching midweek applies from today.
      </p>

      <div className="template-tabs" role="tablist" aria-label="Templates">
        {data.templates.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === open?.id} onClick={() => setOpenId(t.id)}>
            {t.name}
            {t.id === data.activeTemplateId && <span className="in-use">in use</span>}
          </button>
        ))}
        <button className="new-template" onClick={() => setSheet({ kind: "new" })}>
          + New
        </button>
      </div>

      {open && (
        <div className="card stack">
          <div className="card-head">
            <h2>{open.name}</h2>
            <button className="link" onClick={() => setSheet({ kind: "rename", template: open })}>
              Rename
            </button>
          </div>
          {open.id === data.activeTemplateId ? (
            <p className="in-use-note">✅ In use — every week is planned from this template.</p>
          ) : (
            <button
              className="btn primary"
              onClick={() =>
                confirm(`Switch to “${open.name}” from today? Chores already ticked this week stay put.`) &&
                run(() => api("POST", `/api/templates/${open.id}/activate`), `Now using “${open.name}” 🌟`)
              }
            >
              Use this template from today
            </button>
          )}

          {open.rules.length === 0 ? (
            <p className="muted">No chores in this template yet.</p>
          ) : (
            <ul className="rule-list">
              {open.rules.map((r) => {
                const chore = chores.get(r.choreId);
                if (!chore) return null;
                return (
                  <li key={r.id}>
                    <button className="rule" onClick={() => setSheet({ kind: "rule", template: open, rule: r })}>
                      <span className="chore-emoji" aria-hidden>
                        {chore.emoji}
                      </span>
                      <span className="chore-text">
                        <strong>{chore.title}</strong>
                        <small>
                          {describeSchedule(r)} · {describeEstimate(chore.minutes, chore.per)}
                        </small>
                      </span>
                      <AssigneeAvatars ids={r.assigneeIds} members={home.members} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <button className="add-card" onClick={() => setSheet({ kind: "rule", template: open, rule: null })}>
            + Add a chore to this template
          </button>
          {open.id !== data.activeTemplateId && (
            <button
              className="btn ghost"
              onClick={() =>
                confirm(`Delete the “${open.name}” template?`) &&
                run(async () => {
                  await api("DELETE", `/api/templates/${open.id}`);
                  setOpenId(null);
                }, "Template deleted")
              }
            >
              Delete this template
            </button>
          )}
        </div>
      )}

      {sheet?.kind === "new" && (
        <NewTemplateSheet
          templates={data.templates}
          onClose={() => setSheet(null)}
          onCreated={(id) => {
            setOpenId(id);
            refresh();
          }}
        />
      )}
      {sheet?.kind === "rename" && (
        <RenameSheet
          template={sheet.template}
          onClose={() => setSheet(null)}
          onSaved={() => {
            setSheet(null);
            refresh();
          }}
        />
      )}
      {sheet?.kind === "rule" && (
        <RuleSheet
          template={sheet.template}
          rule={sheet.rule}
          home={home}
          chores={home.chores}
          onClose={() => setSheet(null)}
          onSaved={() => {
            reloadHome();
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewTemplateSheet({
  templates,
  onClose,
  onCreated,
}: {
  templates: Template[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [copyFromId, setCopyFromId] = useState("");
  return (
    <Sheet title="New template" onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const t = await attempt(() => api<Template>("POST", "/api/templates", { name, copyFromId: copyFromId || undefined }));
          if (t) {
            onCreated(t.id);
            onClose();
          }
        }}
      >
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="School term, Summer holidays…" maxLength={60} autoFocus />
        </label>
        <label className="field">
          <span>Start from</span>
          <select value={copyFromId} onChange={(e) => setCopyFromId(e.target.value)}>
            <option value="">An empty template</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                A copy of “{t.name}”
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary" disabled={!name.trim()}>
          Create
        </button>
      </form>
    </Sheet>
  );
}

function RenameSheet({ template, onClose, onSaved }: { template: Template; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(template.name);
  return (
    <Sheet title="Rename template" onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await attempt(() => api("PATCH", `/api/templates/${template.id}`, { name }))) onSaved();
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
        <button className="btn primary" disabled={!name.trim()}>
          Save
        </button>
      </form>
    </Sheet>
  );
}

/** Add or edit one rule: which chore, how often, and who. */
function RuleSheet({
  template,
  rule,
  home,
  chores,
  onClose,
  onSaved,
}: {
  template: Template;
  rule: Rule | null;
  home: HomeData;
  chores: Chore[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const taken = new Set(template.rules.map((r) => r.choreId));
  const available = chores.filter((c) => !taken.has(c.id) || c.id === rule?.choreId);
  const [step, setStep] = useState<"pick" | "new" | "details">(rule ? "details" : available.length ? "pick" : "new");
  const [chore, setChore] = useState<Chore | null>(rule ? (chores.find((c) => c.id === rule.choreId) ?? null) : null);
  const [schedule, setSchedule] = useState<Schedule>(rule ? { ...rule } : NEW_SCHEDULE);
  const [startNext, setStartNext] = useState(false);
  const [assigneeIds, setAssigneeIds] = useState<string[]>(rule?.assigneeIds ?? []);
  const [editingChore, setEditingChore] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!chore) return;
    setBusy(true);
    const anchorWeek = startNext ? nextWeek(home.currentWeek) : home.currentWeek;
    const body = { ...schedule, assigneeIds, ...(schedule.everyWeeks > 1 && (!rule || rule.everyWeeks !== schedule.everyWeeks) ? { anchorWeek } : {}) };
    const ok = await attempt(() =>
      rule ? api("PATCH", `/api/rules/${rule.id}`, body) : api("POST", `/api/templates/${template.id}/rules`, { choreId: chore.id, anchorWeek, ...body }),
    );
    setBusy(false);
    if (ok) {
      onSaved();
      onClose();
    }
  };

  return (
    <Sheet title={rule ? `${chore?.emoji ?? ""} ${chore?.title ?? "Chore"}` : `Add to “${template.name}”`} onClose={onClose}>
      {step === "new" && (
        <>
          {available.length > 0 && <BackButton onClick={() => setStep("pick")} />}
          <ChoreForm
            submitLabel="Next →"
            onSubmit={async (c) => {
              const created = await api<Chore>("POST", "/api/chores", c);
              // Refresh the chore list so it's there to pick if they step back.
              onSaved();
              setChore(created);
              setStep("details");
            }}
          />
        </>
      )}
      {step === "pick" && (
        <div className="stack">
          <button className="btn primary" onClick={() => setStep("new")}>
            ✨ A brand new chore
          </button>
          {available.length > 0 && <p className="muted">…or one you've used before:</p>}
          <div className="library">
            {available.map((c) => (
              <button
                key={c.id}
                className="library-item"
                onClick={() => {
                  setChore(c);
                  setStep("details");
                }}
              >
                <span aria-hidden>{c.emoji}</span>
                <span>{c.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {step === "details" && chore && editingChore && (
        <>
          <BackButton onClick={() => setEditingChore(false)} />
          <p className="muted">Changes apply everywhere this chore appears.</p>
          <ChoreForm
            initial={chore}
            submitLabel="Save chore"
            onSubmit={async (c) => {
              await api("PATCH", `/api/chores/${chore.id}`, c);
              setChore({ ...chore, ...c });
              setEditingChore(false);
              onSaved();
            }}
          />
        </>
      )}
      {step === "details" && chore && !editingChore && (
        <div className="stack">
          {/* Editing an existing rule has nowhere to go back to. */}
          {!rule && <BackButton onClick={() => setStep("pick")} />}
          <p className="picked">
            {chore.emoji} <strong>{chore.title}</strong> · {describeEstimate(chore.minutes, chore.per)}{" "}
            <button className="link" onClick={() => setEditingChore(true)}>
              Edit
            </button>
          </p>
          <div className="field">
            <span>How often?</span>
            <ScheduleEditor
              value={schedule}
              onChange={setSchedule}
              allowRepeat
              afterOptions={chores.filter((c) => c.id !== chore.id && taken.has(c.id))}
            />
            {schedule.everyWeeks > 1 && (!rule || rule.everyWeeks !== schedule.everyWeeks) && (
              <label className="row">
                <span>Starting</span>
                <select value={startNext ? "next" : "this"} onChange={(e) => setStartNext(e.target.value === "next")}>
                  <option value="this">this week</option>
                  <option value="next">next week</option>
                </select>
              </label>
            )}
          </div>
          <div className="field">
            <span>Who does it?</span>
            <AssigneePicker members={home.members} value={assigneeIds} onChange={setAssigneeIds} />
          </div>
          <button className="btn primary" disabled={busy} onClick={save}>
            {rule ? "Save" : "Add to template"}
          </button>
          {rule && (
            <button
              className="btn ghost"
              onClick={async () => {
                if (await attempt(() => api("DELETE", `/api/rules/${rule.id}`))) {
                  onSaved();
                  onClose();
                }
              }}
            >
              ➖ Take out of this template
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}

function nextWeek(week: string): string {
  const d = new Date(week + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}
