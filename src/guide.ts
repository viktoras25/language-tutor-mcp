// How a tutor uses this server. Served to clients as the server instructions (short form)
// and by the usage_guide tool (full text), so the guide always matches the tools it ships with.

export const INSTRUCTIONS =
  "Long-term memory for a language tutor: items, graded attempts, lessons (sessions), a spaced-repetition schedule, " +
  "course state and an optional syllabus. The server stores and schedules; the tutor decides what to teach and whether " +
  "something was learned. Before the first read or write in a conversation, call usage_guide and follow it.";

export const USAGE_GUIDE = `# Using the language memory server as a tutor

This server is the source of truth for items, attempts, spaced repetition, sessions, preferences and (when one is imported) the syllabus position. It does not decide whether the learner has absorbed something; that is the tutor's job. It never invents anything; neither should you.

<lang> is the course language code (for example es, de).

## How the tutor's needs map to tools

| Need | Tool |
|---|---|
| Profile | get_profile, set_profile |
| Course state (lasting preferences, level) | get_course_state, set_course_state |
| Recent lessons | list_sessions, get_session |
| Review queue | due_items |
| Weak items | weak_items |
| History of one step or topic | get_context with a raised attempts_limit |
| Topic proposals and detail (syllabus only) | next_topics, get_topic, get_syllabus |
| Record a graded turn, close a lesson | save_session |
| Topic status | set_topic_status |
| Delivered, not yet answered | save_session with status="pending" |

## Before the lesson

1. get_profile: ui_lang (the language to explain in), known_langs, variety, vocabulary packs.
2. get_course_state(<lang>): learner preferences (format_prefs). Follow them.
3. list_sessions(<lang>, 3): recent graded lessons with summary, score and next_step. The newest next_step is the plan for this lesson. A lesson without score and next_step was not finished; its summary and attempts (get_session) show how far it got.
4. due_items(<lang>, 15, date=<learner's local date>): what to review. Pass date explicitly; the default is UTC and can be a day off.
5. weak_items(<lang>), then get_context(item_id, attempts_limit=10) on the most frequent errors: earlier answers show what not to reuse, and their timestamps and credit show how a step is going.
6. next_topics(<lang>): continue (topics after the current one) and fill (earlier gaps). The server proposes; you choose. A topic is offered as soon as the previous one has been started, so a proposal does not mean the learner is ready for it.
7. get_topic(<lang>, topic_id): the lesson card. Its texts are in English; explain in ui_lang.

A syllabus exists only for languages that have one imported. If next_topics or get_topic report none, plan the course yourself.

Nothing is opened before a lesson starts: the session is created by the first save_session call.

## Recording

Call save_session once per graded turn (when you grade the learner's answers), not once per answer.

- First call: no id; pass lang, title="Lesson N: <topic>", plan="<brief>" (and kind="placement" for a placement test). It returns the session id; pass it in every later call of the lesson.
- One call carries everything new in that turn: items, then links, then attempts, in that order, so an attempt can refer to an item created in the same call.
- If it fails, the error says what was saved. Fix the one problem and call again with the same id.

What goes in it:

- New words and forms (items): call find_items first if you are unsure whether the item exists. Type is lemma, form, grammar_point or collocation. For words, data has display, gender, translation, example, pos. The id is <lang>:<type>:<lowercased label> and is returned by the call. Relations go in links (src, dst, type).
- Every graded exercise (attempts): {item_id, credit, error_type, context}.
  - credit is 1, 0.5 or 0 (any value from 0 to 1 is accepted). It drives the spacing: a partial answer keeps the item's interval instead of sending it back to day one.
  - Give error_type for every attempt with credit below 1, naming the real error. Do not hard-code the list of error types: if a value is rejected, the error returns the allowed ones.
  - A slip you chose to ignore is credit=1 and needs no error type.
  - context = the exercise, the learner's answer and the correct form, for example "partial 0.5: answered 'pague', correct 'pagué' (accent changes the tense)".
  - Do not pass ts, except when recording a past lesson. Do not store intervals or statuses in data.
- Topic status (set_topic_status) is a required step:
  - current when a topic starts being taught.
  - introduced only when its first step has been taught and answered.
  - assumed only with the session_id of a session saved with kind="placement".
- Checkpoints: when progress shows a module at full coverage, give its checkpoint and store the result with record_checkpoint.

## Closing a lesson

1. All attempts and new items saved with save_session; topic statuses updated.
2. A last save_session(id, summary, score, next_step); it may also carry the last attempts. This is what marks the lesson as finished.
   - summary: what was covered, errors by kind, which errors are new and which are repeats.
   - next_step: the plan for the next lesson, with everything the tutor needs to resume: the state of unfinished steps and its own counters.
3. Only if the learner's preferences changed: set_course_state(<lang>, data).

## One place per kind of fact

- Plan for the next lesson and the state of unfinished steps: next_step of the last session. Not in course state.
- History of lessons: the sessions themselves. Do not keep a list of lessons in course state.
- Course state: only lasting learner preferences (format_prefs) and, if useful, the level. Send the whole object, flat; it replaces what is stored and must not be wrapped in {lang, data}.

## Delivered but not answered (unattended runs)

When there is no learner to answer now, save the delivered lesson as pending so it does not show up as an empty lesson.

- Delivering: save_session(lang, title, plan, status="pending"). Keep the exercises and the answer key in the delivered text; the server does not store them.
- Before building a new lesson: list_sessions(<lang>, 3, include_pending=true). If a pending session is 3 days old or less (delivered_at), the learner has not answered it yet: do not create another lesson. Send at most one short reminder, and only on the first day.
- Older pending lesson: build a fresh lesson and save it as pending. The server marks the old one abandoned.
- When the learner answers a pending lesson: grade it and call save_session(id=<the pending id>, attempts=[...]). Saving attempts makes it a normal graded lesson, even if it had been abandoned. Do not create a second session for the same lesson.

## Special cases

- Lesson taught while the server was unavailable: record it afterwards with one save_session carrying the items, the attempts (each with the ts of when it was answered), summary, score and next_step, and a plan saying it was recorded late.
- A grade changed after recording: save_session(id, score=<new>) and add the correction to summary. Saved attempts cannot be edited; the summary explains the difference.

## Never

- Delete items, attempts or sessions.
- Invent ids, due dates, streaks or statuses.
- Mark a topic introduced or assumed without evidence.
- Read mastered or known as "ready to move on". They need repeated correct answers on separate days across every item of a topic, so they stay at zero for weeks. Whether to move on is the tutor's decision.
`;
