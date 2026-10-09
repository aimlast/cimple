/**
 * The teaser through the real Express routes (tests/utils/teaser-harness.ts:
 * in-memory storage, stubbed model, captured email):
 *  - write (stubbed model) → publish → a teaser link reads it;
 *  - the view GET for teaser_only: unpublished → 403; published → the
 *    whitelisted payload (no CIM sections, questions or facts);
 *    firstViewedAt untouched; `reading` present except for the owner's preview;
 *    an expired link → {code:"expired", teaser:true, firm}; revoked → the generic 403;
 *  - sign-nda on a teaser link WITHOUT the email check → 400; with it → one request;
 *  - /cim-request without an NDA needs a profile; a CIM-level link → 409;
 *  - teaser-pass records reasons and never touches the CIM decision;
 *  - fresh-link only for expired teaser links, once a day;
 *  - PATCH to teaser_only needs a published teaser; POST /buyers makes teaser links once published.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/teaser-routes.test.ts
 */
import { T, DAY, now, pacificWritten, mkAccess, seedPacific, startHarness, PROFILE, sent } from "../utils/teaser-harness";
import assert from "node:assert/strict";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main() {
  const h = await startHarness();
  const { call, broker } = h;
  seedPacific();
  const link = mkAccess();

  await check("no teaser yet: the Teaser tab can write one; a teaser link reads 'not available'", async () => {
    const r = await call("GET", "/api/deals/D-PAC/teaser", undefined, broker);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.teaser, null);
    assert.equal(r.json.canWrite.ok, true, JSON.stringify(r.json.canWrite));
    assert.equal(r.json.basis, "blind_cim");
    const v = await call("GET", `/api/view/${link.accessToken}`);
    assert.equal(v.status, 403);
    assert.equal(v.json.code, "not_published");
  });

  let rev = 0;
  await check("write (stubbed model) → 202, then the draft; publish → published", async () => {
    h.modelReplies.push(pacificWritten());
    const g = await call("POST", "/api/deals/D-PAC/teaser/generate", { templateKey: "one_page" }, broker);
    assert.equal(g.status, 202, g.text);
    const { waitForTeaser } = await import("../../server/teaser/generate");
    await waitForTeaser("D-PAC");
    const s = await call("GET", "/api/deals/D-PAC/teaser", undefined, broker);
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.teaser.generation.status, "done");
    assert.equal(s.json.summary.status, "draft");
    rev = s.json.teaser.draftRev;
    assert.ok(s.json.teaser.checks.every((c: { held: boolean }) => !c.held), JSON.stringify(s.json.teaser.checks));
    const again = await call("POST", "/api/deals/D-PAC/teaser/generate", { templateKey: "one_page" }, broker);
    assert.equal(again.status, 409);
    assert.equal(again.json.code, "has_draft", "a rewrite over a draft asks first");
    const p = await call("POST", "/api/deals/D-PAC/teaser/publish", { rev }, broker);
    assert.equal(p.status, 200, p.text);
    assert.equal(p.json.summary.status, "published");
    assert.equal(p.json.teaser.publishedRev, 1);
  });

  await check("publish needs the confidentiality check now (or the broker's confirmation); a held name is refused", async () => {
    const keepOut = await import("../../server/cim/keep-out");
    const nothingHeld = { messages: { create: (async () => ({ content: [{ type: "tool_use", id: "x", name: "keep_out_review", input: { holds: [] } }] })) as never } } as never;
    keepOut._setKeepOutModelForTests({ messages: { create: (async () => { throw Object.assign(new Error("overloaded"), { status: 529 }); }) as never } } as never);
    const st = await call("GET", "/api/deals/D-PAC/teaser", undefined, broker);
    const r1 = await call("POST", "/api/deals/D-PAC/teaser/publish", { rev: st.json.teaser.draftRev }, broker);
    assert.equal(r1.status, 409);
    assert.ok(r1.json.problems.some((p: string) => /confidentiality check couldn't run/.test(p)), JSON.stringify(r1.json));
    const c = await call("POST", "/api/deals/D-PAC/teaser/confirm-review", { rev: st.json.teaser.draftRev }, broker);
    assert.equal(c.status, 200, c.text);
    assert.ok(c.json.teaser.reviewConfirmed?.at);
    const r2 = await call("POST", "/api/deals/D-PAC/teaser/publish", { rev: c.json.teaser.draftRev }, broker);
    assert.equal(r2.status, 200, r2.text);
    keepOut._setKeepOutModelForTests(nothingHeld);
    const ok = await call("POST", "/api/deals/D-PAC/teaser/confirm-review", { rev: r2.json.teaser.draftRev }, broker);
    assert.equal(ok.status, 409, "the check runs again: nothing to confirm");
    assert.equal(ok.json.code, "review_ok");
    // A party the review holds (not otherwise identifying) mentioned by the broker: refused at publish.
    const gen = await import("../../server/teaser/generate");
    const { dbBriefDeps } = await import("../../server/teaser/brief");
    gen._setTeaserBriefDepsForTests({ ...dbBriefDeps, keepOut: async () => ({ clauses: [], names: ["Northwind Grocers"], pairs: [], by: "ai" as const }) });
    const over = r2.json.teaser.draft.blocks.find((b: { slot: string }) => b.slot === "overview");
    const e = await call("PATCH", `/api/deals/D-PAC/teaser/blocks/${over.id}`, { rev: r2.json.teaser.draftRev, body: "A carrier bidding on the Northwind Grocers contract." }, broker);
    assert.equal(e.status, 200, e.text);
    const r3 = await call("POST", "/api/deals/D-PAC/teaser/publish", { rev: e.json.teaser.draftRev }, broker);
    assert.equal(r3.status, 409);
    assert.ok(r3.json.problems.some((p: string) => /Northwind Grocers.*keep confidential/.test(p)), JSON.stringify(r3.json.problems));
    gen._setTeaserBriefDepsForTests(dbBriefDeps);
    const u = await call("POST", "/api/deals/D-PAC/teaser/undo", { rev: e.json.teaser.draftRev }, broker);
    assert.equal(u.status, 200, u.text);
  });

  await check("the view GET serves the whitelisted teaser payload; firstViewedAt untouched; reading recorded", async () => {
    const v = await call("GET", `/api/view/${link.accessToken}`);
    assert.equal(v.status, 200, v.text);
    assert.equal(v.json.document, "teaser");
    assert.equal(v.json.access.accessLevel, "teaser_only");
    assert.equal(v.json.deal.businessName, "Project Meridian");
    for (const k of ["sections", "publishedQuestions", "extractedInfo", "cimMode", "dataRoom"]) assert.ok(!(k in v.json), `${k} must not be in the payload`);
    assert.ok(!/Pacific Coast|Surrey|Harjit|extractedInfo/.test(v.text), "nothing identifying");
    assert.ok(v.json.teaser.blocks.length >= 4);
    assert.ok(JSON.stringify(v.json.teaser.blocks).includes("$17.5M–$20M"), "price as a range");
    assert.equal(v.json.emailCheck.needed, true);
    assert.equal(v.json.emailCheck.maskedEmail, "n•••@cascaderidge.invalid");
    assert.deepEqual(v.json.cimRequest, { state: "none", at: null });
    assert.ok(v.json.reading?.renditionId, "reading present");
    assert.equal(v.json.reading.pageOrder[0], "teaser_header");
    const row = T.access.find((a) => a.id === link.id);
    assert.equal(row.firstViewedAt, null);
    assert.equal(row.viewCount, 0);
    assert.ok(row.lastAccessedAt);
    const own = await call("GET", `/api/view/${link.accessToken}`, undefined, broker);
    assert.equal(own.status, 200);
    assert.ok(!("reading" in own.json), "the owner's preview records nothing");
  });

  await check("an expired teaser link → {code:'expired', teaser:true, firm}; a revoked one → the generic 403", async () => {
    const expired = mkAccess({ expiresAt: new Date(now - DAY) });
    const e = await call("GET", `/api/view/${expired.accessToken}`);
    assert.equal(e.status, 403);
    assert.deepEqual([e.json.code, e.json.teaser, e.json.firm], ["expired", true, "Brassline Advisory Partners"]);
    const revoked = mkAccess({ revokedAt: new Date() });
    const r = await call("GET", `/api/view/${revoked.accessToken}`);
    assert.equal(r.status, 403);
    assert.equal(r.json.code, undefined);
    assert.match(r.json.error, /revoked/);
  });

  await check("sign-nda on a teaser link without the email check → 400 email_check_required", async () => {
    const p = await call("GET", `/api/view/${link.accessToken}/buyer-profile`);
    assert.equal(p.status, 200, p.text);
    const r = await call("POST", `/api/view/${link.accessToken}/sign-nda`, { profile: PROFILE, signerName: "Natalie Vasconcelos", termsHash: p.json.nda.hash });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "email_check_required");
    assert.equal(T.access.find((a) => a.id === link.id).ndaSigned, false);
  });

  await check("the email check: the code goes to the link's own address; then sign-nda creates the request once", async () => {
    const s = await call("POST", `/api/view/${link.accessToken}/email-check`, { email: "attacker@evil.invalid" });
    assert.equal(s.status, 200, s.text);
    assert.equal(h.codes.length, 1);
    assert.equal(h.codes[0].to, "natalie@cascaderidge.invalid", "never an address the requester typed");
    assert.match(h.codes[0].subject, /Your code for Project Meridian/);
    const code = /(\d{3}) (\d{3})/.exec(h.codes[0].html)!.slice(1).join("");
    const bad = await call("POST", `/api/view/${link.accessToken}/email-check/verify`, { code: code === "000000" ? "111111" : "000000" });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.triesLeft, 4);
    const ok = await call("POST", `/api/view/${link.accessToken}/email-check/verify`, { code });
    assert.equal(ok.status, 200, ok.text);
    const p = await call("GET", `/api/view/${link.accessToken}/buyer-profile`);
    const r = await call("POST", `/api/view/${link.accessToken}/sign-nda`, { profile: PROFILE, signerName: "Natalie Vasconcelos", termsHash: p.json.nda.hash });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.request.state, "requested");
    const reqs = T.approvals.filter((a) => a.buyerAccessId === link.id);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].source, "teaser_request");
    assert.equal(reqs[0].buyerEmail, "natalie@cascaderidge.invalid");
    assert.equal(reqs[0].category, "pe_generalist");
    assert.equal(reqs[0].status, "pending_broker_review");
    assert.equal(reqs[0].teaserRequest.emailCheck, "code");
    assert.equal(reqs[0].teaserRequest.mismatch, false);
    const again = await call("POST", `/api/view/${link.accessToken}/cim-request`, { note: "We run two carriers in Alberta." });
    assert.equal(again.status, 200, again.text);
    assert.equal(T.approvals.filter((a) => a.buyerAccessId === link.id).length, 1, "idempotent");
    assert.equal(T.approvals.find((a) => a.buyerAccessId === link.id).buyerNote, "We run two carriers in Alberta.");
    const events = T.access.find((a) => a.id === link.id).accessEvents.map((e: { type: string }) => e.type);
    assert.ok(events.includes("cim_requested"));
    const v = await call("GET", `/api/view/${link.accessToken}`);
    assert.equal(v.json.cimRequest.state, "requested");
    assert.equal(v.json.emailCheck.verified, true);
  });

  await check("/cim-request without an NDA requires a profile; a CIM-level link → 409; revoked → 403", async () => {
    T.deals.push({ ...T.deals.find((d) => d.id === "D-PAC"), id: "D-NONDA", ndaRequired: false });
    const l2 = mkAccess({ dealId: "D-NONDA", accessToken: "tok-nonda", buyerEmail: "lee@acquirer.invalid", buyerName: "Lee Park" });
    await h.teasers.create("D-NONDA", { ...(await h.teasers.get("D-PAC"))! } as never);
    // Verify the email first.
    await call("POST", `/api/view/${l2.accessToken}/email-check`);
    const code = /(\d{3}) (\d{3})/.exec(h.codes[h.codes.length - 1].html)!.slice(1).join("");
    await call("POST", `/api/view/${l2.accessToken}/email-check/verify`, { code });
    const none = await call("POST", `/api/view/${l2.accessToken}/cim-request`, {});
    assert.equal(none.status, 400);
    assert.equal(none.json.code, "profile_required");
    const bad = await call("POST", `/api/view/${l2.accessToken}/cim-request`, { profile: { ...PROFILE, phone: "1" } });
    assert.equal(bad.status, 400);
    const ok = await call("POST", `/api/view/${l2.accessToken}/cim-request`, { profile: { ...PROFILE, name: "Lee Park" } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.state, "requested");
    const cimLink = mkAccess({ accessLevel: "blind", buyerEmail: "cim@buyer.invalid" });
    const c = await call("POST", `/api/view/${cimLink.accessToken}/cim-request`, {});
    assert.equal(c.status, 409);
    assert.equal(c.json.code, "already_cim");
    const revoked = mkAccess({ revokedAt: new Date() });
    assert.equal((await call("POST", `/api/view/${revoked.accessToken}/cim-request`, {})).status, 403);
  });

  await check("a teaser link can't decide, ask questions or read the Q&A feed", async () => {
    const d = await call("POST", `/api/view/${link.accessToken}/decision`, { decision: "interested" });
    assert.equal(d.status, 409);
    const q = await call("POST", "/api/deals/D-PAC/questions", { question: "What is the revenue?", accessToken: link.accessToken });
    assert.equal(q.status, 403);
  });

  await check("'Not for me' records reasons, never the CIM decision", async () => {
    const other = mkAccess({ buyerEmail: "pass@buyer.invalid" });
    const r = await call("POST", `/api/view/${other.accessToken}/teaser-pass`, { reasons: ["size", "price"], note: "Too small for us." });
    assert.equal(r.status, 200, r.text);
    const row = T.access.find((a) => a.id === other.id);
    const ev = row.accessEvents.at(-1);
    assert.deepEqual([ev.type, ev.reasons, ev.note], ["teaser_passed", ["size", "price"], "Too small for us."]);
    assert.equal(row.decision, "under_review");
    assert.equal((await call("POST", `/api/view/${other.accessToken}/teaser-pass`, { reasons: ["bogus"] })).status, 400);
    const v = await call("GET", `/api/view/${other.accessToken}`);
    assert.deepEqual(v.json.passed.reasons, ["size", "price"]);
  });

  await check("fresh-link: only an expired teaser link, once a day", async () => {
    const expired = mkAccess({ expiresAt: new Date(now - DAY), buyerEmail: "late@buyer.invalid" });
    const r = await call("POST", `/api/view/${expired.accessToken}/fresh-link`);
    assert.equal(r.status, 200, r.text);
    assert.equal(T.access.find((a) => a.id === expired.id).accessEvents.at(-1).type, "fresh_link_requested");
    assert.equal((await call("POST", `/api/view/${expired.accessToken}/fresh-link`)).status, 429, "once a day");
    const live = mkAccess({ buyerEmail: "live@buyer.invalid" });
    assert.equal((await call("POST", `/api/view/${live.accessToken}/fresh-link`)).status, 409);
  });

  await check("POST /buyers makes a teaser link once published (lasts until offline); PATCH to teaser_only needs a published teaser", async () => {
    const r = await call("POST", "/api/deals/D-PAC/buyers", { buyerEmail: "new@buyer.invalid", accessLevel: "teaser_only" }, broker);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.accessLevel, "teaser_only");
    assert.equal(r.json.expiresAt, null);
    const cim = mkAccess({ accessLevel: "blind", buyerEmail: "down@buyer.invalid" });
    const down = await call("PATCH", `/api/buyers/${cim.id}`, { accessLevel: "teaser_only" }, broker);
    assert.equal(down.status, 200, down.text);
    // Offline: refused again.
    const off = await call("POST", "/api/deals/D-PAC/teaser/unpublish", {}, broker);
    assert.equal(off.status, 200);
    assert.equal(off.json.summary.status, "offline");
    const cim2 = mkAccess({ accessLevel: "named", buyerEmail: "down2@buyer.invalid" });
    const refused = await call("PATCH", `/api/buyers/${cim2.id}`, { accessLevel: "teaser_only" }, broker);
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, "teaser_not_published");
    const v = await call("GET", `/api/view/${link.accessToken}`);
    assert.equal(v.status, 403);
    assert.equal(v.json.code, "not_published");
  });

  await check("a teaser link moved up to the CIM: its open request is closed, the link follows the CIM's 30-day rule", async () => {
    const r = await call("PATCH", `/api/buyers/${link.id}`, { accessLevel: "named" }, broker);
    assert.equal(r.status, 200, r.text);
    const row = T.access.find((a) => a.id === link.id);
    assert.equal(row.accessLevel, "named");
    assert.ok(new Date(row.expiresAt).getTime() > now + 25 * DAY);
    assert.equal(row.accessEvents.filter((e: { type: string; by?: string }) => e.type === "extended" && e.by === "upgrade").length, 1);
    const req = T.approvals.find((a) => a.buyerAccessId === link.id);
    assert.equal(req.status, "access_granted");
    assert.equal(req.grantedBy, "broker");
    assert.equal(req.grantAccessLevel, "named");
  });

  void sent;
  await h.close();
  console.log(`\n${passed} checks passed`);
  process.exit(0);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
