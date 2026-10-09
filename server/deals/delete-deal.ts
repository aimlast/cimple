/**
 * Deleting a deal deletes the deal — everywhere.
 *
 * There are no foreign keys onto `deals`, so the old delete (one row) left
 * every transcript, extracted financial, seller invite, buyer link and
 * uploaded file behind: production held 109 documents (with their full
 * extracted text), 18 seller invites, 115 buyer links and 12 interview
 * sessions for deals that no longer existed — and an orphaned invite's
 * token still opened the orphaned files. That conflicts with what the
 * privacy policy promises a seller who asks to be removed.
 *
 * `DEAL_CHILD_TABLES` names every table that carries a deal id and what
 * happens to its rows; tests/unit/f2-security.test.ts fails when a table
 * with a deal id is added to shared/schema.ts without being listed here.
 */
import fs from "fs";
import { eq, inArray, and, not, sql, type SQL } from "drizzle-orm";
import {
  deals, documents, tasks, interviewSessions, cimSections, buyerQuestions, sellerInvites, buyerAccess,
  analyticsEvents, faqItems, integrationEmails, dealKnowledgeSources, financialAnalyses, addbackVerifications,
  cimSectionOverrides, discrepancies, dealMembers, notifications, buyerApprovalRequests, dealOutreach,
  dealDocumentRequirements, buyerEmails, dealMedia, buyerUsers, cimPublishedSnapshots,
  cimRenditions, buyerVisits, readingRollups, readingBenchmarks,
  vdrRooms, vdrFolders, vdrItems, vdrShares, vdrBuyerSettings, vdrRequests, vdrViews, vdrActivity, vdrPageText, vdrTeamMembers,
} from "@shared/schema";
import { resolveDocumentPath } from "../documents/document-path";

/**
 * Every table holding a deal id → "delete" (the deal's own data) or
 * "detach" (a record that belongs to someone else — the broker's log of an
 * email they sent a buyer, a buyer account first invited from this deal —
 * keeps its row and loses the link).
 */
export const DEAL_CHILD_TABLES = {
  documents: { table: documents, column: documents.dealId, mode: "delete" },
  tasks: { table: tasks, column: tasks.dealId, mode: "delete" },
  interview_sessions: { table: interviewSessions, column: interviewSessions.dealId, mode: "delete" },
  cim_sections: { table: cimSections, column: cimSections.dealId, mode: "delete" },
  cim_section_overrides: { table: cimSectionOverrides, column: cimSectionOverrides.dealId, mode: "delete" },
  buyer_questions: { table: buyerQuestions, column: buyerQuestions.dealId, mode: "delete" },
  seller_invites: { table: sellerInvites, column: sellerInvites.dealId, mode: "delete" },
  buyer_access: { table: buyerAccess, column: buyerAccess.dealId, mode: "delete" },
  analytics_events: { table: analyticsEvents, column: analyticsEvents.dealId, mode: "delete" },
  faq_items: { table: faqItems, column: faqItems.dealId, mode: "delete" },
  integration_emails: { table: integrationEmails, column: integrationEmails.dealId, mode: "delete" },
  deal_knowledge_sources: { table: dealKnowledgeSources, column: dealKnowledgeSources.dealId, mode: "delete" },
  financial_analyses: { table: financialAnalyses, column: financialAnalyses.dealId, mode: "delete" },
  addback_verifications: { table: addbackVerifications, column: addbackVerifications.dealId, mode: "delete" },
  discrepancies: { table: discrepancies, column: discrepancies.dealId, mode: "delete" },
  deal_members: { table: dealMembers, column: dealMembers.dealId, mode: "delete" },
  notifications: { table: notifications, column: notifications.dealId, mode: "delete" },
  buyer_approval_requests: { table: buyerApprovalRequests, column: buyerApprovalRequests.dealId, mode: "delete" },
  deal_outreach: { table: dealOutreach, column: dealOutreach.dealId, mode: "delete" },
  deal_document_requirements: { table: dealDocumentRequirements, column: dealDocumentRequirements.dealId, mode: "delete" },
  deal_media: { table: dealMedia, column: dealMedia.dealId, mode: "delete" },
  // The kept copy of a live CIM while an update is reviewed (published-snapshot.ts).
  cim_published_snapshots: { table: cimPublishedSnapshots, column: cimPublishedSnapshots.dealId, mode: "delete" },
  // Reading analytics (server/analytics/*): visits, per-part rollups, the
  // versions buyers were served, and the deal's anonymous benchmarks (which
  // would otherwise keep feeding other brokers' benchmarks and layout hints).
  reading_rollups: { table: readingRollups, column: readingRollups.dealId, mode: "delete" },
  buyer_visits: { table: buyerVisits, column: buyerVisits.dealId, mode: "delete" },
  cim_renditions: { table: cimRenditions, column: cimRenditions.dealId, mode: "delete" },
  reading_benchmarks: { table: readingBenchmarks, column: readingBenchmarks.dealId, mode: "delete" },
  // The data room (vdr): the room, its index, sharing, per-buyer settings,
  // requests, views, the audit log, the served text and buyers' team members.
  vdr_rooms: { table: vdrRooms, column: vdrRooms.dealId, mode: "delete" },
  vdr_folders: { table: vdrFolders, column: vdrFolders.dealId, mode: "delete" },
  vdr_items: { table: vdrItems, column: vdrItems.dealId, mode: "delete" },
  vdr_shares: { table: vdrShares, column: vdrShares.dealId, mode: "delete" },
  vdr_buyer_settings: { table: vdrBuyerSettings, column: vdrBuyerSettings.dealId, mode: "delete" },
  vdr_requests: { table: vdrRequests, column: vdrRequests.dealId, mode: "delete" },
  vdr_views: { table: vdrViews, column: vdrViews.dealId, mode: "delete" },
  vdr_activity: { table: vdrActivity, column: vdrActivity.dealId, mode: "delete" },
  vdr_page_text: { table: vdrPageText, column: vdrPageText.dealId, mode: "delete" },
  vdr_team_members: { table: vdrTeamMembers, column: vdrTeamMembers.dealId, mode: "delete" },
  buyer_emails: { table: buyerEmails, column: buyerEmails.dealId, mode: "detach", field: "dealId" },
  buyer_users: { table: buyerUsers, column: buyerUsers.invitedByDeal, mode: "detach", field: "invitedByDeal" },
} as const;

