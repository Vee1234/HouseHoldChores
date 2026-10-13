import { describe, expect, it } from "vitest";
import {
  type BoardItem,
  type Completion,
  appliesToWeek,
  blockingChore,
  creditedMembers,
  describeSchedule,
  formatTime,
  goesPerWeek,
  scheduledDays,
} from "../shared/core";

const SAT = 32, SUN = 64, THU = 8;
const base = { kind: "days" as const, timesPerWeek: 0, days: 0, everyWeeks: 1, time: null, afterChoreId: null };
const item = (id: string, choreId: string, patch: Partial<BoardItem> = {}): BoardItem => ({
  ...base, id, choreId, assigneeIds: [], position: 0, ...patch,
});
const done = (itemId: string, day: string | null): Completion => ({ id: `${itemId}-${day}`, itemId, memberId: "m", doneAt: 0, day });

describe("schedules", () => {
  it("counts goes and lists the days", () => {
    expect(goesPerWeek({ kind: "days", days: SAT | SUN, timesPerWeek: 0 })).toBe(2);
    expect(scheduledDays(SAT | SUN, "2026-10-12")).toEqual(["2026-10-17", "2026-10-18"]);
  });

  it("repeats every N weeks from the anchor, both ways", () => {
    expect(appliesToWeek(2, "2026-10-12", "2026-10-12")).toBe(true);
    expect(appliesToWeek(2, "2026-10-12", "2026-10-19")).toBe(false);
    expect(appliesToWeek(2, "2026-10-12", "2026-10-26")).toBe(true);
    expect(appliesToWeek(3, "2026-10-12", "2026-09-21")).toBe(true);
  });

  it("describes schedules in plain words", () => {
    expect(describeSchedule({ ...base, days: THU, time: "19:00" })).toBe("every Thu at 7pm");
    expect(describeSchedule({ ...base, days: SAT | SUN, everyWeeks: 2 })).toBe("every 2 weeks on weekends");
    expect(describeSchedule({ ...base, kind: "anytime", timesPerWeek: 3 })).toBe("3× a week");
    expect(formatTime("07:30")).toBe("7:30am");
    expect(formatTime("00:00")).toBe("12am");
  });
});

describe("only-after constraints", () => {
  const cook = item("cook", "c-cook", { days: SAT | SUN });
  const wash = item("wash", "c-wash", { days: SAT | SUN, afterChoreId: "c-cook" });

  it("waits for the other chore's go on the same day", () => {
    expect(blockingChore(wash, "2026-10-17", [cook, wash], [])).toBe("c-cook");
    expect(blockingChore(wash, "2026-10-17", [cook, wash], [done("cook", "2026-10-17")])).toBeNull();
    // Saturday's cooking doesn't unlock Sunday's washing up.
    expect(blockingChore(wash, "2026-10-18", [cook, wash], [done("cook", "2026-10-17")])).toBe("c-cook");
  });

  it("for any-day chores, each go needs one more go of the other", () => {
    const shop = item("shop", "c-shop", { kind: "anytime", timesPerWeek: 2, days: 0 });
    const cookAny = item("cookAny", "c-cookany", { kind: "anytime", timesPerWeek: 2, days: 0, afterChoreId: "c-shop" });
    expect(blockingChore(cookAny, null, [shop, cookAny], [done("shop", null)])).toBeNull();
    expect(blockingChore(cookAny, null, [shop, cookAny], [done("shop", null), done("cookAny", null)])).toBe("c-shop");
  });

  it("doesn't block when the other chore isn't on this week", () => {
    expect(blockingChore(wash, "2026-10-17", [wash], [])).toBeNull();
  });
});

describe("credit", () => {
  it("a tick on a shared chore credits everyone on it; a helper credits only themselves", () => {
    expect(creditedMembers("a", ["a", "b"])).toEqual(["a", "b"]);
    expect(creditedMembers("c", ["a", "b"])).toEqual(["c"]);
    expect(creditedMembers(null, ["a"])).toEqual([]);
  });
});
