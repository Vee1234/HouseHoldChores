import { describe, expect, it } from "vitest";
import { localParts, minutesPerCompletion, nextDue, weekOf, weeklyMinutes, zonedToUtc } from "../shared/core";

describe("time estimates", () => {
  it("converts each estimate style to a weekly figure", () => {
    expect(weeklyMinutes(15, "each", 3)).toBe(45);
    expect(weeklyMinutes(20, "day", 7)).toBe(140);
    expect(weeklyMinutes(90, "week", 1)).toBe(90);
    expect(weeklyMinutes(120, "month", 1)).toBeCloseTo(27.69, 1);
  });

  it("credits ticks so a fully done week matches the estimate", () => {
    expect(minutesPerCompletion(15, "each", 3)).toBe(15);
    expect(minutesPerCompletion(20, "day", 7)).toBe(20);
    expect(minutesPerCompletion(90, "week", 2) * 2).toBe(90);
  });
});

describe("calendar", () => {
  it("finds the Monday of a week", () => {
    expect(weekOf("2026-10-13")).toBe("2026-10-12"); // Tuesday
    expect(weekOf("2026-10-12")).toBe("2026-10-12"); // Monday
    expect(weekOf("2026-10-18")).toBe("2026-10-12"); // Sunday
  });

  it("keeps wall-clock time across a DST change", () => {
    const tz = "Europe/London";
    // Sat 24 Oct 2026, 18:00 BST; clocks go back on the 25th.
    const due = zonedToUtc({ year: 2026, month: 10, day: 24, hour: 18, minute: 0 }, tz);
    const next = nextDue(due, "daily", tz)!;
    expect(localParts(next, tz)).toMatchObject({ day: 25, hour: 18, minute: 0 });
    expect(next - due).toBe(25 * 60 * 60 * 1000);
  });

  it("skips weekends for weekday reminders", () => {
    const tz = "America/New_York";
    const friday = zonedToUtc({ year: 2026, month: 10, day: 16, hour: 7, minute: 30 }, tz);
    expect(localParts(nextDue(friday, "weekdays", tz)!, tz)).toMatchObject({ day: 19, hour: 7, minute: 30 });
  });

  it("clamps monthly reminders to the end of short months", () => {
    const tz = "UTC";
    const jan31 = zonedToUtc({ year: 2027, month: 1, day: 31, hour: 9, minute: 0 }, tz);
    expect(localParts(nextDue(jan31, "monthly", tz)!, tz)).toMatchObject({ month: 2, day: 28 });
    const dec15 = zonedToUtc({ year: 2026, month: 12, day: 15, hour: 9, minute: 0 }, tz);
    expect(localParts(nextDue(dec15, "monthly", tz)!, tz)).toMatchObject({ year: 2027, month: 1, day: 15 });
  });
});
