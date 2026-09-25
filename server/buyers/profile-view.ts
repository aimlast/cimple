/**
 * The broker's view of one buyer: merged profile with a source per field,
 * the raw layers behind it, deals + engagement, NDA answers, approvals and a
 * merged activity timeline. Also the enriched Buyers list.
 *
 * Privacy:
 *   - Everything is scoped to the signed-in broker (their contact row, their
 *     deals). Callers must 404 unless isBuyerInBrokerList().
 *   - Liquid funds the buyer typed on their own profile are promised to show
 *     as a range only — masked here, before anything reaches the browser or
 *     the AI summary.
 *   - buyer_users is shared by every brokerage: its per-field provenance is
 *     scoped to this broker (provenance-scope.ts) — another brokerage's deal
 *     ids / imports are never returned, and never labelled as this broker's.
 *   - The buyer row is never serialised: every response is a whitelist
 *     (no passwordHash, reset token or raw field_sources).
 */
import { createHash } from "crypto";
import {
  mergeBuyerProfileWithSources, buyerFundsRange, buyerValueIsSet, calculateBuyerProfileCompletion, BUYER_CRITERIA_FIELDS, BUYER_PROFILE_FIELDS,
  type BrokerBuyerContact, type BrokerBuyerOverlay, type BrokerOverlayMeta, type BuyerAccessEvent,
  type BuyerAiSummary, type BuyerUser, type CrmBuyerProfile, type MergedFieldSource,
} from "@shared/schema";
import {
  FUNDING_OPTIONS, NDA_BUYER_TYPES, OPERATE_OPTIONS, PROOF_OF_FUNDS_OPTIONS, TIMELINE_OPTIONS, formatPrice,
  type NdaBuyerProfile,
} from "@shared/nda-buyer-profile";
import { buyerAccessPhrase } from "@shared/cim-layouts";
import { storage } from "../storage";
import { calculateQualifiedLeadScore } from "../scoring/buyer-score";
import {
  approvalsFor, brokerBuyerEngagement, decisionEvents, emailsFor, engagementByAccess, getBrokerDeals,
  getBuyerAccessOnBrokerDeals, getContact, outreachFor, questionsFor, sectionTitles,
} from "./profile-data";
import {
  accountSourceForBroker, legacySourceForBroker, loadBrokerScope, scopeFieldSources,
  type BrokerScope, type ScopedFieldSources,
} from "./provenance-scope";

export const INTEREST_LABELS: Record<string, string> = { hot: "Hot", warm: "Warm", cold: "Cold", not_interested: "Not interested" };

/**
 * The broker-effective profile for a buyer, with sources and the funds mask
 * applied. Sources are scoped to `scope`'s broker: stamps another brokerage
 * wrote on the shared row come back as a neutral "other" with no deal id.
 * A self-entered (or unattributable) liquid-funds figure is masked to a range.
 */
export function mergedForBroker(buyer: BuyerUser, contact: BrokerBuyerContact | null | undefined, scope: BrokerScope) {
  const ownSources = scopeFieldSources(buyer, contact, scope);
  const { profile, sources } = mergeBuyerProfileWithSources(
    { ...buyer, fieldSources: ownSources } as BuyerUser,
    (contact?.crmProfile as CrmBuyerProfile | null) ?? null,
    (contact?.brokerProfile as BrokerBuyerOverlay | null) ?? null,
    (contact?.brokerProfileMeta as BrokerOverlayMeta | null) ?? null,
  );
  const legacyGuess = legacySourceForBroker(buyer, scope);
  for (const [k, src] of Object.entries(sources)) {
    if (src.layer !== "own" || !src.legacy) continue;
    sources[k] = legacyGuess === "other" ? { source: "other", layer: "own", at: null } : { ...src, source: legacyGuess };
  }
  const fundsSrc = sources.liquidFunds;
  const fundsMasked = !!fundsSrc && fundsSrc.layer === "own" && (fundsSrc.source === "buyer" || fundsSrc.source === "other");
  const display = { ...profile, liquidFunds: fundsMasked ? buyerFundsRange(profile.liquidFunds) : profile.liquidFunds };
  return { profile, display, sources, fundsMasked, ownSources, legacyGuess };
}

/**
 * The buyer as any broker-facing response may carry it — a whitelist of the
 * broker-effective profile (funds masked). Never the raw buyer_users row.
 */
