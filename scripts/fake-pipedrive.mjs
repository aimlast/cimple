#!/usr/bin/env node
/**
 * fake-pipedrive.mjs — a local stand-in for the Pipedrive v1 API, for testing
 * the seller-side CRM import (and connect / buyer prefill / stage sync)
 * without ever touching a real CRM. NOT part of the app bundle and never
 * imported by server code.
 *
 *   node scripts/fake-pipedrive.mjs [port]          (default 5103)
 *   PIPEDRIVE_API_BASE=http://localhost:5103 <start the Cimple server>
 *
 * Token: FAKE_PIPEDRIVE_TOKEN (default "fake-crm-seller-token"), accepted as the
 * x-api-token header or the api_token query parameter (anything else → 401).
 *
 * Deliberately awkward, like the real thing:
 *   - list endpoints return at most 2 items per page (exercises pagination)
 *   - the first /v1/itemSearch call answers 429 with Retry-After: 1
 *   - /v1/organizations/:id/mailMessages answers 403 (mail not shared)
 *
 * Test helpers (no auth): GET /__admin/log, POST /__admin/edit-note/:id
 * (changes the note text + update_time, for re-import tests), POST /__admin/reset.
 */
import http from "node:http";
import PDFDocument from "pdfkit";

const PORT = Number(process.argv[2] || process.env.PORT || 5103);
const TOKEN = process.env.FAKE_PIPEDRIVE_TOKEN || "fake-crm-seller-token";
const PAGE_CAP = 2;

// ── Fake data: a physiotherapy clinic whose owner is selling ─────────────

const F = {
  industry: "9f1c0d2e4b5a6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
  revenue: "0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b",
  reason: "1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c",
  employees: "2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d",
  leadSource: "3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e",
  website: "4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f",
  founded: "5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a",
  role: "6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b",
};

const dealFields = [
  { key: "title", name: "Title", field_type: "varchar" },
  { key: "value", name: "Value", field_type: "monetary" },
  { key: "org_id", name: "Organization", field_type: "org" },
  { key: "person_id", name: "Contact person", field_type: "people" },
  { key: "stage_id", name: "Stage", field_type: "stage" },
  { key: "status", name: "Status", field_type: "status" },
  { key: F.industry, name: "Industry", field_type: "varchar" },
  { key: F.revenue, name: "Annual revenue (approx.)", field_type: "monetary" },
  { key: F.reason, name: "Reason for sale", field_type: "text" },
  { key: F.employees, name: "Number of employees", field_type: "double" },
  { key: F.leadSource, name: "Lead source", field_type: "enum", options: [{ id: 11, label: "Referral" }, { id: 12, label: "Website" }] },
];
const organizationFields = [
  { key: "name", name: "Name", field_type: "varchar" },
  { key: "address", name: "Address", field_type: "address" },
  { key: F.website, name: "Website", field_type: "varchar" },
  { key: F.founded, name: "Year founded", field_type: "double" },
];
const personFields = [
  { key: "name", name: "Name", field_type: "varchar" },
  { key: "email", name: "Email", field_type: "varchar" },
  { key: "phone", name: "Phone", field_type: "phone" },
  { key: "org_id", name: "Organization", field_type: "org" },
  { key: F.role, name: "Role", field_type: "varchar" },
];

