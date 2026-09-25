/**
 * CIM builder — data types and fetch helpers for GET /api/deals/:id/cim-builder
 * and the section endpoints (server/routes/cim-builder.ts).
 */
import type { CimSection, CimSectionAiTask } from "@shared/schema";

/** "held" = the last redaction failed; blind buyers don't get the section until one succeeds. */
export type BlindStatus = "fresh" | "updating" | "held" | "none" | "excluded";

/** A section row as the builder receives it. */
export interface BuilderSection extends Omit<CimSection, "aiTask" | "contentHistory" | "accessTier"> {
  accessTier: "teaser" | "full";
  aiTask: CimSectionAiTask | null;
  historyCount: number;
  lastChange: { reason: string; at: string } | null;
  blindStatus: BlindStatus;
  blindError?: string | null;
}

export interface BuilderState {
  sections: BuilderSection[];
  /**
   * `updating`: sections waiting for their redaction. `held`: sections whose
   * redaction failed — blind buyers don't get them until one succeeds (their
   * reason is in `error`, and on the row's `blindError`).
   */
  blind: { generated: boolean; codename: string | null; running: boolean; error: string | null; updating: number; held: number };
  dd: { generated: boolean };
  buyers: { total: number; byLevel: Record<string, number> };
  deal: { isLive: boolean; cimLayoutGeneratedAt: string | null };
}

export const builderKey = (dealId: string) => ["/api/deals", dealId, "cim-builder"] as const;

export class BuilderApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "BuilderApiError";
  }
}

/** JSON request that throws the server's own error message. */
export async function builderRequest<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON (e.g. a proxy page during a deploy) */
  }
  if (!res.ok) {
    const msg = (data && typeof data.error === "string" && data.error) || (res.status === 401 ? "Your session has ended — sign in again." : "Something went wrong. Please try again.");
    throw new BuilderApiError(msg, res.status);
  }
  return data as T;
}

export function errorText(err: unknown, fallback = "Something went wrong. Please try again."): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** True while the AI is working on the section. */
export function taskRunning(s: Pick<BuilderSection, "aiTask">): boolean {
  return s.aiTask?.status === "running";
}

export const TASK_LABEL: Record<CimSectionAiTask["kind"], string> = {
  write: "Writing",
  regenerate: "Regenerating",
  rewrite: "Rewriting",
  convert: "Converting layout",
};