export function brokerBuyerCard(buyer: BuyerUser, contact: BrokerBuyerContact | null | undefined, scope: BrokerScope) {
  const { display, fundsMasked } = mergedForBroker(buyer, contact, scope);
  return {
    id: buyer.id,
    email: buyer.email,
    name: display.name,
    phone: display.phone,
    company: display.company,
    title: display.title,
    linkedinUrl: display.linkedinUrl,
    buyerType: display.buyerType,
    background: display.background,
    liquidFunds: display.liquidFunds,
    liquidFundsIsRange: fundsMasked,
    hasProofOfFunds: display.hasProofOfFunds,
    targetIndustries: display.targetIndustries ?? [],
    targetLocations: display.targetLocations ?? [],
    buyerCriteria: display.buyerCriteria ?? {},
    profileCompletionPct: display.profileCompletionPct,
    hasAccount: !!buyer.passwordHash,
    source: contact?.source ?? accountSourceForBroker(buyer, scope),
    createdAt: buyer.createdAt,
    lastLoginAt: buyer.lastLoginAt,
  };
}

/**
 * The own layer's per-field sources for the profile page: every stamp (scoped)
 * plus a best guess for values written before stamps existed.
 */
function ownLayerSources(buyer: BuyerUser, scoped: ScopedFieldSources, legacyGuess: string) {
  const out: Record<string, { source: string; at: string | null; dealId?: string | null; legacy?: boolean }> = {};
  for (const [k, s] of Object.entries(scoped)) out[k] = { ...s };
  const guess = () => ({ source: legacyGuess, at: null, legacy: legacyGuess !== "other" });
  for (const f of BUYER_PROFILE_FIELDS) {
    if (out[f]) continue;
    const v = (buyer as any)[f];
    if (f === "hasProofOfFunds" ? v === true : buyerValueIsSet(v)) out[f] = guess();
  }
  for (const [k, v] of Object.entries((buyer.buyerCriteria as Record<string, unknown> | null) ?? {})) {
    if (!out[`criteria.${k}`] && buyerValueIsSet(v)) out[`criteria.${k}`] = guess();
  }
  return out;
}

const label = (opts: readonly { value: string; label: string }[], v: string | null | undefined) =>
  (v && opts.find((o) => o.value === v)?.label) || null;

/** One-line summary of what the buyer answered on an NDA. */
export function ndaAnswersSummary(p: Partial<NdaBuyerProfile>): string {
  const price = p.priceMin != null || p.priceMax != null
    ? `${p.priceMin != null ? formatPrice(p.priceMin) : "up"} to ${p.priceMax != null ? formatPrice(p.priceMax) : "open"}`
    : null;
  return [
    label(NDA_BUYER_TYPES, p.buyerType),
    price,
    label(FUNDING_OPTIONS, p.funding),
    p.proofOfFunds ? `proof of funds: ${label(PROOF_OF_FUNDS_OPTIONS, p.proofOfFunds)?.toLowerCase()}` : null,
    label(TIMELINE_OPTIONS, p.timeline),
    p.operateSelf ? label(OPERATE_OPTIONS, p.operateSelf) : null,
  ].filter(Boolean).join(" · ");
}

function accessStatus(a: { revokedAt: Date | null; expiresAt: Date | null }): "active" | "expired" | "revoked" {
  if (a.revokedAt) return "revoked";
  if (a.expiresAt && new Date(a.expiresAt) < new Date()) return "expired";
  return "active";
}

const humanize = (k: string) => k.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

/** Loads everything the profile page and timeline need for one buyer. */
async function loadBuyerContext(brokerId: string, buyerId: string) {
  const buyer = await storage.getBuyerUser(buyerId);
  if (!buyer) return null;
  const [contact, brokerDeals] = await Promise.all([getContact(brokerId, buyerId), getBrokerDeals(brokerId)]);
  const dealById = new Map(brokerDeals.map((d) => [d.id, d]));
  const scope: BrokerScope = { brokerId, dealIds: new Set(dealById.keys()) };
  const accesses = await getBuyerAccessOnBrokerDeals(brokerDeals.map((d) => d.id), buyer);
  const accessIds = accesses.map((a) => a.id);
  const [engagement, decisions, questions, outreach, emails, approvals, titles] = await Promise.all([
    engagementByAccess(accessIds),
    decisionEvents(accessIds),
    questionsFor(accessIds),
    outreachFor(brokerId, buyerId),
    emailsFor(brokerId, buyerId),
    approvalsFor(brokerDeals.map((d) => d.id), buyer.email),
    sectionTitles(Array.from(new Set(accesses.map((a) => a.dealId)))),
  ]);
  return { buyer, contact: contact ?? null, scope, dealById, accesses, engagement, decisions, questions, outreach, emails, approvals, titles };
}