function freshData() {
  const org = {
    id: 601,
    name: "QA crm-seller — Maple Ridge Physiotherapy Ltd",
    address: "22410 Dewdney Trunk Rd, Maple Ridge, BC V2X 3J5, Canada",
    address_locality: "Maple Ridge",
    address_admin_area_level_1: "BC",
    address_country: "Canada",
    owner_id: { id: 1, name: "Casey Broker", value: 1 },
    people_count: 1,
    add_time: "2026-02-10 15:04:11",
    update_time: "2026-03-12 09:14:52",
    [F.website]: "mapleridgephysio.invalid",
    [F.founded]: 2009,
  };
  const person = {
    id: 701,
    name: "Dana Whitfield",
    first_name: "Dana",
    last_name: "Whitfield",
    email: [{ label: "work", value: "dana.whitfield@mapleridge.invalid", primary: true }],
    phone: [{ label: "mobile", value: "+1 604 555 0142", primary: true }],
    org_id: { name: org.name, value: 601 },
    job_title: "Owner & Clinic Director",
    add_time: "2026-02-10 15:05:40",
    update_time: "2026-03-01 11:00:00",
    [F.role]: "Owner",
  };
  const deal = {
    id: 501,
    title: "QA crm-seller — Maple Ridge Physiotherapy (sale mandate)",
    value: 2100000,
    currency: "CAD",
    status: "open",
    stage_id: 3,
    pipeline_id: 1,
    org_id: { name: org.name, value: 601 },
    person_id: { name: person.name, email: person.email, phone: person.phone, value: 701 },
    user_id: { id: 1, name: "Casey Broker", value: 1 },
    add_time: "2026-02-10 15:06:02",
    update_time: "2026-03-14 16:20:00",
    notes_count: 4,
    activities_count: 3,
    [F.industry]: "Physiotherapy clinic",
    [F.revenue]: 1400000,
    [`${F.revenue}_currency`]: "CAD",
    [F.reason]: "Owner retiring after 17 years; happy to stay on 6 months for the transition.",
    [F.employees]: 14,
    [F.leadSource]: "11",
  };
  // A second deal/org/person the search can also find (never linked in tests).
  const otherDeal = { id: 502, title: "QA crm-seller — Fraser Valley Dental (valuation)", status: "open", org_id: null, person_id: null, add_time: "2026-01-01 10:00:00", update_time: "2026-01-02 10:00:00" };

  const notes = [
    {
      id: 9001, deal_id: 501, org_id: 601, person_id: 701,
      content: "<p>Site visit at the clinic with Dana.</p><p>6 treatment rooms plus an open gym area, about <b>3,200 sq ft</b>. Lease with Haney Properties runs to <b>Aug 2029</b> with one 5-year renewal option; rent approx $7,800/month plus TMI.</p>",
      add_time: "2026-02-18 17:30:00", update_time: "2026-02-18 17:30:00", user: { name: "Casey Broker" },
      deal: { title: deal.title }, organization: { name: org.name }, person: { name: person.name },
    },
    {
      id: 9002, deal_id: 501, org_id: null, person_id: null,
      content: "Revenue mix per Dana: roughly 55% ICBC auto-insurance claims, 30% private pay / extended health, 15% WorkSafeBC. She thinks 2024 revenue was about $1.42M and SDE around $390K — need the compilation to confirm.",
      add_time: "2026-02-25 10:12:00", update_time: "2026-02-25 10:12:00", user: { name: "Casey Broker" },
      deal: { title: deal.title },
    },
    {
      id: 9003, deal_id: null, org_id: 601, person_id: null,
      content: "Staff: 6 registered physiotherapists (2 associates on a 70/30 split), 2 kinesiologists, 1 RMT, 3 front desk and a clinic manager (Priya) who already runs day-to-day scheduling and billing.",
      add_time: "2026-03-02 14:40:00", update_time: "2026-03-02 14:40:00", user: { name: "Casey Broker" },
      organization: { name: org.name },
    },
    {
      id: 9004, deal_id: null, org_id: null, person_id: 701,
      content: "PRIVATE — do not share: Dana mentioned a health scare last year and would like to be out within about 6 months. Keep this out of anything buyers see.",
      add_time: "2026-03-05 09:05:00", update_time: "2026-03-05 09:05:00", user: { name: "Casey Broker" },
      person: { name: person.name },
    },
    {
      id: 9005, deal_id: 501, org_id: null, person_id: null,
      content: "ok",
      add_time: "2026-03-06 09:05:00", update_time: "2026-03-06 09:05:00", user: { name: "Casey Broker" },
    },
  ];

  const activities = [
    {
      id: 8001, deal_id: 501, org_id: 601, person_id: 701, type: "call", subject: "Intro call with Dana",
      due_date: "2026-02-12", done: true, owner_name: "Casey Broker", person_name: person.name,
      note: "<p>Dana founded the clinic in 2009. Two locations were considered but she kept one site. Direct billing to ICBC and most extended-health insurers. No debt except an equipment lease on the shockwave unit (~$18K left).</p>",
      add_time: "2026-02-12 18:00:00", update_time: "2026-02-12 18:05:00",
    },
    { id: 8002, deal_id: 501, type: "task", subject: "Send engagement letter", due_date: "2026-02-20", done: true, owner_name: "Casey Broker", note: "", add_time: "2026-02-20 10:00:00", update_time: "2026-02-20 10:00:00" },
    {
      id: 8003, deal_id: null, person_id: 701, type: "meeting", subject: "Walkthrough of the equipment",
      due_date: "2026-03-10", done: true, owner_name: "Casey Broker",
      note: "Equipment: 8 treatment tables (3 electric hi-lo), shockwave unit, 2 laser units, full gym (treadmill, bikes, cable machine). All owned except the shockwave (lease).",
      add_time: "2026-03-10 13:00:00", update_time: "2026-03-10 13:10:00",
    },
  ];

  const mail = [
    {
      id: 7001, deal_id: 501, subject: "Clinic numbers for 2023 and 2024",
      from: [{ email_address: "dana.whitfield@mapleridge.invalid", name: "Dana Whitfield" }],
      to: [{ email_address: "casey@brokerage.invalid", name: "Casey Broker" }],
      cc: [], snippet: "Hi Casey, as promised…",
      message_time: "2026-03-03 20:15:00", add_time: "2026-03-03 20:15:05", update_time: "2026-03-03 20:15:05",
      body: "<p>Hi Casey,</p><p>As promised — our accountant's numbers: revenue was $1,318,000 in 2023 and $1,421,500 in 2024. Patient visits were about 19,400 last year. We are closed Sundays and open until 8pm Mon–Thu.</p><p>Dana</p>",
    },
    {
      id: 7002, deal_id: 501, subject: "Re: transition",
      from: [{ email_address: "casey@brokerage.invalid", name: "Casey Broker" }],
      to: [{ email_address: "dana.whitfield@mapleridge.invalid", name: "Dana Whitfield" }],
      cc: [], snippet: "Would you consider staying longer than six months?",
      message_time: "2026-03-08 09:00:00", add_time: "2026-03-08 09:00:05", update_time: "2026-03-08 09:00:05",
      body: null, // body only via /v1/mailbox/mailMessages/:id?include_body=1
    },
  ];
  const mailBodies = {
    7002: "<p>Hi Dana — would you consider staying longer than six months if a buyer asked?</p><blockquote>Dana: I could do up to 9 months part-time, 2 days a week, to introduce the new owner to referring physicians.</blockquote>",
  };

  const files = [
    { id: 4001, deal_id: 501, name: "2024 Income Statement.pdf", file_name: "2024 Income Statement.pdf", file_type: "pdf", file_size: 0, remote_location: "s3", active_flag: true, inline_flag: false, add_time: "2026-03-04 12:00:00", update_time: "2026-03-04 12:00:00" },
    { id: 4002, deal_id: 501, name: "Equipment list.txt", file_name: "Equipment list.txt", file_type: "txt", file_size: 0, remote_location: "s3", active_flag: true, inline_flag: false, add_time: "2026-03-10 13:20:00", update_time: "2026-03-10 13:20:00" },
    { id: 4003, deal_id: 501, name: "clinic-photo.jpg", file_name: "clinic-photo.jpg", file_type: "jpg", file_size: 120000, remote_location: "s3", active_flag: true, inline_flag: false, add_time: "2026-03-10 13:25:00", update_time: "2026-03-10 13:25:00" },
  ];

  return { org, person, deal, otherDeal, notes, activities, mail, mailBodies, files, updates: [] };
}

