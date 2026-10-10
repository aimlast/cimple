/**
 * One uploaded file → one deal document (vdr spec §9.2 "upload"): the body
 * of `POST /api/deals/:dealId/documents/upload`, extracted unchanged so the
 * Data room's own upload (server/routes/data-room.ts) creates documents
 * exactly the same way — checklist credit, the seller's replacement of their
 * own upload, the interview's document requests, then the read for the CIM's
 * facts.
 *
 * The caller has already checked who may upload (and must do so BEFORE the
 * file is written: INTEGRATION §9 follow-up 5). Every refusal here removes
 * the file it was given.
 */
import fs from "fs";
import { storage } from "../storage";
import type { DocumentSourceMeta } from "@shared/schema";

/** Multer/busboy decodes multipart filenames as latin1, so UTF-8 names arrive mojibake'd ("—" → "â"). */
export function decodeUploadName(raw: string): string {
  try {
    const decoded = Buffer.from(raw, "latin1").toString("utf8");
    return decoded.includes("�") ? raw : decoded;
  } catch {
    return raw;
  }
}

export type UploadedFile = { path: string; filename: string; originalname: string; size?: number; mimetype?: string };

export type UploadBody = {
  subcategory?: unknown;
  title?: unknown;
  requirementId?: unknown;
  taskId?: unknown;
  category?: unknown;
  sourceKind?: unknown;
  sourceMeta?: unknown;
  visibility?: unknown;
};

export type UploadOutcome =
  | { ok: true; doc: any; linkedRequirement: any; satisfiedTask: { id: string; title: string } | null }
  | { ok: false; status: number; error: string };

/** Fire-and-forget: the row's status flips pending → parsing → extracted/failed (server/documents/ingest.ts). */
export function parseDocumentAsync(docId: string): void {
  import("./ingest")
    .then(({ ingestDocument }) => ingestDocument(docId))
    .catch((err) => console.error(`[parser] failed for doc ${docId}:`, err));
}

