/**
 * The email check on a teaser link (spec §4.8, E6). Teaser links go out in
 * bulk before any NDA; without this, anyone holding a forwarded link could
 * sign the NDA under their own name and receive the CIM on the original
 * recipient's link. So asking for the CIM needs a 6-digit code sent to the
 * address the broker sent the link to — never an address the requester types.
 *
 *  - The code is stored as an HMAC (key from SESSION_SECRET), never as typed;
 *    it works for 15 minutes and allows 5 tries.
 *  - Sends are limited per link: 3 an hour and 10 a day.
 *  - A verified check holds 24 hours for the request steps.
 *  - Skipped (recorded as `method`): "account" — the requester is signed in
 *    to a buyer account with a verified email that is the link's address;
 *    "demo" — demo deals, which never email.
 */
import { createHmac, randomInt, createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { buyerLinkEmailChecks, type BuyerAccess, type Deal } from "@shared/schema";
import { createPerKeyLimiter } from "../security/per-key-limit";
import { TEASER_ACCESS_LEVEL } from "@shared/access-levels";

export const CODE_TTL_MS = 15 * 60_000;
export const MAX_ATTEMPTS = 5;
export const VERIFIED_FOR_MS = 24 * 3_600_000;

export interface EmailCheckRow {
  id: string;
  dealId: string;
  buyerAccessId: string;
  codeHash: string;
  sentAt: Date;
  expiresAt: Date;
  attempts: number;
  verifiedAt: Date | null;
  method: "code" | "account" | "demo";
}

export interface EmailCheckStore {
  latest(accessId: string): Promise<EmailCheckRow | null>;
  insert(row: Omit<EmailCheckRow, "id">): Promise<EmailCheckRow>;
  update(id: string, patch: Partial<Pick<EmailCheckRow, "attempts" | "verifiedAt">>): Promise<void>;
}

const dbChecks: EmailCheckStore = {
  async latest(accessId) {
    const { db } = await import("../db");
    const [r] = await db.select().from(buyerLinkEmailChecks).where(eq(buyerLinkEmailChecks.buyerAccessId, accessId)).orderBy(desc(buyerLinkEmailChecks.sentAt)).limit(1);
    return r ? ({ ...r, method: (r.method as EmailCheckRow["method"]) ?? "code" } as EmailCheckRow) : null;
  },
  async insert(row) {
    const { db } = await import("../db");
    const [r] = await db.insert(buyerLinkEmailChecks).values(row).returning();
    return { ...r, method: r.method as EmailCheckRow["method"] } as EmailCheckRow;
  },
  async update(id, patch) {
    const { db } = await import("../db");
    await db.update(buyerLinkEmailChecks).set(patch).where(and(eq(buyerLinkEmailChecks.id, id)));
  },
};

export function memoryEmailCheckStore(): EmailCheckStore & { rows: EmailCheckRow[] } {
  const rows: EmailCheckRow[] = [];
  let n = 0;
  return {
    rows,
    async latest(accessId) {
      const mine = rows.filter((r) => r.buyerAccessId === accessId).sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime() || b.id.localeCompare(a.id));
      return mine[0] ? { ...mine[0] } : null;
    },
    async insert(row) {
      const r = { ...row, id: `ec-${String(++n).padStart(4, "0")}` };
      rows.push(r);
      return { ...r };
    },
    async update(id, patch) {
      const r = rows.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
    },
  };
}

let checks: EmailCheckStore = dbChecks;
export function _setEmailCheckStoreForTests(s: EmailCheckStore | null): void {
  checks = s ?? dbChecks;
}

/** Sends the code email (production: sendDirectEmail). Tests capture it. */
export type EmailSender = (to: string, subject: string, html: string) => Promise<boolean>;
const realSender: EmailSender = async (to, subject, html) => {
  const { sendDirectEmail } = await import("../notifications/service");
  return sendDirectEmail(to, subject, html);
};
let sender: EmailSender = realSender;
export function _setEmailSenderForTests(fn: EmailSender | null): void {
  sender = fn ?? realSender;
}

const hourLimit = createPerKeyLimiter({ limit: 3, windowMs: 3_600_000 });
const dayLimit = createPerKeyLimiter({ limit: 10, windowMs: 86_400_000 });
export function _resetEmailCheckLimitsForTests(): void {
  hourLimit.reset();
  dayLimit.reset();
}

function hmacKey(): string {
  return createHash("sha256").update(`cimple:link-email-check:${process.env.SESSION_SECRET || "dev-session-secret"}`).digest("hex");
}

export function codeHash(accessId: string, code: string): string {
  return createHmac("sha256", hmacKey()).update(`${accessId}:${code}`).digest("hex");
}

/** "n•••@cascaderidge.com" — enough to recognise, never the whole address. */
export function maskEmail(email: string | null | undefined): string {
  const e = (email ?? "").trim();
  const at = e.indexOf("@");
  if (at < 1) return "your email";
  return `${e[0]}•••${e.slice(at)}`;
}

const sameEmail = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export interface EmailCheckState {
  needed: boolean;
  maskedEmail: string;
  verified: boolean;
  method: EmailCheckRow["method"] | null;
}

