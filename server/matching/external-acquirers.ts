/**
 * Outside acquirers — likely buyers who are NOT in the broker's list yet.
 *
 * The supporting model researches the web (Anthropic web search) for
 * strategic acquirers consolidating in the deal's industry and region, PE
 * platforms and family offices active in the space, and returns a cited
 * list. Two anti-hallucination rules:
 *   - every source URL must be one the search actually returned;
 *   - a contact (email/phone/page) is kept only if it appears verbatim in
 *     text the search cited — contact details are never guessed.
 * The research brief is blind: industry, region (province/state), size bands
 * and qualities only — never the business name, owner or city, so nothing
 * identifying is sent into web searches.
 *
 * Broker-facing only. Nothing is sent to anyone; the broker decides whom to
 * contact.
 */
import Anthropic from "@anthropic-ai/sdk";
import { storage } from "../storage";
import { agentConfig } from "../interview/config/load-config";
import type { Deal, ExternalAcquirer, ExternalAcquirerSearch } from "@shared/schema";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const running = new Set<string>();

const PROVINCES: Record<string, string> = { ON: "Ontario", QC: "Quebec", BC: "British Columbia", AB: "Alberta", MB: "Manitoba", SK: "Saskatchewan", NS: "Nova Scotia", NB: "New Brunswick", NL: "Newfoundland and Labrador", PE: "Prince Edward Island" };
const REGION_RE = /\b(Ontario|Quebec|British Columbia|Alberta|Manitoba|Saskatchewan|Nova Scotia|New Brunswick|Newfoundland|Prince Edward Island|Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|ON|QC|BC|AB|MB|SK|NS|NB|NL|PE)\b/;

const txt = (v: unknown): string => (typeof v === "string" ? v : v && typeof v === "object" && "value" in (v as any) ? txt((v as any).value) : "");
function band(raw: string): string | null {
  const m = raw.replace(/,/g, "").match(/\$?\s*([\d.]+)\s*(m|mm|million|k|thousand)?/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const u = (m[2] || "").toLowerCase();
  if (u.startsWith("m")) n *= 1_000_000; else if (u.startsWith("k") || u === "thousand") n *= 1000;
  if (!n || n < 10_000) return null;
  if (n < 500_000) return "under $500K";
  if (n < 1_000_000) return "$500K–$1M";
  if (n < 2_000_000) return "$1M–$2M";
  if (n < 5_000_000) return "$2M–$5M";
  if (n < 10_000_000) return "$5M–$10M";
  if (n < 25_000_000) return "$10M–$25M";
  return "$25M+";
}

/** Blind research brief — nothing that identifies the business. */
export function blindBrief(deal: Deal): { brief: string; region: string | null } {
  const info = ((deal as any).extractedInfo || {}) as Record<string, unknown>;
  const locText = [txt(info.locationSite), txt(info.location), txt(info.leaseAddress)].join(" ");
  const m = REGION_RE.exec(locText);
  const region = m ? PROVINCES[m[1]] ?? m[1] : null;
  const country = region && Object.values(PROVINCES).includes(region) ? "Canada" : region ? "United States" : null;
  const lines = [
    `Industry: ${deal.industry || "unknown"}${(deal as any).subIndustry ? ` — ${(deal as any).subIndustry}` : ""}`,
    txt(info.businessType) ? `Business type: ${txt(info.businessType).slice(0, 200)}` : "",
    region ? `Region: ${region}${country ? `, ${country}` : ""}` : "",
    band(txt(info.annualRevenue)) ? `Revenue: ${band(txt(info.annualRevenue))}` : "",
    band(txt(info.sde)) ? `SDE: ${band(txt(info.sde))}` : "",
    band(txt(info.ebitda)) ? `EBITDA: ${band(txt(info.ebitda))}` : "",
    txt(info.employees) ? `Employees: ${txt(info.employees).replace(/[^0-9–-]+/g, " ").trim().split(" ")[0] || "n/a"}` : "",
    txt(info.revenueStreams) ? `Services / revenue streams: ${txt(info.revenueStreams).slice(0, 300)}` : "",
    txt(info.idealBuyer) ? `SELLER'S BUYER PREFERENCES (binding): ${txt(info.idealBuyer).slice(0, 400)}` : "",
  ];
  return { brief: lines.filter(Boolean).join("\n"), region };
}

const REPORT_TOOL = {
  name: "report_acquirers",
  description: "Structured list of likely acquirers found in the research.",
  input_schema: {
    type: "object",
    properties: {
      acquirers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["strategic", "private_equity", "family_office", "search_fund", "other"] },
            headquarters: { type: ["string", "null"] },
            website: { type: ["string", "null"] },
            whyInterested: { type: "string", description: "1-2 sentences: the specific evidence they'd want this business (e.g. acquired X similar businesses in the region in 2025; platform in this sector)." },
            evidence: { type: "array", items: { type: "string" }, description: "Up to 3 concrete facts, e.g. 'Acquired MCA Dental Group (27 clinics, ON/QC), Oct 2025'." },
            contact: { type: ["string", "null"], description: "ONLY an email/phone/contact page that appears in the research text. Otherwise null. Never guess." },
            sources: { type: "array", items: { type: "string" }, description: "URLs from the research that support this entry." },
          },
          required: ["name", "type", "whyInterested", "evidence", "sources"],
        },
      },
      note: { type: ["string", "null"], description: "When few or no organisations fit (e.g. the seller's preferences point to individual buyers who aren't publicly visible), 1-2 sentences saying why. Otherwise null." },
      channels: {
        type: "array",
        description: "Up to 5 practical ways to reach the kind of buyer the seller prefers when they aren't findable as organisations (e.g. dental-practice lenders' acquisition teams, professional associations, alumni networks, specialist accountants). NEVER other business brokers, brokerages or M&A advisors.",
        items: { type: "object", properties: { name: { type: "string" }, how: { type: "string" }, url: { type: ["string", "null"] } }, required: ["name", "how"] },
      },
    },
    required: ["acquirers"],
  },
};