type Ctx = NonNullable<Awaited<ReturnType<typeof loadBuyerContext>>>;

function dealRows(ctx: Ctx) {
  return ctx.accesses.map((a) => {
    const deal = ctx.dealById.get(a.dealId);
    const eng = ctx.engagement.get(a.id);
    const qCount = ctx.questions.filter((q) => q.accessId === a.id).length;
    const deep = deal?.buyerDeepCheck?.results?.[ctx.buyer.id] ?? null;
    return {
      dealId: a.dealId,
      businessName: deal?.businessName ?? "Deal",
      accessId: a.id,
      accessLevel: a.accessLevel,
      status: accessStatus(a),
      grantedAt: a.createdAt,
      expiresAt: a.expiresAt,
      revokedAt: a.revokedAt,
      firstViewedAt: eng?.firstViewEventAt ?? a.firstViewedAt ?? null,
      lastAccessedAt: a.lastAccessedAt,
      views: a.viewCount && a.viewCount > 0 ? a.viewCount : eng?.views ?? 0,
      seconds: eng?.seconds ?? 0,
      sectionsViewed: eng?.sectionsViewed ?? 0,
      topSections: (eng?.topSections ?? []).map((s) => ({ ...s, title: ctx.titles.get(`${a.dealId}:${s.key}`) ?? humanize(s.key) })),
      questions: qCount,
      ndaSignedAt: a.ndaSignedAt,
      decision: a.decision && a.decision !== "under_review" ? a.decision : null,
      decisionAt: a.decisionAt,
      decisionNextStep: a.decisionNextStep,
      decisionReason: a.decisionReason,
      linkedToAccount: a.buyerUserId === ctx.buyer.id,
      deepCheck: deep ? { verdict: deep.verdict, fitScore: deep.fitScore, whyFit: deep.whyFit, watchOuts: deep.watchOuts, checkedAt: deep.checkedAt } : null,
    };
  });
}

function ndaAnswerRows(ctx: Ctx) {
  return ctx.accesses
    .filter((a) => a.ndaProfile)
    .map((a) => {
      const p = a.ndaProfile as NdaBuyerProfile & { submittedAt?: string };
      return {
        dealId: a.dealId,
        businessName: ctx.dealById.get(a.dealId)?.businessName ?? "Deal",
        signedAt: a.ndaSignedAt ?? (p.submittedAt ? new Date(p.submittedAt) : null),
        summary: ndaAnswersSummary(p),
        answers: p,
      };
    });
}

/** Fingerprint of everything the AI summary reads — a changed key means the summary is stale. */
export function summaryInput(ctx: Ctx) {
  const { display, fundsMasked } = mergedForBroker(ctx.buyer, ctx.contact, ctx.scope);
  const crm = (ctx.contact?.crmProfile as CrmBuyerProfile | null) ?? null;
  const deals = dealRows(ctx).map((d) => ({
    deal: d.businessName, access: d.accessLevel, status: d.status, views: d.views, minutes: Math.round(d.seconds / 60),
    sections: d.topSections.map((s) => s.title), questions: d.questions, ndaSigned: !!d.ndaSignedAt,
    decision: d.decision, nextStep: d.decisionNextStep, reason: d.decisionReason,
    aiFit: d.deepCheck ? `${d.deepCheck.verdict} (${d.deepCheck.fitScore}) — ${d.deepCheck.whyFit}` : null,
  }));
  const input = {
    profile: {
      name: display.name, company: display.company, title: display.title, buyerType: display.buyerType,
      background: display.background, liquidFunds: display.liquidFunds, liquidFundsIsRange: fundsMasked,
      proofOfFunds: display.hasProofOfFunds, targetIndustries: display.targetIndustries, targetLocations: display.targetLocations,
      criteria: display.buyerCriteria,
    },
    crm: crm ? { summary: crm.background ?? null, listingsAskedAbout: (crm.inquiries || []).slice(0, 10).map((q) => q.title) } : null,
    ndaAnswers: ndaAnswerRows(ctx).map((n) => ({ deal: n.businessName, summary: n.summary, lookingFor: n.answers.lookingFor, background: n.answers.background })),
    deals,
    needMoreTime: ctx.decisions.filter((d) => (d.eventData as any)?.decision === "need_more_time").length,
    questionsAsked: ctx.questions.slice(0, 8).map((q) => q.question.slice(0, 200)),
    emailsSent: ctx.emails.filter((e) => e.status === "sent").length + ctx.outreach.filter((o) => o.status === "sent").length,
    brokerNotes: ctx.contact?.notes ?? null,
    interest: ctx.contact?.interestStatus ?? null,
  };
  const key = createHash("sha1").update(JSON.stringify(input)).digest("hex").slice(0, 16);
  return { input, key };
}