let data = freshData();
const log = [];
let itemSearchCalls = 0;

// ── Files served by /v1/files/:id/download ──────────────────────────────

function buildIncomePdf() {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 56 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.fontSize(16).text("Maple Ridge Physiotherapy Ltd", { align: "center" });
    doc.fontSize(12).text("Statement of Income — year ended December 31, 2024 (compiled, unaudited)", { align: "center" });
    doc.moveDown();
    const rows = [
      ["Revenue — ICBC", "$782,000"],
      ["Revenue — private pay & extended health", "$426,500"],
      ["Revenue — WorkSafeBC", "$213,000"],
      ["Total revenue", "$1,421,500"],
      ["Associate & staff wages", "$702,300"],
      ["Rent and occupancy", "$101,400"],
      ["Clinic supplies", "$38,900"],
      ["Other operating expenses", "$121,600"],
      ["Net income before taxes", "$457,300"],
    ];
    for (const [a, b] of rows) doc.text(`${a.padEnd(48, ".")} ${b}`);
    doc.moveDown().text("Owner's salary of $95,000 is included in wages.");
    doc.end();
  });
}
const equipmentTxt = Buffer.from(
  "Maple Ridge Physiotherapy — equipment list (March 2026)\n" +
    "- 8 treatment tables (3 electric hi-lo), owned\n" +
    "- Shockwave therapy unit, leased (about $18,000 remaining)\n" +
    "- 2 class IV laser units, owned\n" +
    "- Gym: treadmill, 2 bikes, cable machine, free weights, owned\n" +
    "- Jane App practice-management subscription (monthly)\n",
  "utf-8",
);
let incomePdf = null;

