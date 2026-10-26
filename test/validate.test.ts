import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const temp: string[] = [];

afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "syllabus-"));
  temp.push(dir);
  return dir;
}

function validate(args: string[]): { code: number | null; out: string } {
  const r = spawnSync("node", [join(ROOT, "scripts", "syllabus-validate.ts"), ...args], { cwd: ROOT, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

// A copy of the real syllabus in which one topics file is edited.
function brokenCopy(edit: (text: string) => string): string {
  const dir = tempDir();
  cpSync(join(ROOT, "syllabus"), dir, { recursive: true });
  const file = join(dir, "es", "topics-a1.yaml");
  writeFileSync(file, edit(readFileSync(file, "utf8")));
  return dir;
}

describe("syllabus validation", () => {
  it("accepts the real syllabus, and the committed build/ is up to date", () => {
    const out = tempDir();
    const r = validate(["--out", out]);
    expect(r.code).toBe(0);
    for (const name of readdirSync(out)) {
      expect(readFileSync(join(out, name), "utf8"), `build/${name} is stale: run npm run syllabus:validate`).toBe(
        readFileSync(join(ROOT, "build", name), "utf8"),
      );
    }
  });

  it("rejects a reference to an unknown topic and an unknown error tag", () => {
    const dir = brokenCopy((t) => t.replace("requires: [subject-pronouns]", "requires: [subject-pronouns, no-such-topic]").replace("error_tags: [gender]", "error_tags: [gender, no-such-tag]"));
    const r = validate(["--root", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("requires unknown topic no-such-topic");
    expect(r.out).toContain("unknown error tag no-such-tag");
  });

  it("rejects a cycle in requires", () => {
    // subject-pronouns has no prerequisites; make it require something that depends on it.
    const dir = brokenCopy((t) => t.replace(/(- id: subject-pronouns[\s\S]*?requires: )\[\]/, "$1[ser-present]"));
    const r = validate(["--root", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("requires cycle");
  });

  it("rejects a topic that breaks the schema", () => {
    const dir = brokenCopy((t) => t.replace(/ {4}summary: .*\n/, ""));
    const r = validate(["--root", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("schema");
  });
});
