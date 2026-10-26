import type { SrsState, SrsStatus } from "./srs";
import type { PlanSummary, SyllabusStore } from "./syllabus-store";

export const ITEM_TYPES = ["lemma", "form", "grammar_point", "collocation"] as const;
export const EDGE_TYPES = ["form_of", "requires", "contrasts_with", "collocates", "part_of"] as const;

export type Lang = string;
export type ItemType = (typeof ITEM_TYPES)[number];
export type EdgeType = (typeof EDGE_TYPES)[number];
export type ErrorType = string;

export interface Item {
  id: string;
  lang: string;
  type: ItemType;
  label: string;
  data: unknown;
  created_at: string;
}

export interface Edge {
  src: string;
  dst: string;
  type: EdgeType;
}

export interface Attempt {
  id: number;
  item_id: string;
  ts: string;
  correct: boolean;
  error_type: string | null;
  context: string | null;
  session_id: string | null;
}

export interface ItemContext {
  item: Item;
  srs: SrsState;
  outgoing: Edge[];
  incoming: Edge[];
  neighbors: Item[];
  attempts: Attempt[];
}

export interface AttemptInput {
  itemId: string;
  correct: boolean;
  errorType?: ErrorType;
  context?: string;
  ts?: string;
  sessionId?: string;
}

export interface Session {
  id: string;
  lang: string;
  kind: string;
  title: string;
  plan: string | null;
  started_at: string;
  ended_at: string | null;
  status: "open" | "closed";
  summary: string | null;
  score: number | null;
  next_step: string | null;
  attempts_count: number;
}

export interface SessionDetail extends Session {
  attempts: (Attempt & { label: string | null })[];
}

export interface DueItem {
  id: string;
  label: string;
  type: ItemType;
  status: SrsStatus;
  due_at: string;
  overdue_days: number;
  streak: number;
  interval_days: number;
  recent_errors: number;
}

export interface FoundItem {
  id: string;
  label: string;
  type: ItemType;
  status: SrsStatus;
  data: unknown;
}

export interface WeakItem {
  id: string;
  label: string;
  type: ItemType;
  attempts: number;
  wrong: number;
  error_rate: number;
}

export interface Stats {
  lang: string;
  since: string | null;
  attempts: number;
  correct: number;
  correct_pct: number | null;
  errors_by_type: Record<string, number>;
  items_by_status: Record<SrsStatus, number>;
}

export interface CourseState {
  plan?: PlanSummary | null; // set by the tool layer when a syllabus is imported for the language
  lang: string;
  data: unknown;
  updated_at: string | null;
}

// Backend-agnostic storage. Tools depend only on this.
export interface Store extends SyllabusStore {
  upsertItem(lang: Lang, type: ItemType, label: string, data?: Record<string, unknown>, replace?: boolean): Promise<string>;
  link(src: string, dst: string, type: EdgeType): Promise<void>;
  logAttempt(input: AttemptInput): Promise<SrsState>;
  getContext(itemId: string, attemptsLimit: number): Promise<ItemContext | null>;

  startSession(lang: Lang, title: string, plan?: string, kind?: string): Promise<string>;
  endSession(id: string, summary?: string, score?: number, nextStep?: string): Promise<void>;
  listSessions(lang: Lang, limit: number): Promise<Session[]>;
  getSession(id: string): Promise<SessionDetail | null>;

  dueItems(lang: Lang, date: string, type: ItemType | undefined, limit: number): Promise<DueItem[]>;
  findItems(lang: Lang, query: string | undefined, type: ItemType | undefined, status: SrsStatus | undefined, limit: number): Promise<FoundItem[]>;
  weakItems(lang: Lang, limit: number): Promise<WeakItem[]>;
  stats(lang: Lang, since?: string): Promise<Stats>;

  getCourseState(lang: Lang): Promise<CourseState>;
  setCourseState(lang: Lang, data: Record<string, unknown>): Promise<void>;
}
