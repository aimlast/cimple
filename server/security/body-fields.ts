/**
 * Field allowlists for broker create/update bodies.
 *
 * Several routes used to hand req.body straight to an insert schema (or to
 * storage), so a broker could set columns only the server may write:
 *   - documents.fileUrl / mimeType → the re-read read any file on the server
 *     (/proc/self/environ) into the document's text;
 *   - documents.dealId / tasks.dealId → a row moved into another brokerage's
 *     deal (its facts then merged into their CIM);
 *   - integrations.brokerId → the broker's own Pipedrive planted on another
 *     broker, so that broker's buyer sync and CRM updates ran against it.
 *
 * pickBodyFields keeps only the allowed keys and refuses (400) a body that
 * names a server-owned key, so a stale or hostile client learns it can't —
 * other unknown keys are dropped quietly.
 */

export type BodyPick =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; field: string; error: string };

export function pickBodyFields(
  body: unknown,
  allowed: readonly string[],
  serverOwned: readonly string[],
): BodyPick {
  const src = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  for (const key of serverOwned) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      return { ok: false, field: key, error: `"${key}" can't be set here` };
    }
  }
  const data: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(src, key) && src[key] !== undefined) data[key] = src[key];
  }
  return { ok: true, data };
}

/** Columns of a documents row only the upload / ingest code writes. */
export const DOCUMENT_SERVER_OWNED = [
  "id", "dealId", "uploadedBy", "fileUrl", "fileSize", "mimeType",
  "isProcessed", "extractedText", "extractedData", "status",
  "sourceKind", "sourceMeta", "visibility", "createdAt", "updatedAt",
] as const;
/** A broker may create a document placeholder (no file) with these… */
export const DOCUMENT_CREATE_FIELDS = ["name", "originalName", "category", "subcategory", "isRequired", "promisedAt"] as const;
/** …and rename / re-file a document with these. */
export const DOCUMENT_PATCH_FIELDS = ["name", "category", "subcategory", "isRequired", "promisedAt"] as const;

export const TASK_SERVER_OWNED = ["id", "dealId", "createdBy", "createdAt", "updatedAt"] as const;
export const TASK_PATCH_FIELDS = [
  "title", "description", "status", "priority", "dueAt", "completedAt",
  "assignedTo", "brokerAuthorized", "brokerAuthAt", "brokerNotes",
] as const;

export const INTEGRATION_SERVER_OWNED = [
  "id", "brokerId", "provider", "accessToken", "refreshToken", "tokenExpiresAt",
  "connectedAt", "createdAt", "updatedAt",
] as const;
export const INTEGRATION_PATCH_FIELDS = ["config", "status"] as const;
/** Creating a row: the provider is named, tokens only ever come from a connect flow. */
export const INTEGRATION_CREATE_FIELDS = ["provider", "config", "status"] as const;
export const INTEGRATION_CREATE_SERVER_OWNED = INTEGRATION_SERVER_OWNED.filter((k) => k !== "provider");

export const INTEGRATION_STATUSES = ["connected", "disconnected", "error"] as const;