export async function loadSummaryInput(brokerId: string, buyerId: string) {
  const ctx = await loadBuyerContext(brokerId, buyerId);
  if (!ctx) return null;
  return { ctx, ...summaryInput(ctx) };
}

/** GET /api/broker/buyers/:id/profile */
export async function buildBuyerProfileView(brokerId: string, buyerId: string) {
  const ctx = await loadBuyerContext(brokerId, buyerId);
  if (!ctx) return null;
  const { buyer, contact } = ctx;
  const { display, sources, fundsMasked, ownSources, legacyGuess } = mergedForBroker(buyer, contact, ctx.scope);
  const crm = (contact?.crmProfile as CrmBuyerProfile | null) ?? null;
  const overlay = (contact?.brokerProfile as BrokerBuyerOverlay | null) ?? {};
  const ai = (contact?.aiSummary as BuyerAiSummary | null) ?? null;
  const { key } = summaryInput(ctx);

  // The buyer's own layer as the broker may see it (self-entered or
  // unattributable funds → range).
  const ownFundsSource = ownSources.liquidFunds?.source ?? legacyGuess;
  const ownFundsMasked = ownFundsSource === "buyer" || ownFundsSource === "other";
  const own = {
    name: buyer.name, phone: buyer.phone, company: buyer.company, title: buyer.title, linkedinUrl: buyer.linkedinUrl,
    buyerType: buyer.buyerType, background: buyer.background,
    liquidFunds: ownFundsMasked ? buyerFundsRange(buyer.liquidFunds) : buyer.liquidFunds,
    liquidFundsIsRange: ownFundsMasked && !!buyer.liquidFunds,
    hasProofOfFunds: buyer.hasProofOfFunds,
    targetIndustries: buyer.targetIndustries ?? [], targetLocations: buyer.targetLocations ?? [],
    buyerCriteria: buyer.buyerCriteria ?? {},
  };

  return {
    buyer: {
      id: buyer.id,
      email: buyer.email,
      hasAccount: !!buyer.passwordHash,
      emailVerified: !!buyer.emailVerified,
      accountSource: accountSourceForBroker(buyer, ctx.scope),
      createdAt: buyer.createdAt,
      lastLoginAt: buyer.lastLoginAt,
      profileCompletionPct: Math.max(calculateBuyerProfileCompletion(display), display.profileCompletionPct ?? 0),
    },
    profile: {
      name: display.name, phone: display.phone, company: display.company, title: display.title,
      linkedinUrl: display.linkedinUrl, buyerType: display.buyerType, background: display.background,
      liquidFunds: display.liquidFunds, liquidFundsIsRange: fundsMasked,
      hasProofOfFunds: display.hasProofOfFunds,
      targetIndustries: display.targetIndustries ?? [], targetLocations: display.targetLocations ?? [],
      buyerCriteria: display.buyerCriteria ?? {},
    },
    sources: sources as Record<string, MergedFieldSource>,
    layers: {
      own,
      ownSources: ownLayerSources(buyer, ownSources, legacyGuess),
      crm: crm ? {
        provider: contact?.crmProvider ?? "pipedrive",
        recordId: contact?.crmRecordId ?? null,
        syncedAt: contact?.crmSyncedAt ?? null,
        profile: crm,
      } : null,
      overlay,
      overlayMeta: contact?.brokerProfileMeta ?? {},
    },
    contact: {
      id: contact?.id ?? null,
      source: contact?.source ?? null,
      tags: (contact?.tags as string[] | null) ?? [],
      notes: contact?.notes ?? null,
      interestStatus: contact?.interestStatus ?? null,
      addedAt: contact?.addedAt ?? buyer.createdAt,
      aiSummary: ai ? { text: ai.text, at: ai.at, stale: ai.key !== key } : null,
    },
    deals: dealRows(ctx),
    ndaAnswers: ndaAnswerRows(ctx),
    approvals: ctx.approvals.map((r) => ({
      ...r,
      businessName: ctx.dealById.get(r.dealId)?.businessName ?? "Deal",
    })),
    emails: ctx.emails.slice(0, 20).map((e) => ({
      id: e.id, dealId: e.dealId, subject: e.subject, status: e.status, sentAt: e.sentAt, createdAt: e.createdAt,
    })),
  };
}

