import {
  computeProgress,
  currentLevel,
  isCovered,
  isMastered,
  nextTopics,
  statusRank,
  type Checkpoint,
  type PlanModule,
  type PlanTopic,
  type Progress,
  type StatusMap,
  type TopicEvidence,
  type TopicProgressInput,
  type TopicStatus,
} from "./planner";
import type { SrsStatus } from "./srs";
import type {
  CheckpointResult,
  ModuleView,
  NextTopicsView,
  PlanSummary,
  Profile,
  ProfilePatch,
  ProgressView,
  SyllabusStore,
  SyllabusView,
  TopicCard,
  TopicItemView,
  TopicRef,
  TopicStatusChange,
} from "./syllabus-store";
import { addDays } from "./time";

const DEFAULT_PROFILE: Profile = { ui_lang: "en", known_langs: [], variety: null, packs: ["core"] };

interface ProfileRow {
  ui_lang: string;
  known_langs_json: string;
  variety: string | null;
  packs_json: string;
}

interface ModuleRow {
  id: string;
  level: string;
  ord: number;
  title: string;
}

interface TopicListRow {
  id: string;
  module_id: string;
  kind: string;
  title: string;
  ord: number;
}

interface TopicFullRow extends TopicListRow {
  summary: string;
  examples_json: string;
  traps_json: string;
  transfer_json: string | null;
  error_tags_json: string;
  variety_note: string | null;
  deprecated: number;
  replaced_by: string | null;
}

interface EvidenceRow {
  topic_id: string;
  item_id: string;
  srs_status: string;
  recent_wrong: number;
}

// Everything the planner needs for one language, loaded with one batch.
interface LoadedPlan {
  profile: Profile;
  variety: string;
  modules: ModuleRow[];
  topics: TopicListRow[];
  titles: Map<string, string>; // topic id -> title in the learner's language
  planModules: PlanModule[];
  planTopics: PlanTopic[];
  statuses: StatusMap;
  changedAt: Map<string, string>;
  evidence: Map<string, TopicEvidence>;
  checkpoints: Map<string, Checkpoint>;
}

function toProfile(row: ProfileRow | null): Profile {
  if (row === null) return { ...DEFAULT_PROFILE, known_langs: [], packs: [...DEFAULT_PROFILE.packs] };
  return {
    ui_lang: row.ui_lang,
    known_langs: JSON.parse(row.known_langs_json) as string[],
    variety: row.variety,
    packs: JSON.parse(row.packs_json) as string[],
  };
}

function itemIdOf(lang: string, topicId: string): string {
  return `${lang}:grammar_point:${topicId}`;
}

// Mastery looks at wrong answers of the last 14 days.
function recentSince(): string {
  return addDays(new Date().toISOString(), -14);
}

// SQL that lists the items of every topic of a language: the topic's own item and items linked with part_of.
const TOPIC_ITEMS_SQL = `
  SELECT t.id AS topic_id, t.lang || ':grammar_point:' || t.id AS item_id
  FROM syllabus_topics t WHERE t.lang = ?2
  UNION
  SELECT t.id, e.src
  FROM edges e JOIN syllabus_topics t ON e.dst = t.lang || ':grammar_point:' || t.id
  WHERE e.user_id = ?1 AND e.type = 'part_of' AND t.lang = ?2`;

export class D1Syllabus implements SyllabusStore {
  constructor(
    private db: D1Database,
    private userId: string,
  ) {}

  async getProfile(): Promise<Profile> {
    const row = await this.db
      .prepare("SELECT * FROM learner_profile WHERE user_id = ?1")
      .bind(this.userId)
      .first<ProfileRow>();
    return toProfile(row);
  }

  async setProfile(patch: ProfilePatch): Promise<Profile> {
    const current = await this.getProfile();
    const next: Profile = {
      ui_lang: patch.ui_lang ?? current.ui_lang,
      known_langs: patch.known_langs ?? current.known_langs,
      variety: patch.variety === undefined ? current.variety : patch.variety,
      packs: patch.packs ?? current.packs,
    };
    await this.db
      .prepare(
        `INSERT INTO learner_profile (user_id, ui_lang, known_langs_json, variety, packs_json) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(user_id) DO UPDATE SET ui_lang = excluded.ui_lang, known_langs_json = excluded.known_langs_json,
           variety = excluded.variety, packs_json = excluded.packs_json`,
      )
      .bind(this.userId, next.ui_lang, JSON.stringify(next.known_langs), next.variety, JSON.stringify(next.packs))
      .run();
    return next;
  }

