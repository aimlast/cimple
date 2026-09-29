/**
 * document-list — the broker's document list (GET /api/deals/:dealId/documents).
 *
 * The list used to return every row as stored: each document's full
 * extracted text and every extracted field. No screen reads them, and the
 * Overview tab polls the list every 2.5 s while anything is being read —
 * 0.3–0.7 MB per poll on the demo deals, 11 MB+ with a general-ledger
 * export, all loaded and JSON-encoded on the event loop each time. The list
 * now carries the row's columns without the text, and of the extracted data
 * only its summary and document type. The full text stays one request away
 * (the Information tab's /sources/:docId/text).
 */
import { desc, eq, getTableColumns, sql } from "drizzle-orm";
import { db } from "../db";
import { documents, type Document } from "@shared/schema";

/** A list row: the document without its text; extractedData reduced to what a list shows. */
export type DocumentListRow = Omit<Document, "extractedText" | "extractedData"> & {
  extractedData: { summary?: string; _documentType?: string } | null;
};

/** Pure: the list shape of a full row (used where a full row is already loaded). */
export function toDocumentListRow(doc: Document): DocumentListRow {
  const { extractedText: _t, extractedData, ...rest } = doc;
  const data = extractedData && typeof extractedData === "object" && !Array.isArray(extractedData) ? (extractedData as Record<string, unknown>) : null;
  return { ...rest, extractedData: slimExtractedData(data?.summary, data?._documentType) };
}

function slimExtractedData(summary: unknown, documentType: unknown): DocumentListRow["extractedData"] {
  const out: { summary?: string; _documentType?: string } = {};
  if (typeof summary === "string" && summary) out.summary = summary;
  if (typeof documentType === "string" && documentType) out._documentType = documentType;
  return Object.keys(out).length > 0 ? out : null;
}

/** The deal's documents for the list, newest first — the text is never read from the database. */
export async function listDocumentsForBroker(dealId: string): Promise<DocumentListRow[]> {
  const rows = await documentListQuery(dealId);
  return rows.map(({ summary, documentType, ...row }) => ({ ...row, extractedData: slimExtractedData(summary, documentType) }) as DocumentListRow);
}

/** The list's SELECT (exported so a test can check what it reads). */
export function documentListQuery(dealId: string) {
  const { extractedText: _t, extractedData: _d, ...columns } = getTableColumns(documents);
  return db
    .select({
      ...columns,
      summary: sql<string | null>`${documents.extractedData}->>'summary'`,
      documentType: sql<string | null>`${documents.extractedData}->>'_documentType'`,
    })
    .from(documents)
    .where(eq(documents.dealId, dealId))
    .orderBy(desc(documents.createdAt));
}