export interface TimelineEvent {
  id: string;
  at: string;
  kind:
    | "added" | "account" | "crm_synced" | "access_granted" | "access_extended" | "access_level" | "access_revoked"
    | "link_expired" | "first_view" | "viewing" | "nda_signed" | "decision" | "question" | "outreach" | "email"
    | "approval" | "profile_edit" | "login";
  title: string;
  detail?: string | null;
  dealId?: string | null;
  dealName?: string | null;
  tone?: "positive" | "negative" | "neutral";
}

const CONTACT_SOURCE_TEXT: Record<string, string> = {
  manual: "You added them", csv: "Imported from a CSV", crm: "Imported from your CRM", deal: "Granted access to one of your deals",
  signup: "Signed up on Cimple", nda: "Signed an NDA on one of your deals",
};
const DECISION_TEXT: Record<string, { title: string; tone: TimelineEvent["tone"] }> = {
  interested: { title: "Interested in moving forward", tone: "positive" },
  not_interested: { title: "Not interested", tone: "negative" },
  need_more_time: { title: "Asked for more time", tone: "neutral" },
  lapsed: { title: "Decision lapsed (no response)", tone: "negative" },
};
const NEXT_STEP_TEXT: Record<string, string> = {
  seller_call: "wants a call with the seller", management_meeting: "wants a management meeting", site_visit: "wants a site visit",
  loi: "ready to submit an LOI", more_info: "wants more information", other: "other next step",
};
const FIELD_LABEL: Record<string, string> = {
  name: "Name", phone: "Phone", company: "Company", title: "Title", linkedinUrl: "LinkedIn", buyerType: "Buyer type",
  background: "Background", liquidFunds: "Liquid funds", hasProofOfFunds: "Proof of funds",
  targetIndustries: "Target industries", targetLocations: "Target locations",
};
const fieldLabel = (k: string) => FIELD_LABEL[k] ?? BUYER_CRITERIA_FIELDS[k.replace(/^criteria\./, "")]?.label ?? humanize(k.replace(/^criteria\./, ""));
const fmtDuration = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 60 ? `${Math.round(s / 60)} min` : `${s}s`);
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** GET /api/broker/buyers/:id/timeline — newest first. */
export async function buildBuyerTimeline(brokerId: string, buyerId: string): Promise<TimelineEvent[] | null> {
  const ctx = await loadBuyerContext(brokerId, buyerId);
  if (!ctx) return null;
  const { buyer, contact } = ctx;
  const ev: TimelineEvent[] = [];
  const push = (e: Omit<TimelineEvent, "at"> & { at: Date | string | null | undefined }) => {
    const at = iso(e.at);
    if (at) ev.push({ ...e, at });
  };
  const dealName = (id: string | null | undefined) => (id ? ctx.dealById.get(id)?.businessName ?? null : null);

  if (contact) push({ id: `added-${contact.id}`, at: contact.addedAt, kind: "added", title: "Added to your buyers", detail: CONTACT_SOURCE_TEXT[contact.source] ?? null });
  if (buyer.source === "self_signup") push({ id: "account", at: buyer.createdAt, kind: "account", title: "Created a Cimple buyer account" });
  if (buyer.lastLoginAt) push({ id: "login", at: buyer.lastLoginAt, kind: "login", title: "Last signed in to Cimple" });
  if (contact?.crmSyncedAt) {
    push({ id: "crm", at: contact.crmSyncedAt, kind: "crm_synced", title: `Profile read from ${contact.crmProvider === "pipedrive" || !contact.crmProvider ? "Pipedrive" : contact.crmProvider}`,
      detail: (() => { const n = (contact.crmProfile as CrmBuyerProfile | null)?.inquiries?.length ?? 0; return n ? `${n} listing enquir${n === 1 ? "y" : "ies"} on record` : null; })() });
  }

  for (const a of ctx.accesses) {
    const d = dealName(a.dealId);
    const eng = ctx.engagement.get(a.id);
    push({ id: `grant-${a.id}`, at: a.createdAt, kind: "access_granted", title: `Given ${buyerAccessPhrase(a.accessLevel)} access`, dealId: a.dealId, dealName: d });
    ((a.accessEvents as BuyerAccessEvent[] | null) ?? []).forEach((e, i) => {
      if (e.type === "extended") push({ id: `ext-${a.id}-${i}`, at: e.at, kind: "access_extended", title: "Access extended", detail: e.expiresAt ? `Now expires ${new Date(e.expiresAt).toDateString()}` : null, dealId: a.dealId, dealName: d });
      if (e.type === "level_changed") push({ id: `lvl-${a.id}-${i}`, at: e.at, kind: "access_level", title: e.accessLevel ? `Access changed to ${buyerAccessPhrase(e.accessLevel)}` : "Access level changed", dealId: a.dealId, dealName: d });
    });
    if (a.revokedAt) push({ id: `rev-${a.id}`, at: a.revokedAt, kind: "access_revoked", title: "Access revoked", dealId: a.dealId, dealName: d, tone: "negative" });
    else if (a.expiresAt && new Date(a.expiresAt) < new Date()) push({ id: `exp-${a.id}`, at: a.expiresAt, kind: "link_expired", title: "Link expired", dealId: a.dealId, dealName: d });
    // The first "view" event is the true first open ("need more time" resets firstViewedAt for the reminder clock).
    const firstView = eng?.firstViewEventAt ?? a.firstViewedAt ?? null;
    if (firstView) push({ id: `fv-${a.id}`, at: firstView, kind: "first_view", title: "Opened the CIM for the first time", dealId: a.dealId, dealName: d });
    const views = a.viewCount && a.viewCount > 0 ? a.viewCount : eng?.views ?? 0;
    const lastSeen = a.lastAccessedAt ?? eng?.lastEventAt ?? null;
    if (lastSeen && (views > 1 || (eng?.seconds ?? 0) > 0)) {
      const tops = (eng?.topSections ?? []).map((s) => ctx.titles.get(`${a.dealId}:${s.key}`) ?? humanize(s.key));
      push({
        id: `view-${a.id}`, at: lastSeen, kind: "viewing",
        title: `${views} visit${views === 1 ? "" : "s"} to the CIM${eng?.seconds ? ` · ${fmtDuration(eng.seconds)} reading` : ""}`,
        detail: tops.length ? `Spent most time on ${tops.join(", ")}` : null, dealId: a.dealId, dealName: d,
      });
    }
    if (a.ndaSignedAt) {
      const summary = a.ndaProfile ? ndaAnswersSummary(a.ndaProfile as NdaBuyerProfile) : null;
      push({ id: `nda-${a.id}`, at: a.ndaSignedAt, kind: "nda_signed", title: "Signed the NDA", detail: summary || null, dealId: a.dealId, dealName: d, tone: "positive" });
    }
  }

  // Decisions: every submitted decision (incl. "need more time"); fall back to
  // the access row for decisions recorded before the event stream existed.
  const seenDecisionAccess = new Set<string>();
  ctx.decisions.forEach((e, i) => {
    const data = (e.eventData as { decision?: string; nextStep?: string | null } | null) ?? {};
    const a = ctx.accesses.find((x) => x.id === e.accessId);
    if (!data.decision || !a) return;
    seenDecisionAccess.add(a.id);
    const t = DECISION_TEXT[data.decision] ?? { title: humanize(data.decision), tone: "neutral" as const };
    const reason = data.decision !== "need_more_time" && a.decision === data.decision ? a.decisionReason : null;
    push({ id: `dec-${a.id}-${i}`, at: e.createdAt, kind: "decision", title: t.title, tone: t.tone,
      detail: [data.nextStep ? NEXT_STEP_TEXT[data.nextStep] ?? data.nextStep : null, reason ? `“${reason.slice(0, 240)}”` : null].filter(Boolean).join(" · ") || null,
      dealId: a.dealId, dealName: dealName(a.dealId) });
  });
  for (const a of ctx.accesses) {
    if (seenDecisionAccess.has(a.id) || !a.decisionAt || !a.decision || a.decision === "under_review") continue;
    const t = DECISION_TEXT[a.decision] ?? { title: humanize(a.decision), tone: "neutral" as const };
    push({ id: `dec-${a.id}`, at: a.decisionAt, kind: "decision", title: t.title, tone: t.tone,
      detail: [a.decisionNextStep ? NEXT_STEP_TEXT[a.decisionNextStep] ?? a.decisionNextStep : null, a.decisionReason ? `“${a.decisionReason.slice(0, 240)}”` : null].filter(Boolean).join(" · ") || null,
      dealId: a.dealId, dealName: dealName(a.dealId) });
  }

  for (const q of ctx.questions) {
    push({ id: `q-${q.id}`, at: q.createdAt, kind: "question", title: "Asked a question", detail: `“${q.question.slice(0, 280)}”${q.status === "published" ? " — answered" : ""}`, dealId: q.dealId, dealName: dealName(q.dealId) });
  }
  for (const o of ctx.outreach) {
    push({ id: `o-${o.id}`, at: o.sentAt ?? o.createdAt, kind: "outreach", title: o.status === "sent" ? "You emailed them about a listing" : o.status === "draft" ? "Outreach drafted" : "Outreach email not delivered",
      detail: o.subject, dealId: o.dealId, dealName: dealName(o.dealId), tone: o.status === "failed" ? "negative" : "neutral" });
  }
  for (const e of ctx.emails) {
    push({ id: `e-${e.id}`, at: e.sentAt ?? e.createdAt, kind: "email", title: e.status === "sent" ? "You emailed them" : "Email not delivered",
      detail: e.subject + (e.status !== "sent" && e.errorMessage ? ` — ${e.errorMessage}` : ""), dealId: e.dealId, dealName: dealName(e.dealId), tone: e.status === "sent" ? "neutral" : "negative" });
  }
  for (const r of ctx.approvals) {
    const d = dealName(r.dealId);
    push({ id: `ap-${r.id}`, at: r.createdAt, kind: "approval", title: "Submitted for approval", detail: r.background ? r.background.slice(0, 200) : null, dealId: r.dealId, dealName: d });
    if (r.grantedAt) push({ id: `apg-${r.id}`, at: r.grantedAt, kind: "approval", title: "Approved by the seller — access granted", dealId: r.dealId, dealName: d, tone: "positive" });
    else if (r.status?.startsWith("rejected")) push({ id: `apr-${r.id}`, at: r.sellerReviewedAt ?? r.brokerReviewedAt ?? r.createdAt, kind: "approval", title: r.status === "rejected_by_seller" ? "Declined by the seller" : "Declined by you", detail: r.rejectionReason ?? null, dealId: r.dealId, dealName: d, tone: "negative" });
  }

  // Profile edits — the broker's own (overlay) and writes to the buyer's row,
  // grouped by who + when (same minute) so one save reads as one event.
  const groups = new Map<string, { at: string; who: string; fields: string[]; dealId?: string | null }>();
  const addEdit = (who: string, key: string, at: string | null | undefined, dealId?: string | null) => {
    if (!at) return;
    const g = `${who}|${at.slice(0, 16)}|${dealId ?? ""}`;
    const entry = groups.get(g) ?? { at, who, fields: [], dealId };
    entry.fields.push(fieldLabel(key));
    groups.set(g, entry);
  };
  for (const [k, m] of Object.entries((contact?.brokerProfileMeta as BrokerOverlayMeta | null) ?? {})) addEdit("broker", k, m?.at);
  // Scoped: another brokerage's writes on the shared row read as a neutral
  // "profile updated" with no deal attached.
  for (const [k, s] of Object.entries(scopeFieldSources(buyer, contact, ctx.scope))) addEdit(s.source, k, s.at, "dealId" in s ? s.dealId : null);
  const WHO: Record<string, string> = {
    broker: "You edited", buyer: "They updated their profile", nda: "Profile filled in from their NDA answers", broker_import: "You added profile details",
    csv: "Profile details imported from your CSV", crm: "Contact details copied from your CRM", approval: "Profile details from an approval request",
    other: "Their Cimple profile was updated",
  };
  for (const [g, e] of Array.from(groups.entries())) {
    // An NDA write is already on the timeline as "Signed the NDA".
    if (e.who === "nda" && ctx.accesses.some((a) => a.ndaSignedAt && Math.abs(new Date(a.ndaSignedAt).getTime() - new Date(e.at).getTime()) < 5 * 60_000)) continue;
    const uniq = Array.from(new Set(e.fields));
    push({ id: `edit-${g}`, at: e.at, kind: "profile_edit", title: WHO[e.who] ?? "Profile updated",
      detail: uniq.slice(0, 6).join(", ") + (uniq.length > 6 ? ` and ${uniq.length - 6} more` : ""), dealId: e.dealId ?? null, dealName: dealName(e.dealId) });
  }

  ev.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return ev.slice(0, 250);
}

