// Usage: node scripts/syllabus-validate.ts [--root syllabus] [--seed learner-seed] [--out build]
//
// Validates the syllabus and compiles it to one JSON per target language.
// Checks:
//   1. every YAML file against syllabus/schema.json ($defs/<kind>File)
//   2. unique ids (modules, can_do, topics per language, errors, lexicon)
//   3. references: topic.module, topic.requires, topic.error_tags, lexicon.module,
//      learner-seed topics and part_of targets
//   4. the requires graph has no cycles
//   5. warnings (do not fail the run): a topic requires a topic from a later module; a module has no topics
// Exit code 1 on any error. With --out it also writes build/<lang>.json and build/seed-<lang>-<learner>.json.
import Ajv2020 from "ajv/dist/2020.js";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

interface Doc {
  kind?: string;
  [key: string]: any;
}

const errors: string[] = [];
const warnings: string[] = [];

function err(message: string): void {
  errors.push(message);
}

function warn(message: string): void {
  warnings.push(message);
}

function argValue(name: string, fallback: string | undefined): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

// All files with the given extension under a folder, sorted by path.
function listFiles(dir: string, extension: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      for (const inner of listFiles(path, extension)) found.push(inner);
    } else if (name.endsWith(extension)) {
      found.push(path);
    }
  }
  return found.sort();
}

function loadYaml(path: string): Doc {
  return parse(readFileSync(path, "utf8")) as Doc;
}

