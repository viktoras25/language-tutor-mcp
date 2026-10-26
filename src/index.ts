import { createMcpHandler } from "agents/mcp/server";
import { extractToken, resolveUser } from "./auth";
import { loadConfig, type ConfigEnv } from "./config";
import { D1Store } from "./d1-store";
import { createServer } from "./tools";

interface Env extends ConfigEnv {
  DB: D1Database;
  MCP_SECRET?: string; // the owner's token; other users have tokens in the users table (see README)
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Accept either /mcp/<TOKEN> or `Authorization: Bearer <TOKEN>` on /mcp.
    const token = extractToken(url.pathname, request.headers.get("Authorization"));
    if (token === null) return new Response("Not found", { status: 404 });
    const userId = await resolveUser(env.DB, env.MCP_SECRET, token);
    if (userId === null) return unauthorized();
    url.pathname = "/mcp";

    const inner = new Request(url, request);
    const config = loadConfig(env);
    const store = new D1Store(env.DB, userId, config.timezone, config.errorTypes);
    return createMcpHandler(() => createServer(store, config))(inner, env, ctx);
  },
} satisfies ExportedHandler<Env>;