export async function createUploadedDocument(i: {
  dealId: string;
  file: UploadedFile;
  uploadedBy: "broker" | "seller";
  body: UploadBody;
  /** Data room: "Just store them in the data room" — not read for the CIM's facts until asked. */
  readSkipped?: boolean;
  /** Runs after the row exists and before the read starts (the data room places the document first). */
  beforeParse?: (doc: any) => Promise<void>;
  /** A seller upload's link token (gl: only the owner's or the accountant's link uploads the general ledger). */
  sellerToken?: string;
}): Promise<UploadOutcome> {
  const { dealId, file, uploadedBy, body } = i;
  const drop = () => fs.unlink(file.path, () => {});
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const subcategory = str(body.subcategory);
  const rawTitle = typeof body.title === "string" ? body.title.trim() : "";
  const requirementId = str(body.requirementId);

  // An explicit checklist row decides the parser category (a seller's
  // checklist upload used to land as "other" and parse with the wrong
  // prompt). Sellers may not replace a row the broker has verified.
  const { docCategoryForRequirement, linkUploadToRequirement, categoryAfterLink } = await import("./requirements");
  let targetRequirement: Awaited<ReturnType<typeof storage.getDocumentRequirement>> | undefined;
  if (requirementId) {
    targetRequirement = await storage.getDocumentRequirement(requirementId);
    if (!targetRequirement || targetRequirement.dealId !== dealId) {
      drop();
      return { ok: false, status: 400, error: "That checklist item doesn't belong to this deal" };
    }
    if (uploadedBy === "seller" && targetRequirement.status === "verified") {
      drop();
      return { ok: false, status: 409, error: "Your broker has already verified this document — ask them before replacing it" };
    }
  }
  // A document the interview asked for (an open document request): the
  // upload answers it, and the request closes.
  const taskId = str(body.taskId);
  let targetTask: Awaited<ReturnType<typeof storage.getTask>> | undefined;
  if (taskId) {
    const { sellerMaySatisfyTask } = await import("@shared/seller-portal");
    targetTask = await storage.getTask(taskId);
    if (!sellerMaySatisfyTask(targetTask, dealId, targetTask?.dealId)) {
      drop();
      return { ok: false, status: 400, error: "That request isn't open on this deal any more" };
    }
  }
  const requestedCategory = str(body.category) ?? "";
  const category =
    requestedCategory && requestedCategory !== "other"
      ? requestedCategory
      : targetRequirement
        ? docCategoryForRequirement(targetRequirement.category)
        : requestedCategory || "other";

  // Pasted text carries its own title; keep it verbatim as the display
  // name. Only the on-disk filename (doc_<random>.ext) needs sanitising.
  const displayName = (rawTitle || decodeUploadName(file.originalname)).slice(0, 200);
  // Provenance v2: the broker says what kind of source this is (email,
  // call transcript, CRM note…) and who may see it. A seller's upload is
  // always a shared document.
  const { isSourceKind } = await import("../interview/info-merger");
  const { cleanSourceMeta, defaultVisibilityForKind } = await import("./ingest");
  const requestedKind = uploadedBy === "broker" && isSourceKind(body.sourceKind) ? body.sourceKind : "document";
  let sourceMeta: DocumentSourceMeta | null = null;
  if (uploadedBy === "broker" && typeof body.sourceMeta === "string" && body.sourceMeta.trim()) {
    try { sourceMeta = cleanSourceMeta(JSON.parse(body.sourceMeta)); } catch { sourceMeta = null; }
  }
  if (i.readSkipped) sourceMeta = { ...(sourceMeta ?? {}), readSkipped: true };
  const visibility =
    uploadedBy === "broker" && (body.visibility === "broker_only" || body.visibility === "shared")
      ? body.visibility
      : uploadedBy === "broker" ? defaultVisibilityForKind(requestedKind as any) : "shared";
  // A file uploaded for the general-ledger row is filed as a ledger (the
  // ledger reader credits the row once it is read — gl spec D23).
  const { isGlRequirement } = await import("./requirements");
  const forGlRow = !!targetRequirement && isGlRequirement(targetRequirement);
  if (forGlRow && uploadedBy === "seller") {
    // Only the owner's or the accountant's link uploads the ledger (gl spec D24).
    const invite = i.sellerToken ? await storage.getSellerInviteByToken(i.sellerToken) : undefined;
    const { sellerLinkRights, OWNER_OR_ACCOUNTANT_MESSAGE } = await import("@shared/seller-link-rights");
    if (!invite || !sellerLinkRights(invite, await storage.getDealMembers(dealId)).canTraceAddbacks) {
      drop();
      return { ok: false, status: 403, error: OWNER_OR_ACCOUNTANT_MESSAGE };
    }
  }
  const doc = await storage.createDocument({
    dealId,
    uploadedBy,
    name: displayName,
    originalName: displayName,
    category: forGlRow ? "financials" : category,
    subcategory: forGlRow ? "general_ledger" : subcategory || null,
    fileUrl: `/uploads/docs/${file.filename}`,
    fileSize: file.size ?? null,
    mimeType: file.mimetype || null,
    status: "pending",
    sourceKind: requestedKind,
    sourceMeta,
    visibility,
  } as any);

  // Credit the upload against the checklist: the explicit row when one
  // was chosen, otherwise the best unambiguous keyword match (so a
  // broker dropping "2023 P&L.pdf" counts toward the financials row).
  // When the seller replaces their own earlier upload, that file goes.
  const previousFileId = targetRequirement?.uploadedFileId ?? null;
  // A broker-only source is never credited on the seller's checklist
  // (the seller would see its name there).
  const linkedRequirement = visibility === "broker_only" ? null : await linkUploadToRequirement({
    dealId,
    docId: doc.id,
    fileName: displayName,
    docCategory: category,
    uploadedBy,
    requirementId,
    sourceKind: requestedKind,
  });
  // Matched to a checklist row by its name ("2024 P&L.pdf" → "Financial
  // Statements"): an uncategorised upload takes the row's category, as a
  // chosen row does, so it is read as a statement (the financial analysis
  // extracts line items only from financial documents).
  const linkedCategory = categoryAfterLink(category, linkedRequirement);
  if (linkedCategory !== category) {
    await storage.updateDocument(doc.id, { category: linkedCategory } as any);
    (doc as any).category = linkedCategory;
  }
  if (linkedRequirement && previousFileId && previousFileId !== doc.id && uploadedBy === "seller") {
    const previous = await storage.getDocument(previousFileId);
    if (previous && previous.dealId === dealId && previous.uploadedBy === "seller") {
      // Data room: the new version takes the old one's place, not shared (before the old row goes).
      const { markReplacement } = await import("../vdr/setup");
      await markReplacement(previous.id, doc.id);
      const { deleteDocumentAndProvenance } = await import("./cleanup");
      await deleteDocumentAndProvenance(previous.id).catch((e) => console.warn("[documents] replace cleanup failed:", e));
    }
  }
  // Data room: a buyer's request the broker asked the seller for is now "Ready to share".
  if (linkedRequirement) {
    const { onRequirementFulfilled } = await import("../vdr/requests");
    await onRequirementFulfilled(linkedRequirement.id, doc.id);
  }

  let satisfiedTask: { id: string; title: string } | null = null;
  if (targetTask) {
    const note = `${uploadedBy === "seller" ? "The seller" : "You"} uploaded "${displayName}" for this request.`;
    // Copies of the same request an earlier turn re-created close with it
    // (the seller's list shows them as one row — one would pop back up).
    const { openItemTaskIds } = await import("@shared/seller-portal");
    const dealTasks = await storage.getTasksByDeal(dealId);
    const now = new Date();
    for (const tid of openItemTaskIds(dealTasks, targetTask)) {
      const t = tid === targetTask.id ? targetTask : dealTasks.find((x) => x.id === tid);
      if (!t) continue;
      await storage.updateTask(tid, {
        status: "completed",
        completedAt: now,
        brokerNotes: t.brokerNotes ? `${t.brokerNotes}\n${note}` : note,
      } as any);
    }
    satisfiedTask = { id: targetTask.id, title: targetTask.title };
  }

  if (i.beforeParse) await i.beforeParse(doc).catch((e) => console.warn("[documents] after-upload step failed:", e?.message ?? e));
  parseDocumentAsync(doc.id);
  return { ok: true, doc, linkedRequirement, satisfiedTask };
}