  // Returns null when no syllabus was imported for the language.
  private async loadPlan(lang: string): Promise<LoadedPlan | null> {
    const since = recentSince();
    const results = await this.db.batch([
      this.db.prepare("SELECT variety FROM syllabus_meta WHERE lang = ?1").bind(lang),
      this.db.prepare("SELECT * FROM learner_profile WHERE user_id = ?1").bind(this.userId),
      this.db.prepare("SELECT id, level, ord, title FROM syllabus_modules WHERE deprecated = 0 ORDER BY ord"),
      this.db
        .prepare(
          "SELECT id, module_id, kind, title, ord FROM syllabus_topics WHERE lang = ?1 AND deprecated = 0 ORDER BY ord",
        )
        .bind(lang),
      this.db.prepare("SELECT topic_id, requires_id FROM syllabus_requires WHERE lang = ?1").bind(lang),
      this.db
        .prepare("SELECT topic_id, status, changed_at FROM learner_topics WHERE user_id = ?1 AND lang = ?2")
        .bind(this.userId, lang),
      this.db
        .prepare(
          `SELECT el.topic_id, el.item_id, COALESCE(s.status, 'new') AS srs_status,
             (SELECT COUNT(*) FROM attempts a
              WHERE a.user_id = ?1 AND a.item_id = el.item_id AND a.correct = 0 AND a.ts >= ?3) AS recent_wrong
           FROM (${TOPIC_ITEMS_SQL}) el
           JOIN items i ON i.user_id = ?1 AND i.id = el.item_id
           LEFT JOIN item_srs s ON s.user_id = ?1 AND s.item_id = el.item_id`,
        )
        .bind(this.userId, lang, since),
      this.db
        .prepare(
          "SELECT module_id, passed, ts FROM learner_checkpoints WHERE user_id = ?1 AND lang = ?2 ORDER BY ts, id",
        )
        .bind(this.userId, lang),
    ]);

    const meta = results[0].results[0] as unknown as { variety: string } | undefined;
    if (meta === undefined) return null;

    const profile = toProfile((results[1].results[0] as unknown as ProfileRow | undefined) ?? null);
    const modules = results[2].results as unknown as ModuleRow[];
    const topics = results[3].results as unknown as TopicListRow[];

    const titles = new Map<string, string>();
    for (const t of topics) titles.set(t.id, t.title);

    const planModules: PlanModule[] = [];
    for (const m of modules) planModules.push({ id: m.id, level: m.level, ord: m.ord });

    const requiresOf = new Map<string, string[]>();
    for (const r of results[4].results as unknown as { topic_id: string; requires_id: string }[]) {
      const list = requiresOf.get(r.topic_id) ?? [];
      list.push(r.requires_id);
      requiresOf.set(r.topic_id, list);
    }
    const planTopics: PlanTopic[] = [];
    for (const t of topics) {
      planTopics.push({ id: t.id, moduleId: t.module_id, ord: t.ord, requires: requiresOf.get(t.id) ?? [] });
    }

    const statuses: StatusMap = new Map();
    const changedAt = new Map<string, string>();
    for (const r of results[5].results as unknown as { topic_id: string; status: TopicStatus; changed_at: string }[]) {
      statuses.set(r.topic_id, r.status);
      changedAt.set(r.topic_id, r.changed_at);
    }

    const evidence = new Map<string, TopicEvidence>();
    for (const r of results[6].results as unknown as EvidenceRow[]) {
      let ev = evidence.get(r.topic_id);
      if (ev === undefined) {
        ev = { itemCount: 0, knownCount: 0, recentWrong: 0 };
        evidence.set(r.topic_id, ev);
      }
      ev.itemCount += 1;
      if (r.srs_status === "known") ev.knownCount += 1;
      ev.recentWrong += r.recent_wrong;
    }

    // Rows are sorted by time, so the last one per module is the latest checkpoint.
    const checkpoints = new Map<string, Checkpoint>();
    for (const r of results[7].results as unknown as { module_id: string; passed: number; ts: string }[]) {
      checkpoints.set(r.module_id, { passed: r.passed === 1, ts: r.ts });
    }

    return {
      profile,
      variety: meta.variety,
      modules,
      topics,
      titles,
      planModules,
      planTopics,
      statuses,
      changedAt,
      evidence,
      checkpoints,
    };
  }

