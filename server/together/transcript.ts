/**
 * The sitting's transcript document (specs/together.md D5, D7, §5.8).
 *
 * Every sitting gets one `documents` row once the seller first says
 * something: source kind `call` (in person) or `video_call` (Cimple call,
 * Zoom, Meet, Teams), visibility `shared`, `sourceMeta.recordType =
 * "together_sitting"`. **Its text holds only the seller's words** — the
 * full two-sided conversation stays in `together_lines` (broker only) — so
 * no reader (the interview's evidence, the DD citations) can quote the
 * broker's words as the owner's. It is hidden from the seller's own
 * documents list and never goes in the data room.
 *
 * Written at pause, at the end, every 5 minutes while live, and at recovery
 * — not after every line.
 */
import fs from "fs";
import path from "path";
import type { Deal, Document, TogetherLine, TogetherSitting } from "@shared/schema";
import { VIA_LABEL, transcriptSourceKind, type SpeakerMap, type TogetherVia } from "@shared/together";
import { lineRole } from "@shared/together-speakers";
import { newDocumentFileName, resolveDocumentPath, uploadsRoot } from "../documents/document-path";
import { storage } from "../storage";
import { togetherStore } from "./store";

export const TOGETHER_RECORD_TYPE = "together_sitting";

/** Is this documents row an "Interview together" transcript? */
export function isTogetherSitting(doc: { sourceMeta?: unknown } | null | undefined): boolean {
  const meta = doc?.sourceMeta as { recordType?: unknown } | null | undefined;
  return !!meta && meta.recordType === TOGETHER_RECORD_TYPE;
}

/**
 * The row's seller-only text (the contract for dd and any other reader):
 * `extracted_text` already holds nothing else. Empty for any other row.
 */
export function sellerLinesText(doc: Pick<Document, "sourceMeta" | "extractedText"> | null | undefined): string {
  if (!doc || !isTogetherSitting(doc)) return "";
  return doc.extractedText ?? "";
}

/** "Interview together — 9 Oct 2026 (In person)" */
export function transcriptDocumentName(via: TogetherVia, startedAt: Date | string): string {
  const d = new Date(startedAt);
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `Interview together — ${date} (${VIA_LABEL[via]})`;
}

function stamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** The seller-attributed lines, as the row's text: "[mm:ss] Tony Moretti: …". Pure. */
export function sellerTranscriptText(
  sitting: Pick<TogetherSitting, "startedAt" | "speakers">,
  lines: Array<Pick<TogetherLine, "speaker" | "text" | "at" | "attestedSellerAt">>,
): string {
  const speakers = (sitting.speakers ?? {}) as SpeakerMap;
  const start = new Date(sitting.startedAt).getTime();
  const out: string[] = [];
  for (const l of lines) {
    if (lineRole(speakers, { speaker: l.speaker, attested: !!l.attestedSellerAt }) !== "seller") continue;
    const name = speakers[l.speaker]?.name || "Seller";
    out.push(`[${stamp(new Date(l.at).getTime() - start)}] ${name}: ${l.text.trim()}`);
  }
  return out.join("\n");
}

/** Does any of these lines count as the seller's? */
export function hasSellerLine(speakers: SpeakerMap, lines: Array<Pick<TogetherLine, "speaker" | "attestedSellerAt">>): boolean {
  return lines.some((l) => lineRole(speakers, { speaker: l.speaker, attested: !!l.attestedSellerAt }) === "seller");
}

function docsDir(): string {
  return path.join(uploadsRoot(), "docs");
}

function participantsText(sitting: Pick<TogetherSitting, "speakers">, brokerName?: string | null): string {
  const speakers = (sitting.speakers ?? {}) as SpeakerMap;
  const seller = Object.values(speakers).find((s) => s.role === "seller" && s.name)?.name;
  return [brokerName ? `${brokerName} (broker)` : "The broker", seller ? `${seller} (seller)` : "the seller"].join(", ");
}

/**
 * The sitting's transcript row — created at its first seller-attributed
 * line, never recreated after the broker deleted it. Returns the row's id,
 * or null when it was deleted.
 */