export function isExternalSearchRunning(dealId: string) {
  return running.has(dealId);
}

export async function startExternalAcquirerSearch(dealId: string, opts: { includeExcluded?: boolean } = {}): Promise<{ started: boolean; reason?: string }> {
  if (running.has(dealId)) return { started: false, reason: "already_running" };
  const deal = await storage.getDeal(dealId);
  if (!deal) return { started: false, reason: "not_found" };
  if (!process.env.ANTHROPIC_API_KEY) return { started: false, reason: "no_ai" };
  running.add(dealId);
  const state: ExternalAcquirerSearch = { status: "running", startedAt: new Date().toISOString(), results: ((deal.externalAcquirers as ExternalAcquirerSearch | null)?.results) || [] };
  await storage.updateDeal(dealId, { externalAcquirers: state } as any);
  void research(deal, !!opts.includeExcluded)
    .then(async ({ results, mode, note, channels }) => {
      await storage.updateDeal(dealId, { externalAcquirers: { status: "done", startedAt: state.startedAt, finishedAt: new Date().toISOString(), mode, results, note, channels, includeExcluded: !!opts.includeExcluded } } as any);
    })
    .catch(async (err) => {
      console.error("[external-acquirers] failed:", err);
      await storage.updateDeal(dealId, { externalAcquirers: { ...state, status: "failed", finishedAt: new Date().toISOString(), error: "The research didn't finish — try again in a minute." } } as any);
    })
    .finally(() => running.delete(dealId));
  return { started: true };
}