  private async requirePlan(lang: string): Promise<LoadedPlan> {
    const plan = await this.loadPlan(lang);
    if (plan === null) throw new Error(`No syllabus is imported for "${lang}"`);
    return plan;
  }

  private progressOf(plan: LoadedPlan): Progress {
    const inputs: TopicProgressInput[] = [];
    for (const t of plan.topics) {
      inputs.push({
        id: t.id,
        moduleId: t.module_id,
        status: plan.statuses.get(t.id),
        changedAt: plan.changedAt.get(t.id),
        evidence: plan.evidence.get(t.id),
      });
    }
    return computeProgress(plan.planModules, inputs, plan.checkpoints);
  }

  private nextView(plan: LoadedPlan): NextTopicsView {
    const next = nextTopics(plan.planModules, plan.planTopics, plan.statuses);
    const titleOf = (id: string): string => plan.titles.get(id) ?? id;
    const view: NextTopicsView = { current: [], continue: [], fill: [], blocked: next.blocked };
    for (const id of next.current) view.current.push({ id, title: titleOf(id) });
    for (const c of next.continue) view.continue.push({ ...c, title: titleOf(c.id) });
    for (const c of next.fill) view.fill.push({ ...c, title: titleOf(c.id) });
    return view;
  }

  async getSyllabus(lang: string, level?: string, moduleId?: string): Promise<SyllabusView> {
    const plan = await this.requirePlan(lang);
    const progress = this.progressOf(plan);
    const canDoRes = await this.db
      .prepare("SELECT id, module_id, text FROM syllabus_can_do ORDER BY module_id, ord")
      .all<{ id: string; module_id: string; text: string }>();

    const modules: ModuleView[] = [];
    for (const m of plan.modules) {
      if (level !== undefined && m.level !== level) continue;
      if (moduleId !== undefined && m.id !== moduleId) continue;
      let moduleProgress = progress.modules[0];
      for (const p of progress.modules) {
        if (p.module_id === m.id) moduleProgress = p;
      }
      const canDo: { id: string; text: string }[] = [];
      for (const c of canDoRes.results) {
        if (c.module_id === m.id) canDo.push({ id: c.id, text: c.text });
      }
      const topics: TopicRef[] = [];
      for (const t of plan.topics) {
        if (t.module_id !== m.id) continue;
        topics.push({
          id: t.id,
          title: plan.titles.get(t.id) ?? t.id,
          kind: t.kind,
          status: plan.statuses.get(t.id) ?? "planned",
        });
      }
      modules.push({
        ...moduleProgress,
        title: m.title,
        can_do: canDo,
        topics,
      });
    }
    if (modules.length === 0) throw new Error("No module matches the given level/module");

    const levels = progress.levels.filter((l) => level === undefined || l.level === level);
    return { lang, ui_lang: plan.profile.ui_lang, variety: plan.variety, modules, levels };
  }