export async function ensureTranscriptDocument(sitting: TogetherSitting, deal: Pick<Deal, "id">): Promise<string | null> {
  if (sitting.transcriptDocumentId) return sitting.transcriptDocumentId;
  const state = (sitting.captureState ?? {}) as { sourceDeleted?: boolean };
  if (state.sourceDeleted) return null;
  const via = sitting.via as TogetherVia;
  const name = transcriptDocumentName(via, sitting.startedAt);
  const filename = newDocumentFileName("src", ".txt", "interview-together");
  fs.mkdirSync(docsDir(), { recursive: true });
  fs.writeFileSync(path.join(docsDir(), filename), "", "utf-8");
  const broker = await storage.getUser(sitting.brokerId).catch(() => undefined);
  const doc = await storage.createDocument({
    dealId: deal.id,
    uploadedBy: "broker",
    name,
    originalName: name,
    category: "transcripts",
    subcategory: null,
    fileUrl: `/uploads/docs/${filename}`,
    fileSize: 0,
    mimeType: "text/plain",
    isProcessed: true,
    extractedText: "",
    extractedData: {},
    status: "processed",
    sourceKind: transcriptSourceKind(via),
    sourceMeta: {
      date: new Date(sitting.startedAt).toISOString().slice(0, 10),
      platform: via === "person" ? "in_person" : via,
      provider: "cimple",
      recordType: TOGETHER_RECORD_TYPE,
      recordId: sitting.id,
      participants: participantsText(sitting, (broker as { name?: string | null } | undefined)?.name ?? null),
      durationMin: 0,
    },
    visibility: "shared",
  } as Parameters<typeof storage.createDocument>[0]);
  await togetherStore().updateSitting(sitting.id, { transcriptDocumentId: doc.id });
  sitting.transcriptDocumentId = doc.id;
  return doc.id;
}

/** How often a live sitting's text is rewritten. */
export const TRANSCRIPT_WRITE_EVERY_MS = 5 * 60_000;

/** Rewrites the row's file and text from the sitting's lines (seller-attributed only). */
export async function writeTranscriptText(sitting: TogetherSitting): Promise<void> {
  if (!sitting.transcriptDocumentId) return;
  const doc = await storage.getDocument(sitting.transcriptDocumentId);
  if (!doc) return;
  const lines = await togetherStore().allLines(sitting.id);
  const text = sellerTranscriptText(sitting, lines);
  const abs = resolveDocumentPath(doc);
  if (abs) {
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text, "utf-8");
    } catch (err) {
      console.warn(`[together] couldn't write the transcript file for sitting ${sitting.id}:`, (err as Error).message);
    }
  }
  const last = lines[lines.length - 1];
  const durationMin = last ? Math.max(0, Math.round((new Date(last.at).getTime() - new Date(sitting.startedAt).getTime()) / 60_000)) : 0;
  const broker = await storage.getUser(sitting.brokerId).catch(() => undefined);
  const meta = { ...((doc.sourceMeta ?? {}) as Record<string, unknown>), durationMin, participants: participantsText(sitting, (broker as { name?: string | null } | undefined)?.name ?? null) };
  await storage.updateDocument(doc.id, { extractedText: text, fileSize: Buffer.byteLength(text, "utf-8"), sourceMeta: meta } as never);
  const row = await togetherStore().mergeCaptureState(sitting.id, { transcriptWrittenAt: new Date().toISOString() });
  if (row) sitting.captureState = row.captureState;
}

/**
 * The broker deleted a session's transcript (the source delete already
 * removed the facts it filed): the session stops filing for good, its
 * parts' deltas and results are cleared and its lines are deleted (the
 * sitting keeps only its counts). The row is never recreated (§5.8).
 */
export async function onTogetherSourceDeleted(doc: Pick<Document, "id" | "sourceMeta">): Promise<void> {
  if (!isTogetherSitting(doc)) return;
  const sittingId = String(((doc.sourceMeta ?? {}) as { recordId?: unknown }).recordId ?? "");
  if (!sittingId) return;
  const store = togetherStore();
  const s = await store.getSitting(sittingId);
  if (!s || s.transcriptDocumentId !== doc.id) return;
  const { stopFiling } = await import("./pipeline");
  stopFiling(s.id);
  const lines = await store.countLines(s.id);
  await store.clearChunkData(s.id);
  await store.deleteLines(s.id);
  const row = await store.mergeCaptureState(s.id, { sourceDeleted: true, held: [], brokerUnconfirmed: [], linesBeforeDelete: lines });
  const hub = await import("./hub");
  if (row) {
    const { sittingView } = await import("./sittings");
    hub.publish(s.id, { type: "sitting", sitting: sittingView(row) });
  }
}
