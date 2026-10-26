// Usage: node scripts/user-add.ts <user-id> [--rotate | --revoke] [--out user-add.sql]
//
// Makes a token for a user and writes the SQL that stores its hash. It does not touch any database.
// Apply the file yourself, then send the user the connector URL:
//   npx wrangler d1 execute DB --remote --file user-add.sql
//   https://<your-worker>/mcp/<token>
// The token is shown once and is not stored anywhere (only its SHA-256 is). To get a new one, run with --rotate.
// --revoke cuts access off and keeps the data. The owner ("owner") signs in with MCP_SECRET and has no token here.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { hashToken } from "../src/auth.ts";
import { renderSql, type Statement } from "../src/syllabus-import.ts";
import { buildAddUser, buildRevoke, buildRotateToken } from "../src/users.ts";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

const userId = process.argv[2];
if (userId === undefined || userId.startsWith("--")) {
  console.error("Usage: node scripts/user-add.ts <user-id> [--rotate | --revoke] [--out user-add.sql]");
  process.exit(1);
}
if (userId === "owner") {
  console.error('"owner" signs in with the MCP_SECRET worker secret, it has no token here.');
  process.exit(1);
}
const outFile = argValue("out") ?? "user-add.sql";
const revoke = process.argv.includes("--revoke");
const rotate = process.argv.includes("--rotate");

let statements: Statement[];
if (revoke) {
  statements = buildRevoke(userId);
  console.log(`access of "${userId}" will be revoked`);
} else {
  const token = randomBytes(32).toString("hex");
  const tokenHash = await hashToken(token);
  statements = rotate ? buildRotateToken(userId, tokenHash) : buildAddUser(userId, tokenHash, new Date().toISOString());
  console.log(`user:  ${userId}`);
  console.log(`token: ${token}`);
  console.log(`url:   https://<your-worker>/mcp/${token}`);
}

writeFileSync(outFile, renderSql(statements), "utf8");
console.log(`\nwrote ${statements.length} statements to ${outFile}`);
console.log(`apply with: npx wrangler d1 execute DB --remote --file ${outFile}`);