/** Where a buyer came into the broker's list, in the Buyers page's vocabulary. */
function listSource(contact: BrokerBuyerContact | null, buyer: BuyerUser, hasDeals: boolean, scope: BrokerScope): string {
  const s = contact?.source;
  if (s === "manual" || s === "csv" || s === "crm") return s;
  // A buyer who registered on Cimple themselves, then reached the broker through a deal / NDA.
  if (buyer.source === "self_signup" && buyer.passwordHash) return "self_signup";
  if (s === "nda") return s;
  if (hasDeals || s === "deal") return "deal";
  // How the account started — only when it started with this broker.
  const started = accountSourceForBroker(buyer, scope);
  if (started === "crm_imported") return "crm";
  if (started === "nda_signed") return "nda";
  return "manual";
}

/** GET /api/broker/buyers — the broker's list, merged (3 layers) and scored with engagement. */
export async function buildBrokerBuyerList(brokerId: string) {
  const [list, scope] = await Promise.all([storage.getBrokerBuyerContactList(brokerId), loadBrokerScope(brokerId)]);
  const engagement = await brokerBuyerEngagement(brokerId, list.map((l) => l.buyerUser));
  return list.map(({ buyerUser: own, contact, dealCount, lastActivityAt }) => {
    const { display, fundsMasked } = mergedForBroker(own, contact, scope);
    const e = engagement.get(own.id);
    const score = calculateQualifiedLeadScore({
      buyer: { ...display, hasProofOfFunds: !!display.hasProofOfFunds },
      engagement: e ? { viewCount: e.views, sectionsViewed: e.sectionsViewed, totalTimeSeconds: e.seconds, questionCount: e.questions, ndaSigned: e.ndaSigned } : null,
    });
    const deals = Math.max(dealCount, e?.dealIds.size ?? 0);
    const last = [lastActivityAt, e?.lastActivityAt ?? null].filter(Boolean).sort((a, b) => +new Date(b!) - +new Date(a!))[0] ?? null;
    return {
      id: own.id,
      email: own.email,
      name: display.name,
      phone: display.phone,
      company: display.company,
      title: display.title,
      linkedinUrl: display.linkedinUrl,
      buyerType: display.buyerType,
      background: display.background,
      liquidFunds: display.liquidFunds,
      liquidFundsIsRange: fundsMasked,
      hasProofOfFunds: !!display.hasProofOfFunds,
      targetIndustries: display.targetIndustries,
      targetLocations: display.targetLocations,
      profileCompletionPct: display.profileCompletionPct,
      source: listSource(contact, own, deals > 0, scope),
      hasAccount: !!own.passwordHash,
      tags: contact?.tags ?? [],
      notes: contact?.notes ?? null,
      interestStatus: contact?.interestStatus ?? null,
      contactId: contact?.id ?? null,
      crmSynced: !!contact?.crmProfile,
      crmProvider: contact?.crmProvider ?? null,
      addedAt: contact?.addedAt ?? own.createdAt,
      dealCount: deals,
      lastActivityAt: last,
      engagement: e ? { views: e.views, seconds: e.seconds, questions: e.questions, ndaSigned: e.ndaSigned } : null,
      latestDecision: e?.latestDecision ?? null,
      qualifiedScore: { total: score.total, tier: score.tier, reasons: score.reasons },
    };
  });
}