/** Signed-in buyer account (req.session.buyerId) with a verified email that IS the link's address. */
export async function accountMatches(access: Pick<BuyerAccess, "buyerEmail">, buyerId: string | null | undefined): Promise<boolean> {
  if (!buyerId) return false;
  const { storage } = await import("../storage");
  const u = await storage.getBuyerUser(buyerId).catch(() => undefined);
  return !!u && !!u.emailVerified && sameEmail(u.email, access.buyerEmail);
}

/** Where the check stands for this link (the view payload's `emailCheck`). */
export async function emailCheckState(
  access: Pick<BuyerAccess, "id" | "buyerEmail">,
  deal: Pick<Deal, "demoKey">,
  buyerId: string | null | undefined,
  now = Date.now(),
): Promise<EmailCheckState> {
  const masked = maskEmail(access.buyerEmail);
  if (deal.demoKey) return { needed: false, maskedEmail: masked, verified: true, method: "demo" };
  if (await accountMatches(access, buyerId)) return { needed: false, maskedEmail: masked, verified: true, method: "account" };
  const last = await checks.latest(access.id);
  const verified = !!last?.verifiedAt && now - last.verifiedAt.getTime() < VERIFIED_FOR_MS;
  return { needed: !verified, maskedEmail: masked, verified, method: verified ? last!.method : null };
}

/**
 * For the request steps: is the check verified (or skipped)? Records the
 * skip as a row (method "account" / "demo") so the request card can say how
 * the email was confirmed.
 */
export async function requireEmailCheck(
  access: Pick<BuyerAccess, "id" | "dealId" | "buyerEmail">,
  deal: Pick<Deal, "demoKey">,
  buyerId: string | null | undefined,
): Promise<{ ok: true; method: EmailCheckRow["method"] } | { ok: false }> {
  const state = await emailCheckState(access, deal, buyerId);
  if (!state.verified) return { ok: false };
  if (state.method === "account" || state.method === "demo") {
    const last = await checks.latest(access.id);
    if (!last || last.method !== state.method || !last.verifiedAt) {
      const now = new Date();
      await checks.insert({ dealId: access.dealId, buyerAccessId: access.id, codeHash: "skipped", sentAt: now, expiresAt: now, attempts: 0, verifiedAt: now, method: state.method });
    }
  }
  return { ok: true, method: state.method ?? "code" };
}

export type SendResult = { sent: true; maskedEmail: string } | { limited: true; error: string } | { skipped: true; maskedEmail: string };

/** Send a fresh code to the link's own address. A body's `email` is never read. */
export async function sendEmailCode(
  access: Pick<BuyerAccess, "id" | "dealId" | "buyerEmail" | "accessToken">,
  deal: Pick<Deal, "demoKey" | "businessName"> & { blindCodename?: string | null },
  opts: { buyerId?: string | null; firm?: string | null } = {},
): Promise<SendResult> {
  const masked = maskEmail(access.buyerEmail);
  if (deal.demoKey) return { skipped: true, maskedEmail: masked };
  if (await accountMatches(access, opts.buyerId)) return { skipped: true, maskedEmail: masked };
  const key = createHash("sha256").update(String(access.accessToken)).digest("hex").slice(0, 32);
  const contact = opts.firm?.trim() ? `contact ${opts.firm.trim()}` : "contact your broker";
  if (!dayLimit.take(key)) return { limited: true, error: `Too many codes sent. Try again tomorrow or ${contact}.` };
  if (!hourLimit.take(key)) return { limited: true, error: `Too many codes sent. Try again in an hour or ${contact}.` };
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const now = new Date();
  await checks.insert({ dealId: access.dealId, buyerAccessId: access.id, codeHash: codeHash(access.id, code), sentAt: now, expiresAt: new Date(now.getTime() + CODE_TTL_MS), attempts: 0, verifiedAt: null, method: "code" });
  const { buildEmailCodeEmail } = await import("../buyers/approval-emails");
  const { buyerFacingDealName } = await import("../reminders/decision-reminders");
  const label = buyerFacingDealName(deal as never, { accessLevel: TEASER_ACCESS_LEVEL });
  const email = buildEmailCodeEmail({ code, dealLabel: label });
  await sender(access.buyerEmail, email.subject, email.html);
  return { sent: true, maskedEmail: masked };
}

export type VerifyResult =
  | { verified: true }
  | { verified: false; code: "wrong"; triesLeft: number }
  | { verified: false; code: "expired" }
  | { verified: false; code: "locked" }
  | { verified: false; code: "none" };

export async function verifyEmailCode(access: Pick<BuyerAccess, "id">, code: unknown, now = Date.now()): Promise<VerifyResult> {
  const last = await checks.latest(access.id);
  if (!last || last.method !== "code") return { verified: false, code: "none" };
  if (last.verifiedAt) return { verified: true };
  if (last.attempts >= MAX_ATTEMPTS) return { verified: false, code: "locked" };
  if (now > last.expiresAt.getTime()) return { verified: false, code: "expired" };
  const typed = String(code ?? "").replace(/\D/g, "");
  if (typed.length === 6 && codeHash(access.id, typed) === last.codeHash) {
    await checks.update(last.id, { verifiedAt: new Date(now) });
    return { verified: true };
  }
  const attempts = last.attempts + 1;
  await checks.update(last.id, { attempts });
  if (attempts >= MAX_ATTEMPTS) return { verified: false, code: "locked" };
  return { verified: false, code: "wrong", triesLeft: MAX_ATTEMPTS - attempts };
}
