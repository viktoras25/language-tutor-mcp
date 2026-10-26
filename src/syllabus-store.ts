import type { SrsStatus } from "./srs";
import type { LevelProgress, ModuleProgress, NextCandidate, Tally, TopicStatus } from "./planner";

// Result shapes of the syllabus tools. All texts are already in the learner's ui_lang (English as fallback).

export interface Profile {
  ui_lang: string;
  known_langs: string[];
  variety: string | null;
  packs: string[];
}

export interface ProfilePatch {
  ui_lang?: string;
  known_langs?: string[];
  variety?: string | null;
  packs?: string[];
}

export interface TopicRef {
  id: string;
  title: string;
  kind: string;
  status: TopicStatus;
}

export interface ModuleView extends ModuleProgress {
  title: string;
  can_do: { id: string; text: string }[];
  topics: TopicRef[];
}

export interface SyllabusView {
  lang: string;
  ui_lang: string;
  variety: string;
  modules: ModuleView[];
  levels: LevelProgress[];
}

export interface TopicItemView {
  id: string;
  label: string;
  relation: "self" | "part_of";
  srs: { status: SrsStatus; streak: number; interval_days: number; due_at: string | null };
}

export interface TopicCard {
  id: string;
  title: string;
  kind: string;
  module_id: string;
  status: TopicStatus;
  deprecated: boolean;
  replaced_by: string | null;
  summary: string;
  examples: string[];
  traps: string[];
  transfer: Record<string, string>; // only languages the learner already knows
  variety_note: string | null;
  error_tags: string[];
  requires: { id: string; title: string; status: TopicStatus }[];
  data: unknown; // data of the topic's own item (rule, note, ...)
  items: TopicItemView[];
  mastered: boolean;
}

export interface NextCandidateView extends NextCandidate {
  title: string;
}

export interface NextTopicsView {
  current: { id: string; title: string }[];
  continue: NextCandidateView[];
  fill: NextCandidateView[];
  blocked: number;
}

export interface ProgressView {
  lang: string;
  modules: (ModuleProgress & { title: string })[];
  levels: LevelProgress[];
}

export interface TopicStatusChange {
  topic_id: string;
  previous: TopicStatus;
  status: TopicStatus;
  unmet_requires: string[]; // prerequisites that are not covered yet (teaching goes ahead anyway)
}

export interface CheckpointResult {
  ok: true;
  module: ModuleProgress;
}

// Short summary for get_course_state, so a new chat gets everything in one call.
export interface PlanSummary {
  level: string | null;
  coverage: Tally | null;
  next: NextTopicsView; // includes the topics being taught now (next.current)
}

export interface SyllabusStore {
  getProfile(): Promise<Profile>;
  setProfile(patch: ProfilePatch): Promise<Profile>;
  getSyllabus(lang: string, level?: string, moduleId?: string): Promise<SyllabusView>;
  getTopic(lang: string, topicId: string): Promise<TopicCard>;
  nextTopics(lang: string): Promise<NextTopicsView>;
  setTopicStatus(lang: string, topicId: string, status: TopicStatus, sessionId?: string, allowRegress?: boolean): Promise<TopicStatusChange>;
  progress(lang: string, level?: string): Promise<ProgressView>;
  recordCheckpoint(lang: string, moduleId: string, passed: boolean, sessionId?: string, notes?: string): Promise<CheckpointResult>;
  planSummary(lang: string): Promise<PlanSummary | null>;
  // Error categories allowed for a language: core + that language's extensions from the syllabus.
  syllabusErrorTypes(lang: string): Promise<string[]>;
}
