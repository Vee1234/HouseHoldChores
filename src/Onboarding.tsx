import { useEffect, useState } from "react";
import type { Member } from "../shared/core";
import { api, session } from "./api";
import { Avatar, BuddyChoices, ColorChoices, attempt } from "./ui";

type Step = "welcome" | "create" | "join" | "pick";

/** First run: start a household or join one, then pick who you are. */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>(session.token() ? "pick" : "welcome");
  const [busy, setBusy] = useState(false);

  const [houseName, setHouseName] = useState("");
  const [name, setName] = useState("");
  const [buddy, setBuddy] = useState("bear");
  const [color, setColor] = useState("pumpkin");
  const [code, setCode] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [addingSelf, setAddingSelf] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    await attempt(fn);
    setBusy(false);
  };

  const create = () =>
    run(async () => {
      const res = await api("POST", "/api/households", {
        name: houseName,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        member: { name, buddy, color },
      });
      session.setToken(res.token);
      session.setMe(res.memberId);
      onDone();
    });

  const loadMembers = async () => {
    const home = await api("GET", "/api/home");
    setMembers(home.members);
    setAddingSelf(home.members.length === 0);
  };

  const join = () =>
    run(async () => {
      const res = await api("POST", "/api/join", { code });
      session.setToken(res.token);
      await loadMembers();
      setStep("pick");
    });

  const addSelf = () =>
    run(async () => {
      const m = await api("POST", "/api/members", { name, buddy, color });
      session.setMe(m.id);
      onDone();
    });

  // Signed in on this device already, but nobody picked yet.
  useEffect(() => {
    if (step === "pick") run(loadMembers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const profileFields = (
    <>
      <label className="field">
        <span>Your name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mum, Sam, Grandpa Joe" maxLength={40} />
      </label>
      <div className="field">
        <span>Pick a buddy</span>
        <BuddyChoices value={buddy} onChange={setBuddy} />
      </div>
      <div className="field">
        <span>Your colour</span>
        <ColorChoices value={color} onChange={setColor} />
      </div>
    </>
  );

  return (
    <main className="onboarding">
      <div className="hero">
        <img src="/icons/icon.svg" alt="" width={96} height={96} />
        <h1>Cosy Chores</h1>
        <p>Share the housework, tick things off, and keep the whole household in the loop. 🫖</p>
      </div>

      {step === "welcome" && (
        <div className="card stack">
          <button className="btn primary big" onClick={() => setStep("create")}>
            🏡 Start our household
          </button>
          <button className="btn big" onClick={() => setStep("join")}>
            🔑 Join with an invite code
          </button>
        </div>
      )}

      {step === "create" && (
        <form className="card stack" onSubmit={(e) => (e.preventDefault(), create())}>
          <label className="field">
            <span>Household name</span>
            <input value={houseName} onChange={(e) => setHouseName(e.target.value)} placeholder="The Burrow" maxLength={60} />
          </label>
          {profileFields}
          <button className="btn primary big" disabled={busy || !houseName.trim() || !name.trim()}>
            Let's get cosy ✨
          </button>
          <button type="button" className="btn ghost" onClick={() => setStep("welcome")}>
            ← Back
          </button>
        </form>
      )}

      {step === "join" && (
        <form className="card stack" onSubmit={(e) => (e.preventDefault(), join())}>
          <label className="field">
            <span>Invite code</span>
            <input
              className="code-input"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABCD2345"
              autoCapitalize="characters"
              autoComplete="off"
              maxLength={12}
            />
            <small>Whoever set things up can find it under Family.</small>
          </label>
          <button className="btn primary big" disabled={busy || code.trim().length < 4}>
            Join 🔑
          </button>
          <button type="button" className="btn ghost" onClick={() => setStep("welcome")}>
            ← Back
          </button>
        </form>
      )}

      {step === "pick" && !addingSelf && (
        <div className="card stack">
          <h2>Who are you?</h2>
          <div className="who-grid">
            {members.map((m) => (
              <button
                key={m.id}
                className="who"
                onClick={() => {
                  session.setMe(m.id);
                  onDone();
                }}
              >
                <Avatar member={m} size={56} />
                <span>{m.name}</span>
              </button>
            ))}
          </div>
          <button className="btn" onClick={() => setAddingSelf(true)}>
            ➕ I'm not on the list yet
          </button>
        </div>
      )}

      {step === "pick" && addingSelf && (
        <form className="card stack" onSubmit={(e) => (e.preventDefault(), addSelf())}>
          <h2>Say hello 👋</h2>
          {profileFields}
          <button className="btn primary big" disabled={busy || !name.trim()}>
            That's me!
          </button>
          {members.length > 0 && (
            <button type="button" className="btn ghost" onClick={() => setAddingSelf(false)}>
              ← Back to the list
            </button>
          )}
        </form>
      )}
    </main>
  );
}
