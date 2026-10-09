/**
 * Storage for "Interview together" sittings and their lines
 * (specs/together.md §6.1). One seam: the database in production, an
 * in-memory store in tests (`memoryTogetherStore`, `_setTogetherStoreForTests`).
 *
 * Idempotency: a line is unique per (sitting, client id, client seq) — a
 * retried batch, a reload (new client id) or a second tab never collide or
 * double. The sitting's `line_seq` hands out the line numbers.
 */
import { and, asc, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import {
  togetherLines,
  togetherSittings,
  type InsertTogetherLine,
  type InsertTogetherSitting,
  type TogetherLine,
  type TogetherSitting,
} from "@shared/schema";

export type SittingPatch = Partial<Omit<InsertTogetherSitting, "id" | "dealId">>;

export interface TogetherStore {
  insertSitting(row: InsertTogetherSitting): Promise<TogetherSitting>;
  getSitting(id: string): Promise<TogetherSitting | undefined>;
  /** Newest first. */
  listSittings(dealId: string): Promise<TogetherSitting[]>;
  /** Sittings not ended (live or paused), newest first. */
  openSittings(dealId: string): Promise<TogetherSitting[]>;
  updateSitting(id: string, patch: SittingPatch): Promise<TogetherSitting | undefined>;
  /** Reserve `n` line numbers; returns the first. Also stamps last_line_at. */
  reserveSeq(id: string, n: number, at: Date): Promise<number>;
  /** Inserts, skipping rows that collide on (sitting, client id, client seq). Returns the rows inserted. */
  insertLines(rows: InsertTogetherLine[]): Promise<TogetherLine[]>;
  /** Client seqs already stored for this page id. */
  existingClientSeqs(sittingId: string, clientId: string, seqs: number[]): Promise<Set<number>>;
  linesAfter(sittingId: string, afterSeq: number, limit: number): Promise<TogetherLine[]>;
  /** The last `limit` lines, oldest first. */
  lastLines(sittingId: string, limit: number): Promise<TogetherLine[]>;
  allLines(sittingId: string): Promise<TogetherLine[]>;
  countLines(sittingId: string): Promise<number>;
  deleteLines(sittingId: string): Promise<number>;
  attestLines(sittingId: string, seqs: number[], at: Date): Promise<number>;
}

// ─────────────────────────────────────────────────────────────────────────
// Database
// ─────────────────────────────────────────────────────────────────────────

async function dbh() {
  return (await import("../db")).db;
}

const dbStore: TogetherStore = {
  async insertSitting(row) {
    const db = await dbh();
    const [created] = await db.insert(togetherSittings).values(row).returning();
    return created;
  },
  async getSitting(id) {
    const db = await dbh();
    const [row] = await db.select().from(togetherSittings).where(eq(togetherSittings.id, id)).limit(1);
    return row;
  },
  async listSittings(dealId) {
    const db = await dbh();
    return db.select().from(togetherSittings).where(eq(togetherSittings.dealId, dealId)).orderBy(desc(togetherSittings.startedAt));
  },
  async openSittings(dealId) {
    const db = await dbh();
    return db
      .select()
      .from(togetherSittings)
      .where(and(eq(togetherSittings.dealId, dealId), ne(togetherSittings.status, "ended")))
      .orderBy(desc(togetherSittings.startedAt));
  },
  async updateSitting(id, patch) {
    const db = await dbh();
    const [row] = await db.update(togetherSittings).set(patch).where(eq(togetherSittings.id, id)).returning();
    return row;
  },
  async reserveSeq(id, n, at) {
    const db = await dbh();
    const [row] = await db
      .update(togetherSittings)
      .set({ lineSeq: sql`${togetherSittings.lineSeq} + ${n}`, lastLineAt: at })
      .where(eq(togetherSittings.id, id))
      .returning({ lineSeq: togetherSittings.lineSeq });
    if (!row) throw new Error("Sitting not found");
    return row.lineSeq - n + 1;
  },
  async insertLines(rows) {
    if (rows.length === 0) return [];
    const db = await dbh();
    return db.insert(togetherLines).values(rows).onConflictDoNothing().returning();
  },
  async existingClientSeqs(sittingId, clientId, seqs) {
    if (seqs.length === 0) return new Set();
    const db = await dbh();
    const rows = await db
      .select({ clientSeq: togetherLines.clientSeq })
      .from(togetherLines)
      .where(and(eq(togetherLines.sittingId, sittingId), eq(togetherLines.clientId, clientId), inArray(togetherLines.clientSeq, seqs)));
    return new Set(rows.map((r) => r.clientSeq).filter((n): n is number => typeof n === "number"));
  },
  async linesAfter(sittingId, afterSeq, limit) {
    const db = await dbh();
    return db
      .select()
      .from(togetherLines)
      .where(and(eq(togetherLines.sittingId, sittingId), gt(togetherLines.seq, afterSeq)))
      .orderBy(asc(togetherLines.seq))
      .limit(limit);
  },
  async lastLines(sittingId, limit) {
    const db = await dbh();
    const rows = await db.select().from(togetherLines).where(eq(togetherLines.sittingId, sittingId)).orderBy(desc(togetherLines.seq)).limit(limit);
    return rows.reverse();
  },
  async allLines(sittingId) {
    const db = await dbh();
    return db.select().from(togetherLines).where(eq(togetherLines.sittingId, sittingId)).orderBy(asc(togetherLines.seq));
  },
  async countLines(sittingId) {
    const db = await dbh();
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(togetherLines).where(eq(togetherLines.sittingId, sittingId));
    return Number(row?.n ?? 0);
  },
  async deleteLines(sittingId) {
    const db = await dbh();
    const rows = await db.delete(togetherLines).where(eq(togetherLines.sittingId, sittingId)).returning({ id: togetherLines.id });
    return rows.length;
  },
  async attestLines(sittingId, seqs, at) {
    if (seqs.length === 0) return 0;
    const db = await dbh();
    const rows = await db
      .update(togetherLines)
      .set({ attestedSellerAt: at })
      .where(and(eq(togetherLines.sittingId, sittingId), inArray(togetherLines.seq, seqs)))
      .returning({ id: togetherLines.id });
    return rows.length;
  },
};

// ─────────────────────────────────────────────────────────────────────────
// In memory (tests)
// ─────────────────────────────────────────────────────────────────────────

let memId = 0;
const newId = (p: string) => `${p}${++memId}-${Math.random().toString(36).slice(2, 8)}`;

/** An in-memory store with the database's rules (unique client seq, monotonic seq). */
export function memoryTogetherStore(): TogetherStore & { sittings: TogetherSitting[]; lines: TogetherLine[] } {
  const sittings: TogetherSitting[] = [];
  const lines: TogetherLine[] = [];
  const clone = <T>(x: T): T => structuredClone(x);
  return {
    sittings,
    lines,
    async insertSitting(row) {
      const s = {
        id: row.id ?? newId("SIT"),
        dealId: row.dealId,
        brokerId: row.brokerId,
        via: row.via,
        status: row.status ?? "live",
        startedAt: row.startedAt ?? new Date(),
        pausedAt: row.pausedAt ?? null,
        endedAt: row.endedAt ?? null,
        lastLineAt: row.lastLineAt ?? null,
        consentAt: row.consentAt ?? null,
        lineSeq: row.lineSeq ?? 0,
        chunkNo: row.chunkNo ?? 0,
        transcriptDocumentId: row.transcriptDocumentId ?? null,
        botId: row.botId ?? null,
        speakers: row.speakers ?? {},
        sellerSeesScreen: row.sellerSeesScreen ?? false,
        captureEnv: row.captureEnv,
        captureOwner: row.captureOwner ?? null,
        captureLeaseUntil: row.captureLeaseUntil ?? null,
        captureState: row.captureState ?? {},
        summary: row.summary ?? null,
        interviewCompleted: row.interviewCompleted ?? false,
      } as TogetherSitting;
      sittings.push(s);
      return clone(s);
    },
    async getSitting(id) {
      const s = sittings.find((x) => x.id === id);
      return s ? clone(s) : undefined;
    },
    async listSittings(dealId) {
      return clone(sittings.filter((s) => s.dealId === dealId).sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt)));
    },
    async openSittings(dealId) {
      return clone(sittings.filter((s) => s.dealId === dealId && s.status !== "ended").sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt)));
    },
    async updateSitting(id, patch) {
      const s = sittings.find((x) => x.id === id);
      if (!s) return undefined;
      Object.assign(s, patch);
      return clone(s);
    },
    async reserveSeq(id, n, at) {
      const s = sittings.find((x) => x.id === id);
      if (!s) throw new Error("Sitting not found");
      s.lineSeq += n;
      s.lastLineAt = at;
      return s.lineSeq - n + 1;
    },
    async insertLines(rows) {
      const out: TogetherLine[] = [];
      for (const r of rows) {
        const clash =
          lines.some((l) => l.sittingId === r.sittingId && l.seq === r.seq) ||
          (r.clientId != null && r.clientSeq != null && lines.some((l) => l.sittingId === r.sittingId && l.clientId === r.clientId && l.clientSeq === r.clientSeq));
        if (clash) continue;
        const l = {
          id: r.id ?? newId("L"),
          sittingId: r.sittingId,
          dealId: r.dealId,
          seq: r.seq,
          speaker: r.speaker,
          text: r.text,
          source: r.source,
          clientId: r.clientId ?? null,
          clientSeq: r.clientSeq ?? null,
          attestedSellerAt: r.attestedSellerAt ?? null,
          at: r.at ?? new Date(),
          chunkId: r.chunkId ?? null,
        } as TogetherLine;
        lines.push(l);
        out.push(clone(l));
      }
      return out;
    },
    async existingClientSeqs(sittingId, clientId, seqs) {
      return new Set(lines.filter((l) => l.sittingId === sittingId && l.clientId === clientId && l.clientSeq != null && seqs.includes(l.clientSeq)).map((l) => l.clientSeq!));
    },
    async linesAfter(sittingId, afterSeq, limit) {
      return clone(lines.filter((l) => l.sittingId === sittingId && l.seq > afterSeq).sort((a, b) => a.seq - b.seq).slice(0, limit));
    },
    async lastLines(sittingId, limit) {
      const all = lines.filter((l) => l.sittingId === sittingId).sort((a, b) => a.seq - b.seq);
      return clone(all.slice(Math.max(0, all.length - limit)));
    },
    async allLines(sittingId) {
      return clone(lines.filter((l) => l.sittingId === sittingId).sort((a, b) => a.seq - b.seq));
    },
    async countLines(sittingId) {
      return lines.filter((l) => l.sittingId === sittingId).length;
    },
    async deleteLines(sittingId) {
      let n = 0;
      for (let i = lines.length - 1; i >= 0; i--) if (lines[i].sittingId === sittingId) { lines.splice(i, 1); n++; }
      return n;
    },
    async attestLines(sittingId, seqs, at) {
      let n = 0;
      for (const l of lines) if (l.sittingId === sittingId && seqs.includes(l.seq)) { l.attestedSellerAt = at; n++; }
      return n;
    },
  };
}

let store: TogetherStore = dbStore;

export function _setTogetherStoreForTests(s: TogetherStore | null): void {
  store = s ?? dbStore;
}

export function togetherStore(): TogetherStore {
  return store;
}