  async getTopic(lang: string, topicId: string): Promise<TopicCard> {
    const itemId = itemIdOf(lang, topicId);
    const results = await this.db.batch([
      this.db.prepare("SELECT * FROM syllabus_topics WHERE lang = ?1 AND id = ?2").bind(lang, topicId),
      this.db.prepare("SELECT * FROM learner_profile WHERE user_id = ?1").bind(this.userId),
      this.db
        .prepare("SELECT status FROM learner_topics WHERE user_id = ?1 AND lang = ?2 AND topic_id = ?3")
        .bind(this.userId, lang, topicId),
      this.db
        .prepare(
          `SELECT t.id, t.title, lt.status
           FROM syllabus_requires r
           JOIN syllabus_topics t ON t.lang = r.lang AND t.id = r.requires_id
           LEFT JOIN learner_topics lt ON lt.user_id = ?1 AND lt.lang = r.lang AND lt.topic_id = r.requires_id
           WHERE r.lang = ?2 AND r.topic_id = ?3 ORDER BY t.ord`,
        )
        .bind(this.userId, lang, topicId),
      this.db
        .prepare(
          `SELECT el.item_id, el.relation, i.label, i.data_json, COALESCE(s.status, 'new') AS srs_status,
             COALESCE(s.streak, 0) AS streak, COALESCE(s.interval_days, 0) AS interval_days, s.due_at,
             (SELECT COUNT(*) FROM attempts a
              WHERE a.user_id = ?1 AND a.item_id = el.item_id AND a.correct = 0 AND a.ts >= ?3) AS recent_wrong
           FROM (
             SELECT ?2 AS item_id, 'self' AS relation
             UNION ALL
             SELECT e.src, 'part_of' FROM edges e WHERE e.user_id = ?1 AND e.dst = ?2 AND e.type = 'part_of'
           ) el
           JOIN items i ON i.user_id = ?1 AND i.id = el.item_id
           LEFT JOIN item_srs s ON s.user_id = ?1 AND s.item_id = el.item_id
           ORDER BY el.relation DESC, i.label LIMIT 51`,
        )
        .bind(this.userId, itemId, recentSince()),
    ]);

    const row = results[0].results[0] as unknown as TopicFullRow | undefined;
    if (row === undefined) throw new Error(`Unknown topic_id "${topicId}" for "${lang}"`);
    const profile = toProfile((results[1].results[0] as unknown as ProfileRow | undefined) ?? null);
    const statusRow = results[2].results[0] as unknown as { status: TopicStatus } | undefined;
    const status: TopicStatus = statusRow === undefined ? "planned" : statusRow.status;

    const requires: { id: string; title: string; status: TopicStatus }[] = [];
    for (const r of results[3].results as unknown as { id: string; title: string; status: TopicStatus | null }[]) {
      requires.push({
        id: r.id,
        title: r.title,
        status: r.status ?? "planned",
      });
    }

    const items: TopicItemView[] = [];
    let selfData: unknown = null;
    const evidence: TopicEvidence = { itemCount: 0, knownCount: 0, recentWrong: 0 };
    const itemRows = results[4].results as unknown as {
      item_id: string;
      relation: "self" | "part_of";
      label: string;
      data_json: string | null;
      srs_status: SrsStatus;
      streak: number;
      interval_days: number;
      due_at: string | null;
      recent_wrong: number;
    }[];
    for (const r of itemRows) {
      if (r.relation === "self" && r.data_json !== null) selfData = JSON.parse(r.data_json);
      items.push({
        id: r.item_id,
        label: r.label,
        relation: r.relation,
        srs: { status: r.srs_status, streak: r.streak, interval_days: r.interval_days, due_at: r.due_at },
      });
      evidence.itemCount += 1;
      if (r.srs_status === "known") evidence.knownCount += 1;
      evidence.recentWrong += r.recent_wrong;
    }

    // Transfer hints only for languages the learner already knows.
    const transfer: Record<string, string> = {};
    if (row.transfer_json !== null) {
      const all = JSON.parse(row.transfer_json) as Record<string, string>;
      for (const known of profile.known_langs) {
        if (all[known] !== undefined) transfer[known] = all[known];
      }
    }

    return {
      id: row.id,
      title: row.title,
      kind: row.kind,
      module_id: row.module_id,
      status,
      deprecated: row.deprecated === 1,
      replaced_by: row.replaced_by,
      summary: row.summary,
      examples: JSON.parse(row.examples_json) as string[],
      traps: JSON.parse(row.traps_json) as string[],
      transfer,
      variety_note: row.variety_note,
      error_tags: JSON.parse(row.error_tags_json) as string[],
      requires,
      data: selfData,
      items,
      mastered: isMastered(isCovered(status), evidence),
    };
  }

  async nextTopics(lang: string): Promise<NextTopicsView> {
    return this.nextView(await this.requirePlan(lang));
  }

