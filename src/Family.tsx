import { useEffect, useState } from "react";
import type { HomeData, Member } from "../shared/core";
import { api, session } from "./api";
import { type PushState, disablePush, enablePush, isStandalone, pushState, relinkPush } from "./push";
import { AVATARS, Avatar, ColorChoices, EmojiChoices, Sheet, attempt, toast } from "./ui";

interface Props {
  home: HomeData;
  me: Member | null;
  setMe: (id: string) => void;
  reloadHome: () => void;
  signOut: () => void;
  installPrompt: (() => void) | null;
}

export function Family({ home, me, setMe, reloadHome, signOut, installPrompt }: Props) {
  const [editing, setEditing] = useState<Member | "new" | null>(null);
  const [push, setPush] = useState<PushState | null>(null);
  const [houseName, setHouseName] = useState(home.household.name);

  useEffect(() => {
    pushState().then(setPush).catch(() => setPush("unsupported"));
  }, []);

  const togglePush = async () => {
    if (!me) return toast("Pick who you are first 🙂");
    if (!home.vapidPublicKey) return toast("Notifications aren't set up on the server yet");
    await attempt(async () => {
      if (push === "on") await disablePush();
      else {
        await enablePush(home.vapidPublicKey!, me.id);
        toast("Notifications on 🔔");
      }
    });
    setPush(await pushState());
  };

  return (
    <section className="page">
      <header className="page-head">
        <h1>🏡 {home.household.name}</h1>
      </header>

      <div className="card">
        <h2>Who's using this device?</h2>
        <div className="who-grid">
          {home.members.map((m) => (
            <button
              key={m.id}
              className={`who ${me?.id === m.id ? "on" : ""}`}
              onClick={() => {
                setMe(m.id);
                relinkPush(m.id).catch(() => {});
              }}
              aria-pressed={me?.id === m.id}
            >
              <Avatar member={m} size={52} />
              <span>{m.name}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>🔔 Notifications</h2>
        {push === "needs-install" && (
          <p>
            On iPhone and iPad, notifications only work once Cosy Chores is on your Home Screen: tap <b>Share</b> then{" "}
            <b>Add to Home Screen</b>, and open it from there.
          </p>
        )}
        {push === "unsupported" && <p className="muted">This browser can't do notifications, sadly.</p>}
        {push === "denied" && (
          <p className="muted">Notifications are blocked for this app. You can allow them in your browser or phone settings.</p>
        )}
        {(push === "on" || push === "off") && (
          <div className="stack">
            <p className="muted">
              {push === "on"
                ? `This device gets reminders and new notes for ${me?.name ?? "you"}.`
                : "Get a nudge for reminders and when someone pins a note."}
            </p>
            <div className="row">
              <button className={`btn ${push === "on" ? "" : "primary"}`} onClick={togglePush}>
                {push === "on" ? "Turn off" : "Turn on notifications"}
              </button>
              {push === "on" && (
                <button className="btn" onClick={() => attempt(() => api("POST", "/api/push/test", { memberId: me?.id }))}>
                  Send a test
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {!isStandalone() && (
        <div className="card">
          <h2>📲 Put it on your Home Screen</h2>
          {installPrompt ? (
            <button className="btn primary" onClick={installPrompt}>
              Install Cosy Chores
            </button>
          ) : (
            <p className="muted">
              iPhone/iPad: Safari → Share → <b>Add to Home Screen</b>. Android: browser menu → <b>Install app</b>.
            </p>
          )}
        </div>
      )}

      <div className="card">
        <h2>👨‍👩‍👧 The family</h2>
        <ul className="member-list">
          {home.members.map((m) => (
            <li key={m.id}>
              <Avatar member={m} />
              <span>{m.name}</span>
              <button className="link" onClick={() => setEditing(m)}>
                Edit
              </button>
            </li>
          ))}
        </ul>
        <button className="btn" onClick={() => setEditing("new")}>
          + Add someone
        </button>
      </div>

      <div className="card">
        <h2>🔑 Invite code</h2>
        <p className="muted">Family members open the app, choose “Join with an invite code” and type:</p>
        <button
          className="invite-code"
          onClick={() => navigator.clipboard?.writeText(home.household.joinCode).then(() => toast("Copied 📋"))}
          title="Copy"
        >
          {home.household.joinCode}
        </button>
        <p className="muted small">Anyone with this code can see and edit your household, so only share it with family.</p>
      </div>

      <div className="card">
        <h2>⚙️ Household</h2>
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await attempt(() => api("PATCH", "/api/household", { name: houseName }))) {
              toast("Saved");
              reloadHome();
            }
          }}
        >
          <label className="field">
            <span>Name</span>
            <input value={houseName} onChange={(e) => setHouseName(e.target.value)} maxLength={60} />
          </label>
          <p className="muted small">
            Time zone: {home.household.timezone}
            {home.household.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone && (
              <>
                {" "}
                ·{" "}
                <button
                  type="button"
                  className="link"
                  onClick={async () => {
                    await attempt(() =>
                      api("PATCH", "/api/household", { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
                    );
                    reloadHome();
                  }}
                >
                  use this device's ({Intl.DateTimeFormat().resolvedOptions().timeZone})
                </button>
              </>
            )}
          </p>
          <button className="btn" disabled={!houseName.trim() || houseName === home.household.name}>
            Save name
          </button>
        </form>
        <button
          className="btn ghost"
          onClick={() => {
            if (confirm("Sign this device out? You can rejoin with the invite code.")) signOut();
          }}
        >
          Sign out of this device
        </button>
      </div>

      {editing && (
        <MemberSheet
          member={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={reloadHome}
          isMe={editing !== "new" && editing.id === me?.id}
        />
      )}
    </section>
  );
}

function MemberSheet({
  member,
  onClose,
  onSaved,
  isMe,
}: {
  member: Member | null;
  onClose: () => void;
  onSaved: () => void;
  isMe: boolean;
}) {
  const [name, setName] = useState(member?.name ?? "");
  const [emoji, setEmoji] = useState(member?.emoji ?? "🐰");
  const [color, setColor] = useState(member?.color ?? "mint");
  const save = async () => {
    const ok = await attempt(() =>
      member ? api("PATCH", `/api/members/${member.id}`, { name, emoji, color }) : api("POST", "/api/members", { name, emoji, color }),
    );
    if (ok) {
      onSaved();
      onClose();
    }
  };
  return (
    <Sheet title={member ? `Edit ${member.name}` : "Add someone"} onClose={onClose}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), save())}>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus />
        </label>
        <div className="field">
          <span>Buddy</span>
          <EmojiChoices options={AVATARS} value={emoji} onChange={setEmoji} label="Avatar" />
        </div>
        <div className="field">
          <span>Colour</span>
          <ColorChoices value={color} onChange={setColor} />
        </div>
        <button className="btn primary" disabled={!name.trim()}>
          Save
        </button>
        {member && !isMe && (
          <button
            type="button"
            className="btn danger"
            onClick={async () => {
              if (!confirm(`Remove ${member.name}? Their chores move to “Up for grabs”.`)) return;
              if (await attempt(() => api("DELETE", `/api/members/${member.id}`))) {
                onSaved();
                onClose();
              }
            }}
          >
            Remove {member.name}
          </button>
        )}
      </form>
    </Sheet>
  );
}

export function signOutDevice() {
  disablePush().catch(() => {});
  session.setToken(null);
  session.setMe(null);
}
