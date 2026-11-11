import { describe, expect, it } from "vitest";
import { computeSrs as compute } from "../src/srs";

const computeSrs = (attempts: Parameters<typeof compute>[0]) => compute(attempts, "UTC");

const day = (n: number, hour = 12) => `2026-10-${String(n).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const ok = (ts: string) => ({ ts, correct: true });
const bad = (ts: string) => ({ ts, correct: false });
const part = (ts: string, credit = 0.5) => ({ ts, correct: false, credit });
const full = (ts: string) => ({ ts, correct: true, credit: 1 });

describe("computeSrs", () => {
  it("no attempts -> new", () => {
    expect(computeSrs([])).toMatchObject({ status: "new", due_at: null, streak: 0 });
  });

  it("walks the ladder 1 -> 3 -> 7 -> 14 -> 30 -> 60 -> 120 on consecutive days", () => {
    const intervals = [1, 2, 3, 4, 5, 6, 7, 8].map((d) => computeSrs(Array.from({ length: d }, (_, i) => ok(day(i + 1)))).interval_days);
    expect(intervals).toEqual([1, 3, 7, 14, 30, 60, 120, 120]);
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

describe("computeSrs with credit", () => {
  it("legacy rows without credit behave as before", () => {
    expect(computeSrs([{ ts: day(1), correct: true, credit: null }, { ts: day(2), correct: false, credit: null }])).toMatchObject({
      streak: 0,
      interval_days: 1,
    });
  });

  it("credit 1 and credit 0 equal correct true / false", () => {
    expect(computeSrs([full(day(1)), full(day(2))])).toEqual(computeSrs([ok(day(1)), ok(day(2))]));
    expect(computeSrs([full(day(1)), part(day(2), 0)])).toEqual(computeSrs([ok(day(1)), bad(day(2))]));
  });

  it("interval 1 answered correctly after 15 days becomes 7 (two rungs, not 30)", () => {
    expect(computeSrs([bad(day(1)), ok(day(16))]).interval_days).toBe(7);
  });

  it("a late answer only jumps as far as the gap justifies", () => {
    // interval 1, gap 2 days: base 2 -> rung 3
    expect(computeSrs([bad(day(1)), ok(day(3))]).interval_days).toBe(3);
    // interval 3, gap 4 days: base 4 -> rung 7
    expect(computeSrs([ok(day(1)), ok(day(2)), ok(day(6))]).interval_days).toBe(7);
  });

  it("gaps longer than 60 days count as 60", () => {
    const s = computeSrs([
      ok("2026-01-01T12:00:00.000Z"),
      ok("2026-01-02T12:00:00.000Z"),
      ok("2026-01-03T12:00:00.000Z"),
      ok("2026-12-01T12:00:00.000Z"),
    ]);
    // interval 7 before the last answer, base 60 -> rung 120, capped: 7 -> 14 -> 30
    expect(s.interval_days).toBe(30);
  });

  it("an on-time correct answer still takes exactly one rung", () => {
    expect(computeSrs([ok(day(1)), ok(day(2)), ok(day(3))]).interval_days).toBe(7);
  });

  it("a partial answer keeps the interval, breaks the streak, keeps streak_days", () => {
    const s = computeSrs([ok(day(1)), ok(day(2)), ok(day(3)), part(day(10))]);
    expect(s).toMatchObject({ interval_days: 7, streak: 0, streak_days: 3, due_at: day(17) });
  });

  it("a partial answer on a new item gives interval 1", () => {
    expect(computeSrs([part(day(1))])).toMatchObject({ interval_days: 1, streak: 0, streak_days: 0, status: "learning" });
  });

  it("0.3 and 0.7 are partial: not wrong, not right", () => {
    for (const c of [0.3, 0.7]) {
      expect(computeSrs([ok(day(1)), ok(day(2)), part(day(3), c)])).toMatchObject({ interval_days: 3, streak: 0, streak_days: 2 });
    }
  });

  it("known also when the interval reaches 14 days", () => {
    const s = computeSrs([ok(day(1)), ok(day(2)), part(day(3)), ok(day(10))]);
    // 1 -> 3, partial keeps 3, correct after 7 days: base 7 -> rung 14 (cap: 3 -> 7 -> 14)
    expect(s).toMatchObject({ interval_days: 14, streak_days: 3, status: "known" });
    const t = computeSrs([bad(day(1)), ok(day(2)), ok(day(5)), ok(day(15))]);
    expect(t.streak_days).toBe(3);
    expect(computeSrs([ok(day(1)), ok(day(2)), part(day(3)), part(day(4))]).status).toBe("learning");
  });

  it("replaying a mixed history is stable", () => {
    const h = [ok(day(1)), part(day(2)), ok(day(5)), bad(day(6)), ok(day(20)), ok(day(21))];
    expect(computeSrs(h)).toEqual(computeSrs([...h]));
    expect(computeSrs(h)).toMatchObject({ streak: 2 });
  });
});