// ── HTTP helpers ─────────────────────────────────────────────────────────

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
function ok(res, dataOut, extra = {}) {
  send(res, 200, { success: true, data: dataOut, ...extra });
}
function page(res, items, q) {
  const start = Number(q.get("start") || 0);
  const limit = Math.min(Number(q.get("limit") || 100), PAGE_CAP);
  const slice = items.slice(start, start + limit);
  const more = start + limit < items.length;
  ok(res, slice.length ? slice : null, {
    additional_data: { pagination: { start, limit, more_items_in_collection: more, ...(more ? { next_start: start + limit } : {}) } },
  });
}
function authed(req, q) {
  return req.headers["x-api-token"] === TOKEN || q.get("api_token") === TOKEN;
}

// ── Router ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const q = url.searchParams;
  const p = url.pathname;
  const authVia = req.headers["x-api-token"] ? "header" : q.get("api_token") ? "query" : "none";
  log.push({ at: new Date().toISOString(), method: req.method, path: p, query: Object.fromEntries([...q].filter(([k]) => k !== "api_token")), auth: authVia });
  if (log.length > 500) log.shift();

  // admin helpers
  if (p === "/__admin/log") return send(res, 200, log);
  if (p === "/__admin/reset" && req.method === "POST") { data = freshData(); itemSearchCalls = 0; log.length = 0; return send(res, 200, { ok: true }); }
  const edit = p.match(/^\/__admin\/edit-note\/(\d+)$/);
  if (edit && req.method === "POST") {
    const n = data.notes.find((x) => String(x.id) === edit[1]);
    if (!n) return send(res, 404, { success: false });
    n.content += " UPDATE: Dana now says the lease renewal option was confirmed in writing by the landlord in March 2026.";
    n.update_time = "2026-03-20 08:00:00";
    return send(res, 200, { ok: true, note: n });
  }

  if (!authed(req, q)) return send(res, 401, { success: false, error: "unauthorized access", errorCode: 401 });

  const { deal, org, person } = data;
  let m;

  if (p === "/v1/users/me") return ok(res, { id: 1, name: "Casey Broker", email: "casey@brokerage.invalid", company_domain: "qa-fake-brokerage" });

  if (p === "/v1/itemSearch") {
    itemSearchCalls++;
    if (itemSearchCalls === 1) return send(res, 429, { success: false, error: "Too many requests" }, { "Retry-After": "1" });
    const term = (q.get("term") || "").toLowerCase();
    const types = (q.get("item_types") || "deal,organization,person").split(",");
    const items = [];
    const hit = (s) => String(s || "").toLowerCase().includes(term);
    for (const d of [deal, data.otherDeal]) {
      if (types.includes("deal") && hit(d.title))
        items.push({ result_score: 1, item: { id: d.id, type: "deal", title: d.title, status: d.status, stage: { id: 3, name: "Listing prep" }, organization: d.org_id ? { id: 601, name: org.name } : null, person: d.person_id ? { id: 701, name: person.name } : null } });
    }
    if (types.includes("organization") && (hit(org.name) || hit(org.address))) items.push({ result_score: 0.9, item: { id: org.id, type: "organization", name: org.name, address: org.address } });
    if (types.includes("person") && (hit(person.name) || hit(person.email[0].value))) items.push({ result_score: 0.8, item: { id: person.id, type: "person", name: person.name, emails: [person.email[0].value], phones: [person.phone[0].value], organization: { id: 601, name: org.name } } });
    return ok(res, { items });
  }

  if (p === "/v1/persons/search") {
    const term = (q.get("term") || "").toLowerCase();
    const items = String(person.name).toLowerCase().includes(term) || person.email[0].value.includes(term)
      ? [{ item: { id: person.id, name: person.name, emails: [person.email[0].value], phones: [person.phone[0].value], organization: { name: org.name } } }]
      : [];
    return ok(res, { items });
  }

  if (p === "/v1/dealFields") return page(res, dealFields, q);
  if (p === "/v1/organizationFields") return page(res, organizationFields, q);
  if (p === "/v1/personFields") return page(res, personFields, q);

  if ((m = p.match(/^\/v1\/deals\/(\d+)$/))) {
    if (req.method === "PUT") {
      let body = "";
      for await (const c of req) body += c;
      data.updates.push({ dealId: m[1], body: JSON.parse(body || "{}") });
      return ok(res, { id: Number(m[1]) });
    }
    if (m[1] === "501") return ok(res, deal);
    if (m[1] === "502") return ok(res, data.otherDeal);
    return send(res, 404, { success: false, error: "Deal not found" });
  }
  if ((m = p.match(/^\/v1\/organizations\/(\d+)$/))) return m[1] === "601" ? ok(res, org) : send(res, 404, { success: false });
  if ((m = p.match(/^\/v1\/persons\/(\d+)$/))) return m[1] === "701" ? ok(res, person) : send(res, 404, { success: false });
  if ((m = p.match(/^\/v1\/organizations\/(\d+)\/persons$/))) return page(res, m[1] === "601" ? [person] : [], q);

  if (p === "/v1/notes") {
    const d = q.get("deal_id"), o = q.get("org_id"), pe = q.get("person_id");
    const list = data.notes.filter((n) => (d && String(n.deal_id) === d) || (o && String(n.org_id) === o) || (pe && String(n.person_id) === pe));
    return page(res, list, q);
  }

  if ((m = p.match(/^\/v1\/(deals|organizations|persons)\/(\d+)\/activities$/))) {
    const field = { deals: "deal_id", organizations: "org_id", persons: "person_id" }[m[1]];
    return page(res, data.activities.filter((a) => String(a[field]) === m[2]), q);
  }

  if ((m = p.match(/^\/v1\/(deals|organizations|persons)\/(\d+)\/mailMessages$/))) {
    if (m[1] === "organizations") return send(res, 403, { success: false, error: "Mail not shared" });
    const rows = m[1] === "deals" ? data.mail.filter((x) => String(x.deal_id) === m[2]) : m[2] === "701" ? data.mail.slice(0, 1) : [];
    return page(res, rows.map((x) => ({ object: "mailMessage", timestamp: x.message_time, data: { ...x } })), q);
  }
  if ((m = p.match(/^\/v1\/mailbox\/mailMessages\/(\d+)$/))) {
    const msg = data.mail.find((x) => String(x.id) === m[1]);
    if (!msg) return send(res, 404, { success: false });
    const body = msg.body ?? data.mailBodies[msg.id] ?? null;
    return ok(res, { ...msg, body: q.get("include_body") === "1" ? body : undefined });
  }

  if ((m = p.match(/^\/v1\/(deals|organizations|persons)\/(\d+)\/files$/))) {
    const rows = m[1] === "deals" && m[2] === "501" ? data.files : [];
    return page(res, rows, q);
  }
  if (p === "/v1/files") return page(res, q.get("person_id") === "701" ? [] : [], q);
  if ((m = p.match(/^\/v1\/files\/(\d+)\/download$/))) {
    if (m[1] === "4001") {
      incomePdf = incomePdf || (await buildIncomePdf());
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": incomePdf.length });
      return res.end(incomePdf);
    }
    if (m[1] === "4002") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": equipmentTxt.length });
      return res.end(equipmentTxt);
    }
    return send(res, 404, { success: false });
  }

  if (p === "/v1/pipelines") return ok(res, [{ id: 1, name: "Sell-side listings" }]);

  return send(res, 404, { success: false, error: `fake-pipedrive: no route for ${req.method} ${p}` });
});

server.listen(PORT, () => console.log(`[fake-pipedrive] listening on http://localhost:${PORT} (token: ${TOKEN === "fake-crm-seller-token" ? "default fake token" : "custom"})`));
