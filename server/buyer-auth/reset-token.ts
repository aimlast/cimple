/**
 * Buyer set-password / reset tokens are stored hashed. The plaintext only
 * ever exists in the email link, so a buyer_users row that leaks (a response,
 * a log, a backup) can't be turned into a password reset.
 *
 * Rows written before hashing hold the plaintext; those still work until they
 * expire (7 days). A value carrying the hash prefix is never accepted as a
 * token, so a leaked stored hash can't be replayed either.
 */
import crypto from "crypto";

const PREFIX = "sha256:";

export function hashResetToken(token: string): string {
  return PREFIX + crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** The stored values a presented token may match: its hash, or (legacy) itself. Empty = reject. */
export function resetTokenLookupValues(presented: string): string[] {
  if (!presented || presented.startsWith(PREFIX) || presented.length > 256) return [];
  return [hashResetToken(presented), presented];
}
