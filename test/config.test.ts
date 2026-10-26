import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("has generic defaults", () => {
    const c = loadConfig({});
    expect(c.timezone).toBe("UTC");
    expect(c.langs).toContain("en");
    expect(c.errorTypes).toContain("other");
  });

  it("parses lists, trims, de-duplicates and always allows 'other'", () => {
    const c = loadConfig({ LANGS: " fr, it ,fr", ERROR_TYPES: "tone, vocab", TIMEZONE: "Asia/Tokyo" });
    expect(c).toEqual({ langs: ["fr", "it"], errorTypes: ["tone", "vocab", "other"], timezone: "Asia/Tokyo" });
  });

  it("treats empty values as unset", () => {
    expect(loadConfig({ LANGS: "", TIMEZONE: " " })).toMatchObject({ timezone: "UTC" });
  });

  it("rejects bad values with a clear message", () => {
    expect(() => loadConfig({ TIMEZONE: "Mars/Olympus" })).toThrow(/not a valid IANA time zone/);
    expect(() => loadConfig({ LANGS: "en,e:s" })).toThrow(/LANGS: invalid value "e:s"/);
  });
});
