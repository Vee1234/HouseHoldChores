import { useEffect, useRef, useState } from "react";
import { type Board, type HomeData, type Member, goesPerWeek } from "../shared/core";
import { api } from "./api";
import { BuddySprite, attempt, memberColor, toast, usePolled } from "./ui";

/** Fired by the chore board whenever this week's board changes, so the track keeps up instantly. */
export const BOARD_EVENT = "cosy:board";

export function announceBoard(board: Board) {
  window.dispatchEvent(new CustomEvent<Board>(BOARD_EVENT, { detail: board }));
}

/** Your buddy walks along a track towards home as you tick off this week's chores. */
export function BuddyTrack({ home, me }: { home: HomeData; me: Member }) {
  const { data, setData } = usePolled<Board>(() => api("GET", `/api/board/${home.currentWeek}`), [home.currentWeek]);

  const buddy = usePolled<{ treats: number }>(() => api("GET", `/api/members/${me.id}/buddy`), [me.id], 30000);
  const [mood, setMood] = useState<"idle" | "eating" | "dancing">("idle");

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onBoard = (e: Event) => {
      const board = (e as CustomEvent<Board>).detail;
      if (board.week === home.currentWeek) setData(board);
      // Ticks earn treats; recount once the save has had a moment to land.
      clearTimeout(timer);
      timer = setTimeout(buddy.refresh, 700);
    };
    window.addEventListener(BOARD_EVENT, onBoard);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(BOARD_EVENT, onBoard);
    };
  }, [home.currentWeek, setData, buddy.refresh]);

  const treats = buddy.data?.treats ?? 0;
  const feed = async () => {
    if (mood !== "idle") return;
    if (treats < 1) return toast("Tick off a chore to earn a treat 🍪");
    buddy.setData({ treats: treats - 1 });
    setMood("eating");
    const fed = await attempt(() => api<{ treats: number }>("POST", `/api/members/${me.id}/feed`));
    if (!fed) {
      setMood("idle");
      buddy.refresh();
      return;
    }
    buddy.setData(fed);
    setTimeout(() => setMood("dancing"), 900);
    setTimeout(() => setMood("idle"), 900 + 1700);
  };

  const mine = (data?.items ?? []).filter((i) => i.assigneeIds.includes(me.id));
  const total = mine.reduce((sum, i) => sum + goesPerWeek(i), 0);
  const done = mine.reduce(
    (sum, i) => sum + Math.min(goesPerWeek(i), data!.completions.filter((c) => c.itemId === i.id).length),
    0,
  );
  const pct = total ? (done / total) * 100 : 0;
  const finished = total > 0 && done === total;

  // Hop whenever the buddy moves forward.
  const [hopping, setHopping] = useState(false);
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (last.current !== null && done > last.current) setHopping(true);
    last.current = data ? done : null;
  }, [done, data]);

  if (!data) return <div className="buddy-track placeholder" />;

  return (
    <div
      className={`buddy-track ${finished ? "home" : ""}`}
      role="progressbar"
      aria-label="Your chores this week"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-valuetext={total ? `${done} of ${total} done` : "No chores this week"}
      style={{ "--buddy": memberColor(me.color) } as React.CSSProperties}
    >
      <div className="track">
        <div className="track-inner">
          <div className="track-line" />
          <div className="track-fill" style={{ width: `${pct}%` }} />
          <button
            className={`buddy ${hopping ? "hop" : ""} ${mood}`}
            style={{ left: `${pct}%` }}
            onAnimationEnd={(e) => e.animationName === "hop" && setHopping(false)}
            onClick={feed}
            aria-label={treats ? `Feed your buddy (${treats} treats)` : "Your buddy"}
          >
            <span className="buddy-body">
              <BuddySprite buddy={me.buddy} size={34} dancing={mood === "dancing"} />
            </span>
            {mood === "eating" && <span className="treat-bite" aria-hidden>🍪</span>}
            {mood === "dancing" && (
              <span className="hearts" aria-hidden>
                <span>💖</span>
                <span>💛</span>
                <span>💖</span>
              </span>
            )}
          </button>
        </div>
        <span className="track-home" aria-hidden>
          🏡
        </span>
      </div>
      <div className="track-meta">
        <p className="track-label">
          {mood === "eating"
            ? "Nom nom nom…"
            : mood === "dancing"
              ? "Yum! Happy dance! 💃"
              : !total
                ? "No chores for you this week 🌼"
                : finished
                  ? "Home sweet home — all done! 🎉"
                  : `${done} of ${total} done this week`}
        </p>
        <button className="feed-btn" onClick={feed} disabled={treats < 1 || mood !== "idle"}>
          🍪 {treats} · Feed
        </button>
      </div>
    </div>
  );
}
