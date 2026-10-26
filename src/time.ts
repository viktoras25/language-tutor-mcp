// Calendar day (YYYY-MM-DD) of an instant in the given IANA time zone. "Same day" in SRS rules means this.
export function localDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}

export function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86400000).toISOString();
}

// Accepts any ISO 8601 string Date can parse; returns canonical UTC ISO. Throws on garbage.
export function normalizeTs(input: string): string {
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) throw new Error(`Invalid ts "${input}": expected ISO 8601, e.g. 2026-10-15T12:00:00Z`);
  return new Date(ms).toISOString();
}
