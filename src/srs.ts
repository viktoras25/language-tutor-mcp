import { addDays, localDay } from "./time";

export const INTERVAL_LADDER = [1, 3, 7, 14, 30];
export const KNOWN_STREAK_DAYS = 3;

export type SrsStatus = "new" | "learning" | "known";

export interface SrsAttempt {
  ts: string; // canonical ISO UTC
  correct: boolean;
}

export interface SrsState {
  status: SrsStatus;
  interval_days: number;
  due_at: string | null;
  streak: number; // correct answers in a row
  streak_days: number; // distinct days within the current streak
}

export const EMPTY_SRS: SrsState = { status: "new", interval_days: 0, due_at: null, streak: 0, streak_days: 0 };

function nextInterval(current: number): number {
  return INTERVAL_LADDER.find((x) => x > current) ?? INTERVAL_LADDER[INTERVAL_LADDER.length - 1];
}

// Replays the whole history in chronological order. Callers pass attempts already sorted by (ts, id).
// Replaying (instead of updating incrementally) keeps imports with past dates correct.
export function computeSrs(attempts: SrsAttempt[], timeZone: string): SrsState {
  if (attempts.length === 0) return { ...EMPTY_SRS };

  let interval = 0;
  let streak = 0;
  let streakDays = 0;
  let due: string | null = null;
  let prevDay: string | null = null; // day of the previous attempt, right or wrong
  let lastCorrectDay: string | null = null;

  for (const a of attempts) {
    const day = localDay(a.ts, timeZone);
    if (a.correct) {
      streak += 1;
      if (lastCorrectDay !== day) streakDays += 1;
      // Interval grows only if the previous attempt was on an earlier day.
      if (prevDay !== day) interval = nextInterval(interval);
      else if (interval === 0) interval = 1;
      lastCorrectDay = day;
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
    status: streakDays >= KNOWN_STREAK_DAYS ? "known" : "learning",
    interval_days: interval,
    due_at: due,
    streak,
    streak_days: streakDays,
  };
}