async function research(deal: Deal, includeExcluded: boolean): Promise<{ results: ExternalAcquirer[]; mode: "web" | "knowledge"; note: string | null; channels: Array<{ name: string; how: string; url?: string | null }> }> {
  let { brief, region } = blindBrief(deal);
  if (includeExcluded) brief = brief.replace("SELLER'S BUYER PREFERENCES (binding):", "Seller's stated preference (broker asked to include ALL buyer types anyway — list them, and flag any that conflict with it):");
  const system = [
    "You are an M&A research analyst building a buyer list for a business for sale. Find 8-15 organisations likely to acquire it, beyond individual buyers:",
    "(1) strategic acquirers/consolidators actively buying similar businesses — especially in this region; (2) private-equity firms with a platform in this sector (add-on) or a stated thesis for it; (3) family offices or holding companies known to buy in this space.",
    "Prioritise evidence of RECENT acquisitions (last ~3 years) of similar-sized businesses. Exclude business brokers, M&A advisors and marketplaces.",
    "Never suggest other business brokers, brokerages or M&A advisors as buyers or as channels.",
    "The seller's buyer preferences are BINDING (unless the profile says the broker asked to include all types): never list a type of buyer the seller has ruled out (e.g. if they don't want to sell to a DSO/corporate consolidator/PE, list none of those). Instead look for the kinds of buyers they prefer — e.g. independent multi-location owner-operators or regional groups known to be adding locations — and say how each fits the preference.",
    "Never search for or mention the specific business — you only know its profile. For contacts, only report an email/phone/contact page you actually saw on the organisation's site or a cited page; otherwise leave it out.",
    "Finish with a concise write-up per organisation: name, type, HQ, website, why they'd be interested with specific evidence, any published contact, and the source URLs.",
  ].join(" ");
  const messages: any[] = [{ role: "user", content: `Business profile (confidential — do not search for the business itself):\n${brief}\n\nResearch likely acquirers${region ? `, with priority on ${region}` : ""}.` }];

  const urls = new Set<string>();
  const citedText: string[] = [];
  let finalText = "";
  let mode: "web" | "knowledge" = "web";
  // Bounded research: ~8 searches, at most one continuation, 4 minutes overall.
  const deadline = Date.now() + 4 * 60_000;
  try {
    for (let turn = 0; turn < 2 && Date.now() < deadline; turn++) {
      const r: any = await anthropic.messages.create({
        model: agentConfig.models.supportingAgents,
        max_tokens: 5000,
        system,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 } as any],
        messages,
      } as any, { timeout: Math.max(30_000, deadline - Date.now()) });
      for (const b of r.content as any[]) {
        if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
          for (const item of b.content) if (item?.url) urls.add(String(item.url));
        }
        if (b.type === "text") {
          finalText += b.text;
          for (const c of b.citations || []) {
            if (c?.url) urls.add(String(c.url));
            if (c?.cited_text) citedText.push(String(c.cited_text));
          }
        }
      }
      if (r.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: r.content });
    }
  } catch (err: any) {
    // Timed out with research in hand → structure what we have; otherwise web
    // search is unavailable (not enabled for the key, outage) — say so.
    console.warn("[external-acquirers] research stopped:", err?.message);
    if (!finalText.trim()) mode = "knowledge";
  }

  const structuring = await anthropic.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 4000,
    temperature: 0,
    tools: [REPORT_TOOL as any],
    tool_choice: { type: "tool", name: "report_acquirers" },
    system: mode === "web"
      ? `Turn the research into the structured list. Use only organisations, facts, URLs and contacts that appear in the research. Do not add anything. Drop any organisation that conflicts with the seller's buyer preferences.${brief.includes("SELLER'S BUYER PREFERENCES") ? `\n\n${brief.split("\n").find((l) => l.startsWith("SELLER'S BUYER PREFERENCES")) ?? ""}` : ""}`
      : "List likely acquirers for this business profile from your own knowledge. Mark nothing as a contact. Sources may be the organisations' home pages only. Be conservative — only well-known, real organisations active in this sector.",
    messages: [{ role: "user", content: mode === "web" ? `RESEARCH:\n${finalText.slice(0, 30000)}` : `Business profile:\n${brief}` }],
  });
  const block = structuring.content.find((b) => b.type === "tool_use");
  const cited = citedText.join("\n").toLowerCase();
  const known = Array.from(urls);
  const urlOk = (u: string) => mode === "knowledge" || known.some((k) => k === u || k.startsWith(u) || u.startsWith(k));

  const input = ((block && block.type === "tool_use" ? block.input : {}) as { acquirers?: any[]; note?: string | null; channels?: any[] });
  const raw = input.acquirers ?? [];
  const note = input.note ? String(input.note).slice(0, 900) : null;
  const channels = (Array.isArray(input.channels) ? input.channels : [])
    .filter((c) => c?.name && c?.how && !/\bbroker|brokerage|m&a advis/i.test(`${c.name} ${c.how}`))
    .slice(0, 5)
    .map((c) => ({ name: String(c.name).slice(0, 120), how: String(c.how).slice(0, 300), url: c.url && urlOk(String(c.url)) ? String(c.url) : null }));

  // Mark organisations the broker already has in their buyer list.
  const contacts = await storage.getBrokerBuyerContactList(deal.brokerId!).catch(() => []);
  const theirs = new Set<string>();
  for (const { buyerUser } of contacts) {
    if (buyerUser.company) theirs.add(buyerUser.company.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const dom = buyerUser.email.split("@")[1];
    if (dom) theirs.add(dom.toLowerCase());
  }

  const out: ExternalAcquirer[] = [];
  for (const a of raw) {
    if (!a?.name || !a?.whyInterested) continue;
    const sources = (Array.isArray(a.sources) ? a.sources : []).map(String).filter(urlOk).slice(0, 4);
    if (mode === "web" && sources.length === 0) continue;   // uncited → dropped
    let contact: string | null = a.contact ? String(a.contact).trim() : null;
    if (contact && (mode === "knowledge" || !cited.includes(contact.toLowerCase()))) contact = null;
    const website = a.website ? String(a.website) : null;
    const domain = website ? website.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase() : "";
    out.push({
      name: String(a.name).slice(0, 120),
      type: ["strategic", "private_equity", "family_office", "search_fund", "other"].includes(a.type) ? a.type : "other",
      headquarters: a.headquarters ? String(a.headquarters).slice(0, 120) : null,
      website,
      whyInterested: String(a.whyInterested).slice(0, 500),
      evidence: (Array.isArray(a.evidence) ? a.evidence : []).map(String).slice(0, 3),
      contact,
      sources,
      inYourList: theirs.has(String(a.name).toLowerCase().replace(/[^a-z0-9]/g, "")) || (!!domain && theirs.has(domain)),
    });
  }
  return { results: out.slice(0, 15), mode, note, channels };
}
