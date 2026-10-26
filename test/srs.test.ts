import { describe, expect, it } from "vitest";
import { computeSrs as compute } from "../src/srs";

const computeSrs = (attempts: Parameters<typeof compute>[0]) => compute(attempts, "UTC");

const day = (n: number, hour = 12) => `2026-10-${String(n).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const ok = (ts: string) => ({ ts, correct: true });
const bad = (ts: string) => ({ ts, correct: false });

describe("computeSrs", () => {
  it("no attempts -> new", () => {
    expect(computeSrs([])).toMatchObject({ status: "new", due_at: null, streak: 0 });
  });

  it("walks the ladder 1 -> 3 -> 7 -> 14 -> 30 on different days", () => {
    const intervals = [1, 2, 3, 4, 5, 6].map((d) => computeSrs(Array.from({ length: d }, (_, i) => ok(day(i + 1)))).interval_days);
    expect(intervals).toEqual([1, 3, 7, 14, 30, 30]);
  });

  it("due_at = ts + interval days", () => {
    const s = computeSrs([ok(day(1)), ok(day(2))]);
    expect(s.due_at).toBe("2026-10-05T12:00:00.000Z");
  });

  it("a wrong answer resets streak, interval=1, due = ts + 1 day", () => {
    const s = computeSrs([ok(day(1)), ok(day(2)), bad(day(3))]);
    expect(s).toMatchObject({ streak: 0, streak_days: 0, interval_days: 1, status: "learning", due_at: day(4) });
  });

  it("a second correct on the same day raises the streak but not the interval", () => {
    const s = computeSrs([ok(day(1, 9)), ok(day(1, 15))]);
    expect(s).toMatchObject({ streak: 2, streak_days: 1, interval_days: 1 });
  });

  it("known needs 3 correct on 3 different days", () => {
    expect(computeSrs([ok(day(1)), ok(day(1, 14)), ok(day(1, 18))]).status).toBe("learning");
    expect(computeSrs([ok(day(1)), ok(day(2)), ok(day(3))]).status).toBe("known");
  });

  it("an error drops a known item back to learning", () => {
    const s = computeSrs([ok(day(1)), ok(day(2)), ok(day(3)), bad(day(4))]);
    expect(s.status).toBe("learning");
  });

  it("a retry after an error on the same day does not grow the interval", () => {
    const s = computeSrs([bad(day(1, 9)), ok(day(1, 10))]);
    expect(s).toMatchObject({ streak: 1, streak_days: 1, interval_days: 1 });
  });

  it("\"same day\" follows the configured time zone", () => {
    // 14:30Z and 15:30Z on 2026-10-14: the same day in UTC, but 23:30 and 00:30 (next day) in Tokyo.
    const attempts = [ok("2026-10-14T14:30:00.000Z"), ok("2026-10-14T15:30:00.000Z")];
    expect(compute(attempts, "UTC")).toMatchObject({ streak_days: 1, interval_days: 1 });
    expect(compute(attempts, "Asia/Tokyo")).toMatchObject({ streak_days: 2, interval_days: 3 });
  });
});
