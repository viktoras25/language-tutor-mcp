// SQL for adding a user or replacing a user's token. Pure, like syllabus-import.ts: the script writes a .sql file
// and the owner applies it with `wrangler d1 execute`.
// Relative imports carry the .ts extension because scripts/user-add.ts runs this file directly with Node.
import { buildProvision, type Statement } from "./syllabus-import.ts";

const USER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

// New user: the row, plus their own copy of the topic items and prerequisite edges
// (empty until a syllabus is imported, the plan import then provisions every user).
export function buildAddUser(userId: string, tokenHash: string, createdAt: string): Statement[] {
  if (!USER_ID_PATTERN.test(userId)) {
    throw new Error(`Invalid user id "${userId}": lowercase letters, digits and "-", starting with a letter, up to 32 characters`);
  }
  return [
    { sql: "INSERT INTO users (id, token_hash, created_at) VALUES (?1, ?2, ?3)", params: [userId, tokenHash, createdAt] },
    ...buildProvision(userId, null),
  ];
}

// Replaces the token of an existing user. The old token stops working at once.
export function buildRotateToken(userId: string, tokenHash: string): Statement[] {
  return [{ sql: "UPDATE users SET token_hash = ?2 WHERE id = ?1", params: [userId, tokenHash] }];
}

// Takes access away but keeps the data.
export function buildRevoke(userId: string): Statement[] {
  return [{ sql: "UPDATE users SET token_hash = NULL WHERE id = ?1", params: [userId] }];
}
