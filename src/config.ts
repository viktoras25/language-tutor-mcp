import { assertTimeZone } from "./time";

// Deployment-specific settings, read from Worker vars (wrangler.jsonc "vars") with generic defaults.
export interface Config {
  langs: string[]; // language codes the tools accept
  errorTypes: string[]; // allowed values of error_type
  timezone: string; // IANA zone that defines "the same day" for spaced repetition
}

export interface ConfigEnv {
  LANGS?: string;
  ERROR_TYPES?: string;
  TIMEZONE?: string;
}

const DEFAULT_LANGS = "en,es,de,fr,it,pt,nl";
const DEFAULT_ERROR_TYPES = "gender,agreement,conjugation,tense,preposition,word-order,vocab,spelling,article,other";
const TOKEN = /^[A-Za-z][A-Za-z0-9-]*$/;

function parseList(name: string, raw: string | undefined, fallback: string): string[] {
  const list = (raw === undefined || raw.trim() === "" ? fallback : raw)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  for (const value of list) {
    if (!TOKEN.test(value)) throw new Error(`${name}: invalid value "${value}" (letters, digits and "-" only)`);
  }
  return [...new Set(list)];
}

export function loadConfig(env: ConfigEnv): Config {
  const langs = parseList("LANGS", env.LANGS, DEFAULT_LANGS);
  const errorTypes = parseList("ERROR_TYPES", env.ERROR_TYPES, DEFAULT_ERROR_TYPES);
  if (!errorTypes.includes("other")) errorTypes.push("other");

  const timezone = env.TIMEZONE === undefined || env.TIMEZONE.trim() === "" ? "UTC" : env.TIMEZONE.trim();
  try {
    assertTimeZone(timezone);
  } catch (e) {
    throw new Error(`TIMEZONE: ${(e as Error).message}`);
  }
  return { langs, errorTypes, timezone };
}
