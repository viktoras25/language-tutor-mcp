// Usage: node scripts/syllabus-import.ts --lang es [--seed example [--user owner]] [--build build] [--out syllabus-import.sql]
//
// Reads build/<lang>.json (made by `npm run syllabus:validate`) and optionally build/seed-<lang>-<seed>.json,
// and writes one SQL file. It does not touch any database. Apply the file yourself:
//   npx wrangler d1 execute DB --local  --file syllabus-import.sql
//   npx wrangler d1 execute DB --remote --file syllabus-import.sql     (back up production first)
// Running the file again changes nothing. The seed part never overwrites progress that already exists.
// --user = the user the seed belongs to (default "owner"). The plan part gives every existing user their topic items.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSeedImport,
  buildSyllabusImport,
  renderSql,
  type CompiledSyllabus,
  type LearnerSeed,
  type Statement,
} from "../src/syllabus-import.ts";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

const lang = argValue("lang");
if (lang === undefined) {
  console.error("Usage: node scripts/syllabus-import.ts --lang es [--seed example [--user owner]] [--build build] [--out file.sql]");
  process.exit(1);
}
const buildDir = argValue("build") ?? "build";
const outFile = argValue("out") ?? "syllabus-import.sql";
const seedName = argValue("seed");
const userId = argValue("user") ?? "owner";

const planText = readFileSync(join(buildDir, `${lang}.json`), "utf8");
const plan = JSON.parse(planText) as CompiledSyllabus;
const hash = createHash("sha256").update(planText).digest("hex");
const now = new Date().toISOString();

const statements: Statement[] = buildSyllabusImport(plan, hash, now);
console.log(`plan ${lang}: ${plan.topics.length} topics, ${plan.modules.length} modules, hash ${hash.slice(0, 12)}`);

if (seedName !== undefined) {
  const seed = JSON.parse(readFileSync(join(buildDir, `seed-${lang}-${seedName}.json`), "utf8")) as LearnerSeed;
  for (const s of buildSeedImport(seed, now, userId)) statements.push(s);
  console.log(`seed ${seedName} -> user ${userId}: ${Object.keys(seed.topics).length} topic statuses, ${Object.keys(seed.part_of).length} part_of links`);
  const notes = seed.discrepancies ?? [];
  if (notes.length > 0) {
    console.log("\nDiscrepancies between sources (not resolved automatically, please review):");
    for (const n of notes) console.log(`  - ${n}`);
  }
}

writeFileSync(outFile, renderSql(statements), "utf8");
console.log(`\nwrote ${statements.length} statements to ${outFile}`);
