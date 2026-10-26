import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "./config";
import { SETTABLE_STATUSES } from "./planner";
import { EDGE_TYPES, ITEM_TYPES, type Store } from "./store";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function failure(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// Wraps a handler so thrown store errors (unknown id, bad ts, ...) become readable tool errors.
function safe<A>(fn: (args: A) => Promise<ReturnType<typeof text>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return failure((e as Error).message);
    }
  };
}

const itemType = z.enum(ITEM_TYPES);
const langCode = z.string().regex(/^[a-z]{2,3}$/, "expected a language code such as ru or de");
const slug = z.string().regex(/^[a-z][a-z0-9-]*$/, "expected lowercase letters, digits and -");
const level = z.string().regex(/^[A-C][1-2]$/, "expected a CEFR level such as A1");
const moduleId = z.string().regex(/^[A-C][1-2]\.\d{2}$/, "expected a module id such as A1.03");
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export function createServer(store: Store, config: Config): McpServer {
  const lang = z.enum(config.langs as [string, ...string[]]);
  const errorTypeList = config.errorTypes.join(", ");
  const server = new McpServer({ name: "language-memory", version: "0.3.0" });

  server.registerTool(
    "upsert_item",
    {
      description:
        "Create or update a learning item (lemma, form, grammar_point, collocation). Idempotent per lang+type+label; returns its id (<lang>:<type>:<lowercased label>). `data` is MERGED into existing data (a null value deletes that key); pass replace=true to overwrite it entirely.",
      inputSchema: z.object({
        lang,
        type: itemType,
        label: z.string().min(1).max(200),
        data: z.record(z.string(), z.unknown()).optional(),
        replace: z.boolean().optional().describe("true = overwrite data instead of merging"),
      }),
    },
    safe(async ({ lang, type, label, data, replace }) => text({ id: await store.upsertItem(lang, type, label, data, replace) })),
  );

  server.registerTool(
    "link",
    {
      description: "Create an edge between two existing items (by id), e.g. a form -> its lemma with form_of.",
      inputSchema: z.object({ src: z.string().min(1), dst: z.string().min(1), type: z.enum(EDGE_TYPES) }),
    },
    safe(async ({ src, dst, type }) => {
      await store.link(src, dst, type);
      return text({ ok: true });
    }),
  );

  server.registerTool(
    "log_attempt",
    {
      description:
        "Record one answer for an item after the learner responds. Updates the spaced-repetition state server-side and returns it (next due_at, streak, status). Pass session_id of the current lesson. Use ts only to import history with real dates; otherwise it is now.",
      inputSchema: z.object({
        item_id: z.string().min(1),
        correct: z.boolean(),
        error_type: z
          .string()
          .min(1)
          .max(40)
          .optional()
          .describe(
            `Only for wrong answers. Generic: ${errorTypeList}. If the language has a syllabus, its categories are valid too (core, e.g. accent, mood, pronoun, register, plus language-specific ones such as por-para). An invalid value is rejected with the full list for that language. Use "other" if nothing fits.`,
          ),
        context: z.string().max(1000).optional().describe("The sentence/task and the learner's wrong answer"),
        ts: z.string().optional().describe("ISO 8601 time of the attempt, e.g. 2026-10-15T12:00:00Z"),
        session_id: z.string().optional().describe("id from start_session"),
      }),
    },
    safe(async ({ item_id, correct, error_type, context, ts, session_id }) => {
      const srs = await store.logAttempt({
        itemId: item_id,
        correct,
        errorType: error_type,
        context,
        ts,
        sessionId: session_id,
      });
      return text({ ok: true, srs });
    }),
  );

  server.registerTool(
    "get_context",
    {
      description:
        "Read one item before teaching it: its data, SRS state (status, streak, interval_days, due_at), direct neighbors (depth 1) and the latest attempts (default 5; raise attempts_limit for more history).",
      inputSchema: z.object({
        item_id: z.string().min(1),
        attempts_limit: z.number().int().min(0).max(50).optional().describe("default 5, max 50"),
      }),
    },
    safe(async ({ item_id, attempts_limit }) => {
      const ctx = await store.getContext(item_id, attempts_limit ?? 5);
      return ctx ? text(ctx) : failure(`Unknown item_id: ${item_id}`);
    }),
  );

  server.registerTool(
    "start_session",
    {
      description:
        "Call at the very start of a lesson/review/test, before asking questions. Returns a session id to pass to log_attempt and end_session. A session never ended shows as status=open (lesson without a recorded result).",
      inputSchema: z.object({
        lang,
        title: z.string().min(1).max(200),
        plan: z.string().max(4000).optional().describe("What the lesson intends to cover"),
        kind: z.string().min(1).max(50).optional().describe('default "lesson"'),
      }),
    },
    safe(async ({ lang, title, plan, kind }) => text({ id: await store.startSession(lang, title, plan, kind) })),
  );

  server.registerTool(
    "end_session",
    {
      description:
        "Call when the lesson is finished. Records the outcome so the next chat knows where things stand. Fails if the session is already closed.",
      inputSchema: z.object({
        id: z.string().min(1),
        summary: z.string().max(4000).optional().describe("What was covered and how it went"),
        score: z.number().min(0).max(100).optional().describe("Percent correct, 0-100"),
        next_step: z.string().max(2000).optional().describe("What the next lesson should do first"),
      }),
    },
    safe(async ({ id, summary, score, next_step }) => {
      await store.endSession(id, summary, score, next_step);
      return text({ ok: true });
    }),
  );

  server.registerTool(
    "list_sessions",
    {
      description:
        "Call at the start of a new chat to see recent lessons (newest first) with summary, score and next_step. status=open means the lesson was started but never ended.",
      inputSchema: z.object({ lang, limit: z.number().int().min(1).max(50).optional().describe("default 5") }),
    },
    safe(async ({ lang, limit }) => text(await store.listSessions(lang, limit ?? 5))),
  );

  server.registerTool(
    "get_session",
    {
      description: "Read one session with all its attempts (item labels, correctness, error types). Use to review a specific lesson.",
      inputSchema: z.object({ id: z.string().min(1) }),
    },
    safe(async ({ id }) => {
      const s = await store.getSession(id);
      return s ? text(s) : failure(`Unknown session id: ${id}`);
    }),
  );

  server.registerTool(
    "due_items",
    {
      description:
        "Call before planning a lesson: items due for repetition on `date` (default today, UTC), most urgent first (items with errors in the last 3 days, then oldest due). Never-attempted items are not listed; use find_items for those.",
      inputSchema: z.object({
        lang,
        date: isoDay.optional().describe("YYYY-MM-DD, default today"),
        type: itemType.optional(),
        limit: z.number().int().min(1).max(100).optional().describe("default 20"),
      }),
    },
    safe(async ({ lang, date, type, limit }) =>
      text(await store.dueItems(lang, date ?? new Date().toISOString().slice(0, 10), type, limit ?? 20)),
    ),
  );

  server.registerTool(
    "find_items",
    {
      description:
        "Search items by text in label or data (case-insensitive for ASCII), optionally filtered by type and SRS status (new/learning/known). Use to look up an item id or to pick new material.",
      inputSchema: z.object({
        lang,
        query: z.string().max(200).optional(),
        type: itemType.optional(),
        status: z.enum(["new", "learning", "known"]).optional(),
        limit: z.number().int().min(1).max(50).optional().describe("default 20"),
      }),
    },
    safe(async ({ lang, query, type, status, limit }) => text(await store.findItems(lang, query, type, status, limit ?? 20))),
  );

  server.registerTool(
    "weak_items",
    {
      description: "Items with the highest share of wrong answers in the last 14 days. Use to decide what needs extra drilling.",
      inputSchema: z.object({ lang, limit: z.number().int().min(1).max(50).optional().describe("default 10") }),
    },
    safe(async ({ lang, limit }) => text(await store.weakItems(lang, limit ?? 10))),
  );

  server.registerTool(
    "stats",
    {
      description: "Progress overview: attempts, % correct, wrong answers by error_type, and item counts by status. Optional `since` (ISO 8601) limits attempts.",
      inputSchema: z.object({ lang, since: z.string().optional() }),
    },
    safe(async ({ lang, since }) => text(await store.stats(lang, since))),
  );

  server.registerTool(
    "get_course_state",
    {
      description:
        "Read the course state (level, lessons done, learner preferences, next lesson plan). Call first in every new chat. If the language has a syllabus, `plan` also summarises it: current level and coverage, topics being taught now and what next_topics proposes.",
      inputSchema: z.object({ lang }),
    },
    safe(async ({ lang }) => {
      const state = await store.getCourseState(lang);
      return text({ ...state, plan: await store.planSummary(lang) });
    }),
  );

  server.registerTool(
    "set_course_state",
    {
      description:
        "Replace the whole course state for a language. Read it with get_course_state first and send back the full object, otherwise fields are lost. Call at the end of a lesson.",
      inputSchema: z.object({ lang, data: z.record(z.string(), z.unknown()) }),
    },
    safe(async ({ lang, data }) => {
      await store.setCourseState(lang, data);
      return text({ ok: true });
    }),
  );

  server.registerTool(
    "get_syllabus",
    {
      description:
        "The curriculum with the learner's progress (texts are in English; explain them in the learner's ui_lang): modules (with can-do goals), their topics (id, title, kind, status) and coverage/mastery counts. Compact: no summaries or examples (use get_topic for those). Narrow with level (A1, A2) or module (A1.03).",
      inputSchema: z.object({ lang, level: level.optional(), module: moduleId.optional() }),
    },
    safe(async ({ lang, level, module }) => text(await store.getSyllabus(lang, level, module))),
  );

  server.registerTool(
    "get_topic",
    {
      description:
        "Lesson card for one topic: summary, examples, traps, transfer hints (only for languages the learner knows), prerequisite statuses, and the linked items with their SRS state. Call before teaching a topic.",
      inputSchema: z.object({ lang, topic_id: slug }),
    },
    safe(async ({ lang, topic_id }) => text(await store.getTopic(lang, topic_id))),
  );

  server.registerTool(
    "next_topics",
    {
      description:
        "What to teach next, chosen by the server: `continue` = topics that follow the one being taught now, `fill` = earliest gaps in plan order (3 of each), `blocked` = how many open topics still wait for prerequisites. Choosing between the groups and the size of the lesson is up to you.",
      inputSchema: z.object({ lang }),
    },
    safe(async ({ lang }) => text(await store.nextTopics(lang))),
  );

  server.registerTool(
    "set_topic_status",
    {
      description:
        "Mark a topic as `current` (being taught now) or `introduced` (taught in a lesson). Moving a topic back (e.g. introduced -> current or planned) is refused unless allow_regress is true. Returns prerequisites that are not covered yet; the change is made anyway.",
      inputSchema: z.object({
        lang,
        topic_id: slug,
        status: z.enum(SETTABLE_STATUSES),
        session_id: z.string().optional().describe("id from start_session"),
        allow_regress: z.boolean().optional().describe("true = allow moving to an earlier status"),
      }),
    },
    safe(async ({ lang, topic_id, status, session_id, allow_regress }) =>
      text(await store.setTopicStatus(lang, topic_id, status, session_id, allow_regress)),
    ),
  );

  server.registerTool(
    "progress",
    {
      description:
        "Coverage (topics taught or assumed) and mastery (every item known, no mistakes in 14 days) per module and per level, plus checkpoint results. The two are never merged into one number.",
      inputSchema: z.object({ lang, level: level.optional() }),
    },
    safe(async ({ lang, level }) => text(await store.progress(lang, level))),
  );

  server.registerTool(
    "record_checkpoint",
    {
      description:
        "Record the result of a module's checkpoint task. A module counts as closed when all its topics are covered, at least 80% mastered, and the latest checkpoint was passed after the last topic was introduced. Returns the module's progress.",
      inputSchema: z.object({
        lang,
        module_id: moduleId,
        passed: z.boolean(),
        session_id: z.string().optional().describe("id from start_session"),
        notes: z.string().max(2000).optional(),
      }),
    },
    safe(async ({ lang, module_id, passed, session_id, notes }) =>
      text(await store.recordCheckpoint(lang, module_id, passed, session_id, notes)),
    ),
  );

  server.registerTool(
    "get_profile",
    {
      description: "The learner's profile: ui_lang (the language to explain things in; syllabus texts are English and you translate them), known_langs, variety (e.g. es-ES) and packs of vocabulary.",
      inputSchema: z.object({}),
    },
    safe(async () => text(await store.getProfile())),
  );

  server.registerTool(
    "set_profile",
    {
      description: "Change profile fields. Only the fields you pass are changed; lists are replaced as a whole.",
      inputSchema: z.object({
        ui_lang: langCode.optional(),
        known_langs: z.array(langCode).max(10).optional(),
        variety: z.string().max(20).nullable().optional(),
        packs: z.array(slug).max(20).optional(),
      }),
    },
    safe(async (patch) => text(await store.setProfile(patch))),
  );

  return server;
}
