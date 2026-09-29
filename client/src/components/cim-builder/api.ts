/**
 * CIM builder — data types and fetch helpers for GET /api/deals/:id/cim-builder
 * and the section endpoints (server/routes/cim-builder.ts).
 */
import type { CimGenerationStatus, CimSection, CimSectionAiTask } from "@shared/schema";

/** "held" = the last redaction failed; blind buyers don't get the section until one succeeds. */
export type BlindStatus = "fresh" | "updating" | "held" | "none" | "excluded";

/** A section row as the builder receives it. */
export interface BuilderSection extends Omit<CimSection, "aiTask" | "contentHistory" | "accessTier" | "figureWarnings"> {
  accessTier: "teaser" | "full";
  aiTask: CimSectionAiTask | null;
  historyCount: number;
  lastChange: { reason: string; at: string } | null;
  blindStatus: BlindStatus;
  blindError?: string | null;
  /** DD version: "stale" = edited since it was written; "missing" = added after the DD CIM. DD buyers see the named content for both. */
  ddStatus: DdStatus;
  /** Figures or names the check couldn't trace to the deal's information. */
  figureWarnings: string[];
  /** The AI couldn't write this section: a hidden placeholder, never shown to buyers. */
  placeholder?: boolean;
  /** Facts changed since the CIM was written whose old value this section still shows. */
  factsChanged?: string[];
  /** Private staff matters now held back from the CIM that this section still states (regenerate or edit it). */
  privateStaff?: string[];
}

/** One full DD run (POST generate-dd), kept in server memory until the next. */
export interface DdRunSummary {
  /** Matches the startedAt the generate-dd response returned for this run. */
  startedAt?: string;
  finishedAt: string;
  error?: string;
  written: number;
  notWritten: number;
  warnings: string[];
}

/** What the broker must look at before publishing (GET …/cim-builder `review`). */
export interface CimReview {
  /** Set while a regenerated CIM is held from buyers until it is published again. */
  heldFromBuyers: CimGenerationStatus["buyerHold"] | null;
  /** The last finished generation's notes (placeholders, figures, things taken out, rebuilt sections). */
  warnings: string[];
  warningsAt: string | null;
  placeholders: number;
  /** Sections still stating a private staff matter that is now held back. */
  privateStaffSections?: number;
  /** Facts changed since the CIM was written (null = none). */
  facts: {
    changes: Array<{ label: string; before: string | null; after: string | null }>;
    more: number;
    sections: number;
    notesChanged: boolean;
  } | null;
}

export type DdStatus = "none" | "fresh" | "stale" | "missing" | "excluded";

export interface BuilderState {
  sections: BuilderSection[];
  /**
   * `updating`: sections waiting for their redaction. `held`: sections whose
   * redaction failed — blind buyers don't get them until one succeeds (their
   * reason is in `error`, and on the row's `blindError`).
   */
  blind: { generated: boolean; codename: string | null; codenameProblem?: string | null; running: boolean; error: string | null; updating: number; held: number };
  /** outOfDate: sections whose DD version is stale or missing; running: a refresh is under way. */
  dd: {
    generated: boolean;
    outOfDate: number;
    running: boolean;
    /** The last full DD run (server memory): why nothing changed, or what couldn't be written. */
    lastRun?: DdRunSummary | null;
  };
  buyers: { total: number; byLevel: Record<string, number> };
  /** listedAskingPrice: the price buyers see now (null = none listed); the previews apply it like the view room. */
  deal: { isLive: boolean; cimLayoutGeneratedAt: string | null; listedAskingPrice?: string | null };
  review?: CimReview;
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
