import { addDays, daysBetween, localDay } from "./time";

export const INTERVAL_LADDER = [1, 3, 7, 14, 30, 60, 120];
export const KNOWN_STREAK_DAYS = 3;
export const KNOWN_INTERVAL_DAYS = 14;
const MAX_ELAPSED_DAYS = 60; // longer gaps count as 60
const MAX_RUNGS_PER_ANSWER = 2;

export type SrsStatus = "new" | "learning" | "known";

export interface SrsAttempt {
  ts: string; // canonical ISO UTC
  correct: boolean;
  credit?: number | null; // 0..1; missing (legacy rows) = correct ? 1 : 0
}

export interface SrsState {
  status: SrsStatus;
  interval_days: number;
  due_at: string | null;
  streak: number; // answers with full credit in a row
  streak_days: number; // distinct days within the current streak
}

export const EMPTY_SRS: SrsState = { status: "new", interval_days: 0, due_at: null, streak: 0, streak_days: 0 };

function nextInterval(current: number): number {
  return INTERVAL_LADDER.find((x) => x > current) ?? INTERVAL_LADDER[INTERVAL_LADDER.length - 1];
}

// Replays the whole history in chronological order. Callers pass attempts already sorted by (ts, id).
// Replaying (instead of updating incrementally) keeps imports with past dates correct.
//
// credit 1: full answer. credit 0: wrong, back to day one. 0 < credit < 1: partial, the interval stays.
export function computeSrs(attempts: SrsAttempt[], timeZone: string): SrsState {
  if (attempts.length === 0) return { ...EMPTY_SRS };

  let interval = 0;
  let streak = 0;
  let streakDays = 0;
  let due: string | null = null;
  let prevDay: string | null = null; // day of the previous attempt, whatever its credit
  let lastCorrectDay: string | null = null;

  for (const a of attempts) {
    const day = localDay(a.ts, timeZone);
    const credit = a.credit ?? (a.correct ? 1 : 0);
    if (credit >= 1) {
      streak += 1;
      if (lastCorrectDay !== day) streakDays += 1;
      if (prevDay !== null && prevDay !== day) {
        // A late correct answer is stronger evidence than an on-time one: let the real gap count, within limits.
        const elapsed = Math.min(daysBetween(prevDay, day), MAX_ELAPSED_DAYS);
        let capped = interval;
        for (let i = 0; i < MAX_RUNGS_PER_ANSWER; i++) capped = nextInterval(capped);
        interval = Math.min(nextInterval(Math.max(interval, elapsed)), capped);
      } else if (prevDay === null) {
        interval = nextInterval(interval);
      } else if (interval === 0) {
        interval = 1;
      }
      lastCorrectDay = day;
    } else if (credit > 0) {
      // Partial: a slip does not throw the item back to day one, but the streak is broken.
      streak = 0;
      interval = Math.max(interval, 1);
    } else {
      streak = 0;
      streakDays = 0;
      interval = 1;
      lastCorrectDay = null;
    }
    due = addDays(a.ts, interval);
    prevDay = day;
  }

  return {
    status: streakDays >= KNOWN_STREAK_DAYS || interval >= KNOWN_INTERVAL_DAYS ? "known" : "learning",
    interval_days: interval,
    due_at: due,
    streak,
    streak_days: streakDays,
  };
}
