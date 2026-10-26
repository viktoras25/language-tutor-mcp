import { createMcpHandler } from "agents/mcp/server";
import { loadConfig, type ConfigEnv } from "./config";
import { D1Store } from "./d1-store";
import { createServer } from "./tools";

interface Env extends ConfigEnv {
  DB: D1Database;
  MCP_SECRET: string;
}

// Constant-time comparison to avoid leaking the secret through timing.
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ (y[i % y.length] ?? 0);
  return diff === 0;
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.MCP_SECRET) return unauthorized();
    const url = new URL(request.url);

    // Accept either /mcp/<SECRET> or `Authorization: Bearer <SECRET>` on /mcp.
    let provided: string | null = null;
    if (url.pathname.startsWith("/mcp/")) {
      provided = decodeURIComponent(url.pathname.slice("/mcp/".length));
      url.pathname = "/mcp";
    } else if (url.pathname === "/mcp") {
      const header = request.headers.get("Authorization") ?? "";
      if (header.startsWith("Bearer ")) provided = header.slice(7);
    } else {
      return new Response("Not found", { status: 404 });
    }
    if (provided === null || !safeEqual(provided, env.MCP_SECRET)) return unauthorized();

    const inner = new Request(url, request);
    const config = loadConfig(env);
    return createMcpHandler(() => createServer(new D1Store(env.DB, config.timezone, config.errorTypes), config))(inner, env, ctx);
  },
} satisfies ExportedHandler<Env>;
