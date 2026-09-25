/**
 * Applies the buyer profile captured at NDA signing (shared/nda-buyer-profile.ts).
 *
 * The buyer typed these answers themselves, so they go on the buyer's own
 * profile (buyer_users) — the one they see and edit on /buyer/profile — as
 * well as on this deal's access row (ndaProfile = the record of what they
 * told us when they signed). The free-text "what are you looking for" is
 * turned into matching criteria (industries, locations, size ranges) by the
 * supporting model in the background, so the NDA screen never waits on it.
 *
 * No email is sent to anyone here.
 */
import Anthropic from "@anthropic-ai/sdk";
import { storage } from "../storage";
import { agentConfig } from "../interview/config/load-config";
import { initialFieldSources, withFieldSources, type BuyerAccess, type BuyerUser } from "@shared/schema";
import { storedBuyerType, type NdaBuyerProfile } from "@shared/nda-buyer-profile";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function resolveBuyerUser(access: BuyerAccess, profile: NdaBuyerProfile | null, brokerId: string | null): Promise<BuyerUser | undefined> {
  if (access.buyerUserId) {
    const u = await storage.getBuyerUser(access.buyerUserId);
    if (u) return u;
  }
  const email = access.buyerEmail.toLowerCase().trim();
  const existing = await storage.getBuyerUserByEmail(email);
  if (existing || !profile) return existing;
  return storage.createBuyerUser({
    email, passwordHash: null, name: profile.name, phone: profile.phone, company: profile.company ?? null,
    title: profile.title ?? null, linkedinUrl: null, buyerCriteria: {}, targetIndustries: [] as any,
    targetLocations: [] as any, buyerType: null, background: null, liquidFunds: null, hasProofOfFunds: false,
    profileCompletionPct: 0, emailVerified: false, source: "nda_signed", invitedByBroker: brokerId,
    invitedByDeal: access.dealId, resetToken: null, resetTokenExpiresAt: null,
    fieldSources: initialFieldSources({ name: profile.name, phone: profile.phone, company: profile.company ?? null, title: profile.title ?? null }, "nda", access.dealId, brokerId),
  } as any);
}

/**
 * Record the signed NDA's profile. With `profile` null the buyer confirmed
 * the profile already on file — only the links are made.
 */
export async function applyNdaProfile(access: BuyerAccess, profile: NdaBuyerProfile | null): Promise<void> {
  const deal = await storage.getDeal(access.dealId);
  const brokerId = deal?.brokerId ?? null;
  let buyer = await resolveBuyerUser(access, profile, brokerId);

  if (buyer && profile) {
    const criteria: Record<string, any> = { ...((buyer.buyerCriteria as Record<string, any>) || {}) };
    if (profile.priceMin != null) criteria.askingPriceMin = String(Math.round(profile.priceMin));
    else delete criteria.askingPriceMin;
    if (profile.priceMax != null) criteria.askingPriceMax = String(Math.round(profile.priceMax));
    else delete criteria.askingPriceMax;
    criteria.lookingFor = profile.lookingFor;
    if (profile.dealRole === "platform") { criteria.platformAcquisition = true; criteria.addOnAcquisition = false; }
    if (profile.dealRole === "add_on") { criteria.addOnAcquisition = true; criteria.platformAcquisition = false; }
    if (profile.dealRole === "either") { criteria.addOnAcquisition = true; criteria.platformAcquisition = true; }
    if (profile.operateSelf === "no" || profile.operateSelf === "hire_manager") criteria.managementTeamRequired = true;
    const updates: Partial<BuyerUser> = {
      name: profile.name,
      phone: profile.phone,
      company: profile.company || buyer.company,
      title: profile.title || buyer.title,
      buyerType: storedBuyerType(profile),
      background: profile.background,
      buyerCriteria: criteria as any,
    };
    // Proof of funds is tri-state: "can provide on request" says nothing yet.
    if (profile.proofOfFunds === "yes") updates.hasProofOfFunds = true;
    if (profile.proofOfFunds === "no") updates.hasProofOfFunds = false;
    // Every field this changes is stamped as coming from this deal's NDA.
    buyer = (await storage.updateBuyerUser(buyer.id, withFieldSources(buyer, updates, "nda", access.dealId, brokerId))) || buyer;
  }

  await storage.updateBuyerAccess(access.id, {
    ...(buyer ? { buyerUserId: buyer.id } : {}),
    ...(profile ? {
      buyerName: profile.name,
      buyerCompany: profile.company ?? access.buyerCompany,
      buyerType: storedBuyerType(profile),
      proofOfFunds: profile.proofOfFunds === "yes",
      ndaProfile: { ...profile, submittedAt: new Date().toISOString() },
      buyerCriteria: buyer?.buyerCriteria ?? access.buyerCriteria,
    } : {}),
  } as any);

  if (buyer && brokerId) {
    await storage.upsertBrokerBuyerContact({ brokerId, buyerUserId: buyer.id, source: "nda", tags: [] as any, notes: null } as any);
  }

  if (buyer && profile) {
    const buyerId = buyer.id;
    void extractCriteria(profile)
      .then(async (x) => {
        if (!x) return;
        const current = await storage.getBuyerUser(buyerId);
        if (!current) return;
        // Their newest words win for anything they mentioned.
        const criteria = { ...((current.buyerCriteria as Record<string, any>) || {}), ...x.criteria };
        await storage.updateBuyerUser(buyerId, withFieldSources(current, {
          targetIndustries: (x.targetIndustries.length ? x.targetIndustries : current.targetIndustries) as any,
          targetLocations: (x.targetLocations.length ? x.targetLocations : current.targetLocations) as any,
          liquidFunds: current.liquidFunds || x.liquidFunds || null,
          buyerCriteria: criteria as any,
        }, "nda", access.dealId, brokerId));
      })
      .catch((err) => console.error("[nda-profile] criteria extraction failed:", err));
  }
}

