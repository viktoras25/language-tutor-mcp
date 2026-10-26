// Who is calling? A token (from the URL or the Authorization header) maps to a user id.
// Tokens are random 256-bit strings, so a plain SHA-256 is enough to store them (no salt, no slow hash needed).

export const OWNER_ID = "owner";

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

// Constant-time comparison to avoid leaking the secret through timing.
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ (y[i % y.length] ?? 0);
  return diff === 0;
}

// The token from "/mcp/<token>" or from "Authorization: Bearer <token>" on "/mcp".
// Returns null for any other path, and "" when the path has no token.
export function extractToken(pathname: string, authorization: string | null): string | null {
  if (pathname.startsWith("/mcp/")) {
    try {
      return decodeURIComponent(pathname.slice("/mcp/".length));
    } catch {
      return "";
    }
  }
  if (pathname === "/mcp") {
    const header = authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : "";
  }
  return null;
}

// ownerSecret = the MCP_SECRET worker secret. It signs in as the user "owner", so an existing connector keeps working.
// Returns the user id, or null when the token is unknown.
export async function resolveUser(db: D1Database, ownerSecret: string | undefined, token: string): Promise<string | null> {
  if (token === "") return null;
  if (ownerSecret !== undefined && ownerSecret !== "" && safeEqual(token, ownerSecret)) return OWNER_ID;
  const row = await db
    .prepare("SELECT id FROM users WHERE token_hash = ?1")
    .bind(await hashToken(token))
    .first<{ id: string }>();
  return row === null ? null : row.id;
}