function hasDuplicates(values: number[]): boolean {
  return new Set(values).size !== values.length;
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

const root = argValue("root", "syllabus") as string;
const seedDir = argValue("seed", "learner-seed") as string;
const outDir = argValue("out", undefined);

const schema = JSON.parse(readFileSync(join(root, "schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });

// ---- load and check every file against its schema
const files = new Map<string, { path: string; doc: Doc }[]>();
for (const path of listFiles(root, ".yaml")) {
  const doc = loadYaml(path);
  const kind = doc !== null && typeof doc === "object" ? doc.kind : undefined;
  if (kind === undefined) {
    err(`${path}: missing top-level 'kind'`);
    continue;
  }
  const definition = `${kind}File`;
  if (schema["$defs"][definition] === undefined) {
    err(`${path}: unknown kind '${kind}'`);
    continue;
  }
  const check = ajv.compile({ $ref: `#/$defs/${definition}`, $defs: schema["$defs"] });
  if (!check(doc)) {
    for (const e of check.errors ?? []) err(`${path}: schema: ${e.instancePath} ${e.message}`);
  }
  const list = files.get(kind) ?? [];
  list.push({ path, doc });
  files.set(kind, list);
}
function filesOf(kind: string): { path: string; doc: Doc }[] {
  return files.get(kind) ?? [];
}

// ---- modules
const modules = new Map<string, Doc>();
const canDoIds = new Set<string>();
for (const { path, doc } of filesOf("modules")) {
  for (const m of doc.modules) {
    if (modules.has(m.id)) err(`${path}: duplicate module id ${m.id}`);
    modules.set(m.id, m);
    if (!m.id.startsWith(`${m.level}.`)) err(`${path}: module ${m.id} level mismatch (${m.level})`);
    for (const cd of m.can_do ?? []) {
      if (canDoIds.has(cd.id)) err(`${path}: duplicate can_do id ${cd.id}`);
      canDoIds.add(cd.id);
    }
  }
}
const orders: number[] = [];
for (const m of modules.values()) orders.push(m.order);
if (hasDuplicates(orders)) err("modules: duplicate 'order' values");

// ---- error categories
const errorIds = new Map<string, Set<string>>();
for (const { path, doc } of filesOf("errors")) {
  const ids = errorIds.get(doc.scope) ?? new Set<string>();
  errorIds.set(doc.scope, ids);
  for (const c of doc.categories) {
    if (ids.has(c.id)) err(`${path}: duplicate error id ${c.id}`);
    ids.add(c.id);
  }
}
const coreErrors = errorIds.get("core") ?? new Set<string>();
for (const [scope, ids] of errorIds) {
  if (scope === "core") continue;
  const clash: string[] = [];
  for (const id of ids) {
    if (coreErrors.has(id)) clash.push(id);
  }
  if (clash.length > 0) err(`errors/${scope}: redefines core ids ${JSON.stringify(clash.sort())}`);
}

// ---- topics per language
const topicsByLang = new Map<string, Map<string, Doc>>();
for (const { path, doc } of filesOf("topics")) {
  const bucket = topicsByLang.get(doc.lang) ?? new Map<string, Doc>();
  topicsByLang.set(doc.lang, bucket);
  for (const t of doc.topics) {
    if (bucket.has(t.id)) err(`${path}: duplicate topic id ${t.id}`);
    bucket.set(t.id, { ...t, _file: path });
  }
}

for (const [lang, topics] of topicsByLang) {
  const allowedErrors = new Set<string>([...coreErrors, ...(errorIds.get(lang) ?? [])]);
  for (const t of topics.values()) {
    const where = `${t._file}: ${t.id}`;
    if (!modules.has(t.module)) err(`${where}: unknown module ${t.module}`);
    for (const r of t.requires) {
      if (!topics.has(r)) err(`${where}: requires unknown topic ${r}`);
      else if (r === t.id) err(`${where}: requires itself`);
    }
    for (const tag of t.error_tags) {
      if (!allowedErrors.has(tag)) err(`${where}: unknown error tag ${tag}`);
    }
    if (t.replaced_by && !topics.has(t.replaced_by)) err(`${where}: replaced_by unknown topic`);
  }

  // cycle detection (depth-first). 1 = on the current path, 2 = finished.
  const state = new Map<string, number>();
  const visit = (node: string, stack: string[]): void => {
    state.set(node, 1);
    for (const r of (topics.get(node) as Doc).requires) {
      if (!topics.has(r)) continue;
      if (state.get(r) === 1) err(`${lang}: requires cycle: ${[...stack, node, r].join(" -> ")}`);
      else if (state.get(r) === undefined) visit(r, [...stack, node]);
    }
    state.set(node, 2);
  };
  for (const id of topics.keys()) {
    if (!state.has(id)) visit(id, []);
  }

  // forward dependencies are allowed (the graph decides the order) but worth seeing
  for (const t of topics.values()) {
    const myOrder = modules.get(t.module)?.order;
    for (const r of t.requires) {
      const required = topics.get(r);
      const theirOrder = required === undefined ? undefined : modules.get(required.module)?.order;
      if (myOrder !== undefined && theirOrder !== undefined && theirOrder > myOrder) {
        warn(`${lang}: ${t.id} (${t.module}) requires ${r} (${required?.module}) from a later module`);
      }
    }
  }

  const used = new Set<string>();
  for (const t of topics.values()) used.add(t.module);
  for (const id of modules.keys()) {
    if (!used.has(id)) warn(`${lang}: module ${id} has no topics`);
  }
}

// ---- lexicon
for (const { path, doc } of filesOf("lexicon")) {
  const seen = new Set<string>();
  for (const e of doc.entries) {
    if (seen.has(e.id)) err(`${path}: duplicate lexicon id ${e.id}`);
    seen.add(e.id);
    if (!modules.has(e.module)) err(`${path}: ${e.id}: unknown module ${e.module}`);
  }
}

// ---- learner seeds
const seeds: Doc[] = [];
try {
  if (statSync(seedDir).isDirectory()) {
    for (const path of listFiles(seedDir, ".yaml")) {
      const doc = loadYaml(path);
      seeds.push(doc);
      const topics = topicsByLang.get(doc.lang) ?? new Map<string, Doc>();
      for (const id of Object.keys(doc.topics ?? {})) {
        if (!topics.has(id)) err(`${path}: unknown topic ${id}`);
      }
      const partOf = doc.part_of ?? {};
      for (const item of Object.keys(partOf)) {
        if (!topics.has(partOf[item])) err(`${path}: part_of ${item} -> unknown topic ${partOf[item]}`);
      }
    }
  }
} catch {
  // no seed folder: nothing to check
}

// ---- report
for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
for (const [lang, topics] of [...topicsByLang].sort()) {
  const perLevel = new Map<string, number>();
  const kinds = new Map<string, number>();
  for (const t of topics.values()) {
    const level = modules.get(t.module)?.level ?? "?";
    perLevel.set(level, (perLevel.get(level) ?? 0) + 1);
    const kind = String(t.kind);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  console.log(`${lang}: ${topics.size} topics ${JSON.stringify(Object.fromEntries(perLevel))} ${JSON.stringify(Object.fromEntries(kinds))}`);
}
const extensions: string[] = [];
for (const [scope, ids] of errorIds) {
  if (scope !== "core") extensions.push(`${scope} ${ids.size}`);
}
console.log(`modules: ${modules.size}, can_do: ${canDoIds.size}, errors: core ${coreErrors.size} + ${extensions.join(", ")}`);

if (errors.length > 0) {
  console.log(`FAILED: ${errors.length} error(s)`);
  process.exit(1);
}

// ---- compile
if (outDir !== undefined) {
  mkdirSync(outDir, { recursive: true });
  const sortedModules = [...modules.values()].sort((a, b) => a.order - b.order);
  for (const [lang, topics] of topicsByLang) {
    const lexicon: Doc[] = [];
    for (const { doc } of filesOf("lexicon")) {
      if (doc.lang === lang) for (const e of doc.entries) lexicon.push(e);
    }
    const topicFiles = filesOf("topics").filter((f) => f.doc.lang === lang);
    const errorFiles = filesOf("errors").filter((f) => f.doc.scope === "core" || f.doc.scope === lang);
    const errorDefs: Doc[] = [];
    for (const { doc } of errorFiles) {
      for (const c of doc.categories) errorDefs.push({ scope: doc.scope, ...c });
    }
    const compiledTopics: Doc[] = [];
    for (const t of topics.values()) {
      const copy: Doc = {};
      for (const key of Object.keys(t)) {
        if (!key.startsWith("_")) copy[key] = t[key];
      }
      compiledTopics.push(copy);
    }
    const compiled = {
      lang,
      variety: topicFiles[0].doc.variety,
      modules: sortedModules,
      topics: compiledTopics,
      errors: sortedUnique([...coreErrors, ...(errorIds.get(lang) ?? [])]),
      lexicon,
      // used by the server import
      versions: {
        modules: Math.max(...filesOf("modules").map((f) => f.doc.version)),
        topics: Math.max(...topicFiles.map((f) => f.doc.version)),
        errors: Math.max(...errorFiles.map((f) => f.doc.version)),
      },
      error_defs: errorDefs,
    };
    writeFileSync(join(outDir, `${lang}.json`), JSON.stringify(compiled, null, 1), "utf8");
    console.log(`wrote ${join(outDir, `${lang}.json`)}`);
  }
  for (const doc of seeds) {
    const name = `seed-${doc.lang}-${doc.learner}.json`;
    writeFileSync(join(outDir, name), JSON.stringify(doc, null, 1), "utf8");
    console.log(`wrote ${join(outDir, name)}`);
  }
}
console.log("OK");
