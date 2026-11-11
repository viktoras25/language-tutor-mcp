import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INSTRUCTIONS, USAGE_GUIDE } from "../src/guide";

// The guide ships with the server so it cannot drift from the tools; this keeps that true.
const source = readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8");
const registered = new Set([...source.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]));

describe("usage guide", () => {
  it("names only tools that exist", () => {
    const mentioned = new Set(USAGE_GUIDE.match(/\b[a-z]+(?:_[a-z]+)+\b/g));
    const fields = ["next_step", "error_type", "item_id", "topic_id", "session_id", "ui_lang", "known_langs", "format_prefs", "attempts_limit", "include_pending", "delivered_at", "grammar_point"];
    const unknown = [...mentioned].filter((name) => !registered.has(name) && !fields.includes(name));
    expect(unknown).toEqual([]);
  });

  it("is reachable from the server instructions", () => {
    expect(registered.has("usage_guide")).toBe(true);
    expect(INSTRUCTIONS).toContain("usage_guide");
  });
});