const CRITERIA_TOOL: Anthropic.Tool = {
  name: "buyer_criteria",
  description: "Structured acquisition criteria from a buyer's own description.",
  input_schema: {
    type: "object",
    properties: {
      targetIndustries: { type: "array", items: { type: "string" }, description: "Industries they want, in plain words (e.g. 'HVAC', 'Dental practices')." },
      targetLocations: { type: "array", items: { type: "string" }, description: "Regions/provinces/states/cities they'd buy in." },
      liquidFunds: { type: ["string", "null"], description: "Cash/equity they say they have, e.g. '$500K'." },
      revenueMin: { type: ["number", "null"] }, revenueMax: { type: ["number", "null"] },
      sdeMin: { type: ["number", "null"] }, sdeMax: { type: ["number", "null"] },
      ebitdaMin: { type: ["number", "null"] }, ebitdaMax: { type: ["number", "null"] },
      minEmployees: { type: ["number", "null"] }, maxEmployees: { type: ["number", "null"] },
      excludedIndustries: { type: "array", items: { type: "string" } },
    },
    required: ["targetIndustries", "targetLocations", "excludedIndustries"],
  },
};

async function extractCriteria(p: NdaBuyerProfile): Promise<{ targetIndustries: string[]; targetLocations: string[]; liquidFunds: string | null; criteria: Record<string, any> } | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const text = [
    `Buyer type: ${p.buyerType}${p.financialKind ? ` (${p.financialKind})` : ""}`,
    `Looking for: ${p.lookingFor}`,
    `Background: ${p.background}`,
    p.checkSize ? `Typical cheque size: ${p.checkSize}` : "",
    p.fitReason ? `How it would fit: ${p.fitReason}` : "",
  ].filter(Boolean).join("\n");
  const response = await anthropic.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 800,
    temperature: 0,
    tools: [CRITERIA_TOOL],
    tool_choice: { type: "tool", name: "buyer_criteria" },
    system: "Extract a business buyer's acquisition criteria from what they wrote. Only what they actually said — never invent ranges. Dollar amounts as plain numbers ('$2M' → 2000000). 'SDE', 'cash flow' and 'owner earnings' are SDE; 'EBITDA' is EBITDA; 'sales'/'revenue' is revenue.",
    messages: [{ role: "user", content: text }],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") return null;
  const x = block.input as Record<string, any>;
  const criteria: Record<string, any> = {};
  for (const k of ["revenueMin", "revenueMax", "sdeMin", "sdeMax", "ebitdaMin", "ebitdaMax"]) {
    if (typeof x[k] === "number" && x[k] > 0) criteria[k] = String(Math.round(x[k]));
  }
  for (const k of ["minEmployees", "maxEmployees"]) if (typeof x[k] === "number" && x[k] > 0) criteria[k] = Math.round(x[k]);
  const strs = (v: unknown) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 12) : []);
  if (strs(x.excludedIndustries).length) criteria.excludedIndustries = strs(x.excludedIndustries);
  return { targetIndustries: strs(x.targetIndustries), targetLocations: strs(x.targetLocations), liquidFunds: typeof x.liquidFunds === "string" ? x.liquidFunds : null, criteria };
}
