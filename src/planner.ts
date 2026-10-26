// Pure planning logic for the syllabus: what to teach next and how far the learner has got.
// No database access here: the store loads the data and passes it in, so everything is testable on its own.

export type TopicStatus = "planned" | "seen_via_error" | "current" | "introduced" | "assumed";

// Statuses a learner may be put into by hand (set_topic_status). `assumed` is accepted only inside a placement session.
export const SETTABLE_STATUSES = ["current", "introduced", "assumed", "planned"] as const;

export interface PlanModule {
  id: string;
  level: string;
  ord: number;
}

export interface PlanTopic {
  id: string;
  moduleId: string;
  ord: number; // position in the source files
  requires: string[];
}

// A missing status means the topic was never started, the same as "planned".
export type StatusMap = Map<string, TopicStatus>;

// Covered = taught now, taught before, or known before the course. Covered topics satisfy `requires`.
export function isCovered(status: TopicStatus | undefined): boolean {
  return status === "current" || status === "introduced" || status === "assumed";
}

// Open = may be proposed as new material.
export function isOpen(status: TopicStatus | undefined): boolean {
  return status === undefined || status === "planned" || status === "seen_via_error";
}

// How far along a status is. Used to tell a normal step forward from a step back.
export function statusRank(status: TopicStatus | undefined): number {
  if (status === "current") return 1;
  if (status === "introduced" || status === "assumed") return 2;
  return 0;
}

function moduleOrder(modules: PlanModule[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const m of modules) result.set(m.id, m.ord);
  return result;
}

export interface NextCandidate {
  id: string;
  module_id: string;
  reason: "continue" | "fill";
}

export interface NextTopics {
  current: string[];
  continue: NextCandidate[];
  fill: NextCandidate[];
  blocked: number;
}

// 1. Candidates: open topics whose requires are all covered.
// 2. continue: candidates that require a topic being taught right now (keeps a chain going).
// 3. fill: the other candidates, in plan order (module order, then position in the files).
// Returns at most `perGroup` of each, plus how many open topics are still blocked by missing prerequisites.
export function nextTopics(modules: PlanModule[], topics: PlanTopic[], statuses: StatusMap, perGroup = 3): NextTopics {
  const order = moduleOrder(modules);
  const sorted = topics.slice().sort((a, b) => {
    const byModule = (order.get(a.moduleId) ?? 0) - (order.get(b.moduleId) ?? 0);
    if (byModule !== 0) return byModule;
    return a.ord - b.ord;
  });

  const current: string[] = [];
  for (const t of sorted) {
    if (statuses.get(t.id) === "current") current.push(t.id);
  }

  const continueList: NextCandidate[] = [];
  const fillList: NextCandidate[] = [];
  let blocked = 0;
  for (const t of sorted) {
    if (!isOpen(statuses.get(t.id))) continue;
    let unlocked = true;
    let followsCurrent = false;
    for (const r of t.requires) {
      if (!isCovered(statuses.get(r))) unlocked = false;
      if (statuses.get(r) === "current") followsCurrent = true;
    }
    if (!unlocked) {
      blocked += 1;
    } else if (followsCurrent) {
      continueList.push({ id: t.id, module_id: t.moduleId, reason: "continue" });
    } else {
      fillList.push({ id: t.id, module_id: t.moduleId, reason: "fill" });
    }
  }
  return { current, continue: continueList.slice(0, perGroup), fill: fillList.slice(0, perGroup), blocked };
}

// What the server knows about the items of one topic (the topic's own item plus items linked with part_of).
export interface TopicEvidence {
  itemCount: number;
  knownCount: number; // items whose SRS status is "known"
  recentWrong: number; // wrong attempts in the last 14 days over all those items
}

// Mastered = covered, has at least one item, every item is known, and no recent mistakes.
// A topic that is only "assumed" and never practised has no known items, so it is not mastered.
export function isMastered(covered: boolean, evidence: TopicEvidence | undefined): boolean {
  if (!covered || evidence === undefined) return false;
  if (evidence.itemCount === 0) return false;
  return evidence.knownCount === evidence.itemCount && evidence.recentWrong === 0;
}

export interface TopicProgressInput {
  id: string;
  moduleId: string;
  status: TopicStatus | undefined;
  changedAt: string | undefined; // when the status was set
  evidence: TopicEvidence | undefined;
}

export interface Checkpoint {
  passed: boolean;
  ts: string;
}

export interface Tally {
  covered: number;
  mastered: number;
  total: number;
}

export interface ModuleProgress extends Tally {
  module_id: string;
  level: string;
  closed: boolean;
  checkpoint: Checkpoint | null;
}

export interface LevelProgress extends Tally {
  level: string;
}

export interface Progress {
  modules: ModuleProgress[];
  levels: LevelProgress[];
}

export const MODULE_MASTERY_PCT = 80;

// A module is closed when every topic is covered, at least 80% are mastered, and the latest checkpoint
// was passed after the last topic of the module was introduced.
// Levels add up topics (not modules), and coverage and mastery stay separate numbers.
export function computeProgress(
  modules: PlanModule[],
  topics: TopicProgressInput[],
  lastCheckpoints: Map<string, Checkpoint>,
): Progress {
  const sortedModules = modules.slice().sort((a, b) => a.ord - b.ord);
  const moduleResults: ModuleProgress[] = [];
  const levelResults: LevelProgress[] = [];

  for (const m of sortedModules) {
    let covered = 0;
    let mastered = 0;
    let total = 0;
    let lastIntroduced = "";
    for (const t of topics) {
      if (t.moduleId !== m.id) continue;
      total += 1;
      const isCoveredNow = isCovered(t.status);
      if (isCoveredNow) {
        covered += 1;
        if (t.changedAt !== undefined && t.changedAt > lastIntroduced) lastIntroduced = t.changedAt;
      }
      if (isMastered(isCoveredNow, t.evidence)) mastered += 1;
    }

    const checkpoint = lastCheckpoints.get(m.id) ?? null;
    let closed = false;
    if (total > 0 && covered === total && mastered * 100 >= MODULE_MASTERY_PCT * total) {
      if (checkpoint !== null && checkpoint.passed && checkpoint.ts >= lastIntroduced) closed = true;
    }
    moduleResults.push({ module_id: m.id, level: m.level, covered, mastered, total, closed, checkpoint });

    let level: LevelProgress | undefined;
    for (const l of levelResults) {
      if (l.level === m.level) level = l;
    }
    if (level === undefined) {
      level = { level: m.level, covered: 0, mastered: 0, total: 0 };
      levelResults.push(level);
    }
    level.covered += covered;
    level.mastered += mastered;
    level.total += total;
  }
  return { modules: moduleResults, levels: levelResults };
}

// The level the learner is working on: the first one that is not fully covered, otherwise the last one.
export function currentLevel(levels: LevelProgress[]): LevelProgress | null {
  for (const l of levels) {
    if (l.covered < l.total) return l;
  }
  return levels.length > 0 ? levels[levels.length - 1] : null;
}
