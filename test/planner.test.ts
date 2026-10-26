import { describe, expect, it } from "vitest";
import {
  computeProgress,
  currentLevel,
  isMastered,
  nextTopics,
  statusRank,
  type PlanModule,
  type PlanTopic,
  type StatusMap,
  type TopicProgressInput,
  type TopicStatus,
} from "../src/planner";

const modules: PlanModule[] = [
  { id: "A1.01", level: "A1", ord: 1 },
  { id: "A1.02", level: "A1", ord: 2 },
  { id: "A2.01", level: "A2", ord: 3 },
];

const topics: PlanTopic[] = [
  { id: "a", moduleId: "A1.01", ord: 0, requires: [] },
  { id: "b", moduleId: "A1.01", ord: 1, requires: ["a"] },
  { id: "c", moduleId: "A1.02", ord: 2, requires: [] },
  { id: "d", moduleId: "A1.02", ord: 3, requires: ["b", "c"] },
  { id: "e", moduleId: "A2.01", ord: 4, requires: ["c"] },
];

function statuses(entries: [string, TopicStatus][]): StatusMap {
  return new Map(entries);
}

describe("nextTopics", () => {
  it("proposes only topics whose prerequisites are covered, in plan order", () => {
    const r = nextTopics(modules, topics, statuses([]));
    expect(r.fill.map((c) => c.id)).toEqual(["a", "c"]);
    expect(r.continue).toEqual([]);
    expect(r.blocked).toBe(3); // b, d, e wait for something
  });

  it("puts topics that follow the current one into continue, the rest into fill", () => {
    const r = nextTopics(modules, topics, statuses([["a", "current"]]));
    expect(r.current).toEqual(["a"]);
    expect(r.continue).toEqual([{ id: "b", module_id: "A1.01", reason: "continue" }]);
    expect(r.fill.map((c) => c.id)).toEqual(["c"]);
  });

  it("treats assumed and introduced as covered, seen_via_error as still open, and skips covered topics", () => {
    const r = nextTopics(modules, topics, statuses([["a", "assumed"], ["b", "introduced"], ["c", "seen_via_error"]]));
    expect(r.fill.map((c) => c.id)).toEqual(["c"]);
    expect(r.blocked).toBe(2); // d needs c, e needs c
  });

  it("limits each group", () => {
    const many: PlanTopic[] = [];
    for (let i = 0; i < 10; i++) many.push({ id: `t${i}`, moduleId: "A1.01", ord: i, requires: [] });
    expect(nextTopics(modules, many, statuses([]), 3).fill.length).toBe(3);
  });
});

describe("isMastered", () => {
  it("needs coverage, at least one item, all items known and no recent mistakes", () => {
    const good = { itemCount: 2, knownCount: 2, recentWrong: 0 };
    expect(isMastered(true, good)).toBe(true);
    expect(isMastered(false, good)).toBe(false);
    expect(isMastered(true, undefined)).toBe(false);
    expect(isMastered(true, { itemCount: 0, knownCount: 0, recentWrong: 0 })).toBe(false);
    expect(isMastered(true, { itemCount: 2, knownCount: 1, recentWrong: 0 })).toBe(false);
    expect(isMastered(true, { ...good, recentWrong: 1 })).toBe(false);
  });
});

function input(id: string, moduleId: string, status: TopicStatus | undefined, known: boolean, changedAt = "2026-10-01"): TopicProgressInput {
  return {
    id,
    moduleId,
    status,
    changedAt: status === undefined ? undefined : changedAt,
    evidence: { itemCount: 1, knownCount: known ? 1 : 0, recentWrong: 0 },
  };
}

describe("computeProgress", () => {
  it("counts coverage and mastery separately and weights levels by topics", () => {
    const p = computeProgress(
      modules,
      [
        input("a", "A1.01", "introduced", true),
        input("b", "A1.01", "assumed", false),
        input("c", "A1.02", undefined, false),
        input("e", "A2.01", "current", false),
      ],
      new Map(),
    );
    expect(p.modules[0]).toMatchObject({ module_id: "A1.01", covered: 2, mastered: 1, total: 2, closed: false });
    expect(p.levels).toEqual([
      { level: "A1", covered: 2, mastered: 1, total: 3 },
      { level: "A2", covered: 1, mastered: 0, total: 1 },
    ]);
    expect(currentLevel(p.levels)?.level).toBe("A1");
  });

  it("closes a module only with full coverage, 80% mastery and a checkpoint passed after the last introduction", () => {
    const five: TopicProgressInput[] = [];
    for (let i = 0; i < 5; i++) five.push(input(`t${i}`, "A1.01", "introduced", i < 4, "2026-10-10T10:00:00.000Z"));
    const only = [modules[0]];
    const passedAfter = new Map([["A1.01", { passed: true, ts: "2026-10-11T10:00:00.000Z" }]]);
    expect(computeProgress(only, five, passedAfter).modules[0].closed).toBe(true); // 4 of 5 = 80%

    const passedBefore = new Map([["A1.01", { passed: true, ts: "2026-10-09T10:00:00.000Z" }]]);
    expect(computeProgress(only, five, passedBefore).modules[0].closed).toBe(false);

    const failed = new Map([["A1.01", { passed: false, ts: "2026-10-11T10:00:00.000Z" }]]);
    expect(computeProgress(only, five, failed).modules[0].closed).toBe(false);

    five[3] = input("t3", "A1.01", "introduced", false, "2026-10-10T10:00:00.000Z"); // 3 of 5 = 60%
    expect(computeProgress(only, five, passedAfter).modules[0].closed).toBe(false);
  });

  it("currentLevel moves on when a level is fully covered", () => {
    expect(currentLevel([{ level: "A1", covered: 3, mastered: 0, total: 3 }, { level: "A2", covered: 0, mastered: 0, total: 4 }])?.level).toBe("A2");
    expect(currentLevel([{ level: "A1", covered: 3, mastered: 0, total: 3 }])?.level).toBe("A1");
    expect(currentLevel([])).toBeNull();
  });
});

describe("helpers", () => {
  it("statusRank orders the steps of a topic", () => {
    expect(statusRank(undefined)).toBe(0);
    expect(statusRank("seen_via_error")).toBe(0);
    expect(statusRank("current")).toBe(1);
    expect(statusRank("introduced")).toBe(2);
    expect(statusRank("assumed")).toBe(2);
  });
});