  async setTopicStatus(
    lang: string,
    topicId: string,
    status: TopicStatus,
    sessionId?: string,
    allowRegress = false,
  ): Promise<TopicStatusChange> {
    const topic = await this.db
      .prepare("SELECT deprecated, replaced_by FROM syllabus_topics WHERE lang = ?1 AND id = ?2")
      .bind(lang, topicId)
      .first<{ deprecated: number; replaced_by: string | null }>();
    if (!topic) throw new Error(`Unknown topic_id "${topicId}" for "${lang}"`);
    if (topic.deprecated === 1) {
      const hint = topic.replaced_by === null ? "" : `, use "${topic.replaced_by}" instead`;
      throw new Error(`Topic "${topicId}" is deprecated${hint}`);
    }
    let sessionKind: string | undefined = undefined;
    if (sessionId !== undefined) {
      const session = await this.db
        .prepare("SELECT kind FROM sessions WHERE user_id = ?1 AND id = ?2")
        .bind(this.userId, sessionId)
        .first<{ kind: string }>();
      if (!session) throw new Error(`Unknown session_id: ${sessionId}`);
      sessionKind = session.kind;
    }
    if (status === "assumed" && sessionKind !== "placement") {
      throw new Error(
        `"assumed" can only be set inside a placement session (start_session with kind "placement", then pass its session_id)`,
      );
    }

    const prevRow = await this.db
      .prepare("SELECT status FROM learner_topics WHERE user_id = ?1 AND lang = ?2 AND topic_id = ?3")
      .bind(this.userId, lang, topicId)
      .first<{ status: TopicStatus }>();
    const previous: TopicStatus = prevRow === null ? "planned" : prevRow.status;
    if (statusRank(status) < statusRank(previous) && !allowRegress) {
      throw new Error(
        `"${topicId}" is ${previous}; moving it back to ${status} must be explicit (pass allow_regress: true)`,
      );
    }

    const reqRes = await this.db
      .prepare(
        `SELECT r.requires_id, lt.status FROM syllabus_requires r
         LEFT JOIN learner_topics lt ON lt.user_id = ?1 AND lt.lang = r.lang AND lt.topic_id = r.requires_id
         WHERE r.lang = ?2 AND r.topic_id = ?3 ORDER BY r.requires_id`,
      )
      .bind(this.userId, lang, topicId)
      .all<{ requires_id: string; status: TopicStatus | null }>();
    const unmet: string[] = [];
    for (const r of reqRes.results) {
      if (!isCovered(r.status ?? undefined)) unmet.push(r.requires_id);
    }

    await this.db
      .prepare(
        `INSERT INTO learner_topics (user_id, lang, topic_id, status, changed_at, source) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(user_id, lang, topic_id) DO UPDATE SET status = excluded.status, changed_at = excluded.changed_at,
           source = excluded.source`,
      )
      .bind(
        this.userId,
        lang,
        topicId,
        status,
        new Date().toISOString(),
        sessionId === undefined ? "set_topic_status" : `session:${sessionId}`,
      )
      .run();
    return { topic_id: topicId, previous, status, unmet_requires: unmet };
  }

  async progress(lang: string, level?: string): Promise<ProgressView> {
    const plan = await this.requirePlan(lang);
    const progress = this.progressOf(plan);
    const modules: (typeof progress.modules[number] & { title: string })[] = [];
    for (const p of progress.modules) {
      if (level !== undefined && p.level !== level) continue;
      let title = p.module_id;
      for (const m of plan.modules) {
        if (m.id === p.module_id) title = m.title;
      }
      modules.push({ ...p, title });
    }
    const levels = progress.levels.filter((l) => level === undefined || l.level === level);
    return { lang, modules, levels };
  }

  async recordCheckpoint(
    lang: string,
    moduleId: string,
    passed: boolean,
    sessionId?: string,
    notes?: string,
  ): Promise<CheckpointResult> {
    const mod = await this.db.prepare("SELECT 1 AS x FROM syllabus_modules WHERE id = ?1").bind(moduleId).first();
    if (!mod) throw new Error(`Unknown module_id: ${moduleId}`);
    if (sessionId !== undefined) {
      const session = await this.db
        .prepare("SELECT 1 AS x FROM sessions WHERE user_id = ?1 AND id = ?2")
        .bind(this.userId, sessionId)
        .first();
      if (!session) throw new Error(`Unknown session_id: ${sessionId}`);
    }
    await this.db
      .prepare(
        "INSERT INTO learner_checkpoints (user_id, lang, module_id, session_id, passed, notes, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      )
      .bind(this.userId, lang, moduleId, sessionId ?? null, passed ? 1 : 0, notes ?? null, new Date().toISOString())
      .run();
    const plan = await this.requirePlan(lang);
    const progress = this.progressOf(plan);
    for (const p of progress.modules) {
      if (p.module_id === moduleId) return { ok: true, module: p };
    }
    throw new Error(`Module ${moduleId} is not part of the ${lang} plan`);
  }

  async planSummary(lang: string): Promise<PlanSummary | null> {
    const plan = await this.loadPlan(lang);
    if (plan === null) return null;
    const progress = this.progressOf(plan);
    const level = currentLevel(progress.levels);
    const next = this.nextView(plan);
    return {
      level: level === null ? null : level.level,
      coverage: level === null ? null : { covered: level.covered, mastered: level.mastered, total: level.total },
      next,
    };
  }

  async syllabusErrorTypes(lang: string): Promise<string[]> {
    const res = await this.db
      .prepare("SELECT id FROM syllabus_errors WHERE scope IN ('core', ?1) ORDER BY id")
      .bind(lang)
      .all<{ id: string }>();
    const ids: string[] = [];
    for (const r of res.results) ids.push(r.id);
    return ids;
  }
}