type Db = typeof import("../db").db;

/**
 * The WHERE clause for "this row points at a deal that no longer exists",
 * on `table.column` — used by the orphan clean-up for its dry-run count AND
 * for what --apply deletes or detaches, so the two can never differ. A row
 * with no deal id at all is not an orphan and is never touched.
 */
export function orphanedRowsWhere(table: string, column: string): SQL {
  return sql`${sql.identifier(table)}.${sql.identifier(column)} IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM deals x WHERE x.id = ${sql.identifier(table)}.${sql.identifier(column)})`;
}

/** The deal row and everything listed above, in one transaction. */
export async function deleteDealRows(db: Db, dealId: string): Promise<void> {
  await db.transaction(async (tx) => {
    for (const entry of Object.values(DEAL_CHILD_TABLES)) {
      if ("field" in entry) {
        await tx.update(entry.table as any).set({ [entry.field]: null } as any).where(eq(entry.column as any, dealId));
      } else {
        await tx.delete(entry.table as any).where(eq(entry.column as any, dealId));
      }
    }
    await tx.delete(deals).where(eq(deals.id, dealId));
  });
}

/**
 * Files on disk a deal's documents point at that no OTHER document row
 * shares (a copied row may point at the same file — never delete that).
 */
export async function dealFilesToRemove(db: Db, dealId: string, root?: string): Promise<string[]> {
  const own = await db.select({ fileUrl: documents.fileUrl }).from(documents).where(eq(documents.dealId, dealId));
  const urls = Array.from(new Set(own.map((d) => d.fileUrl).filter((u): u is string => !!u)));
  if (urls.length === 0) return [];
  const shared = await db
    .select({ fileUrl: documents.fileUrl })
    .from(documents)
    .where(and(inArray(documents.fileUrl, urls), not(eq(documents.dealId, dealId))));
  const keep = new Set(shared.map((d) => d.fileUrl));
  return urls
    .filter((u) => !keep.has(u))
    .map((u) => resolveDocumentPath({ fileUrl: u }, root))
    .filter((p): p is string => !!p);
}

/** Deletes a deal, its rows everywhere, its documents' files, its private media folder and its data-room folders. */
export async function deleteDealEverywhere(dealId: string): Promise<{ files: number }> {
  const { db } = await import("../db");
  const { dealMediaDir } = await import("../cim/media-store");
  const { vdrDealDirs } = await import("../vdr/files");
  const files = await dealFilesToRemove(db, dealId);
  await deleteDealRows(db, dealId);
  let removed = 0;
  for (const f of files) {
    try { fs.unlinkSync(f); removed++; } catch { /* already gone */ }
  }
  try { fs.rmSync(dealMediaDir(dealId), { recursive: true, force: true }); } catch { /* none */ }
  // The data room's cleaned copies and prepared pages (private-vdr/<id>, private-vdr-cache/<id>).
  for (const dir of vdrDealDirs(dealId)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* none */ }
  }
  return { files: removed };
}
