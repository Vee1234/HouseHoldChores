import { useState } from "react";
import { type HomeData, type WeekStats, formatMinutes } from "../shared/core";
import { api } from "./api";
import { Avatar, memberColor, prettyWeek, usePolled } from "./ui";

export function TimeStats({ home }: { home: HomeData }) {
  const { data, error } = usePolled<WeekStats[]>(() => api("GET", "/api/stats?weeks=6"), [], 60000);
  const [hover, setHover] = useState<string | null>(null);

  if (!data) return <section className="page"><p className="empty">{error ? `😿 ${error}` : "Counting minutes…"}</p></section>;

  const thisWeek = data[data.length - 1];
  const rows = home.members.map((m) => ({
    member: m,
    planned: thisWeek.planned[m.id] ?? 0,
    done: thisWeek.done[m.id] ?? 0,
  }));
  const scale = Math.max(1, ...rows.flatMap((r) => [r.planned, r.done]));
  const unassigned = thisWeek.planned[""] ?? 0;
  const totalDone = rows.reduce((s, r) => s + r.done, 0);

  return (
    <section className="page">
      <header className="page-head">
        <h1>⏳ Time on chores</h1>
        <p className="muted">
          This week ({prettyWeek(thisWeek.week)}) · {formatMinutes(totalDone)} done together so far
        </p>
      </header>

      <div className="card">
        <div className="legend" aria-hidden>
          <span><i className="swatch solid" /> Done</span>
          <span><i className="swatch track" /> Planned for them</span>
        </div>
        <ul className="bars">
          {rows.map(({ member, planned, done }) => {
            const pct = planned ? Math.round((done / planned) * 100) : null;
            return (
              <li
                key={member.id}
                className="bar-row"
                tabIndex={0}
                onMouseEnter={() => setHover(member.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(member.id)}
                onBlur={() => setHover(null)}
                onClick={() => setHover(hover === member.id ? null : member.id)}
                style={{ "--bar": memberColor(member.color) } as React.CSSProperties}
                aria-label={`${member.name}: ${formatMinutes(done)} done of ${formatMinutes(planned)} planned`}
              >
                <div className="bar-label">
                  <Avatar member={member} size={28} />
                  <strong>{member.name}</strong>
                  <span className="muted">
                    {formatMinutes(done)}{" "}
                    <span className="of">{planned ? `of ${formatMinutes(planned)}` : "done"}</span>
                  </span>
                </div>
                <div className="bar-track">
                  <div className="bar-planned" style={{ width: `${(planned / scale) * 100}%` }} />
                  <div className="bar-done" style={{ width: `${(done / scale) * 100}%` }} />
                </div>
                {hover === member.id && (
                  <div className="tooltip" role="tooltip">
                    <strong>
                      {member.emoji} {member.name}
                    </strong>
                    <span>Done: {formatMinutes(done)}</span>
                    <span>Planned: {formatMinutes(planned)}</span>
                    {pct !== null && <span>{pct}% of their plan</span>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {unassigned > 0 && (
          <p className="muted small">🎁 {formatMinutes(unassigned)} of chores are still up for grabs.</p>
        )}
        <p className="muted small">
          “Done” counts whoever ticked it off, so helping someone out shows up for you. Times are the rough estimates
          set on each chore.
        </p>
      </div>

      <div className="card">
        <h2>Past weeks — time done</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Week</th>
                {home.members.map((m) => (
                  <th scope="col" key={m.id}>
                    {m.emoji} {m.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((w) => (
                <tr key={w.week}>
                  <th scope="row">{w.week === thisWeek.week ? "This week" : prettyWeek(w.week)}</th>
                  {home.members.map((m) => (
                    <td key={m.id}>{w.done[m.id] ? formatMinutes(w.done[m.id]) : "–"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
