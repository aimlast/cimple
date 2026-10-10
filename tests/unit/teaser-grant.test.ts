/**
 * Giving access from a teaser request (POST /api/buyer-approvals/:id/broker-review,
 * grantApprovedBuyer), through the real routes:
 *  - "grant" → the SAME teaser link upgraded (token kept); expiry = max(old,
 *    the CIM's 30 days) with an `extended` event; the cim_ready email to the
 *    LINK's address, named by the codename (Blind CIM) or the name (Full CIM);
 *  - notifyBuyer:false → no buyer email;
 *  - not live → approved_waiting_publish (granted at publish: waitingForPublish);
 *  - the seller path carries the chosen level; the seller-review GET refuses
 *    approved_waiting_publish;
 *  - "reject" on a teaser request sends the short decline email;
 *  - a revoked/expired teaser link → a new link at the level;
 *  - a mismatch (signer ≠ the link's name) is flagged and never auto-granted;
 *  - auto-grant Blind CIM with the CIM live → granted at once, grantedBy auto,
 *    no buyer email; with the CIM not live → left pending;
 *  - the broker's notice uses buyer_approval_requested with escaped values;
 *  - NOTIFICATION_ROUTING is unchanged (snapshot) apart from the additive
 *    keys INTEGRATION §4.3 / §8 Q21 sanctions for gl and vdr (no existing
 *    event's recipients change; the teaser adds none).
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/teaser-grant.test.ts
 */
import { T, DAY, now, mkAccess, seedPacific, startHarness, sent, pacificWritten, PROFILE, find } from "../utils/teaser-harness";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main() {
  const h = await startHarness();
  const { call, broker } = h;
  const deal = seedPacific();
  // A published teaser.
  h.modelReplies.push(pacificWritten());
  await call("POST", "/api/deals/D-PAC/teaser/generate", { templateKey: "one_page" }, broker);
  const { waitForTeaser } = await import("../../server/teaser/generate");
  const row = await waitForTeaser("D-PAC");
  assert.equal((await call("POST", "/api/deals/D-PAC/teaser/publish", { rev: row!.draftRev }, broker)).status, 200);

  const mkRequest = (link: ReturnType<typeof mkAccess>, o: Record<string, unknown> = {}) => {
    const r = {
      id: `R-${link.id}`, dealId: link.dealId, submittedBy: "buyer", buyerName: link.buyerName, buyerEmail: link.buyerEmail, buyerCompany: link.buyerCompany,
      category: "pe_generalist", riskLevel: "low", status: "pending_broker_review", sellerReviewToken: `srt-${link.id}`, source: "teaser_request", buyerAccessId: link.id,
      grantAccessLevel: null, grantedBy: null, ndaSigned: true, teaserRequest: { linkName: link.buyerName, linkEmail: link.buyerEmail, signerName: link.buyerName, emailCheck: "code", mismatch: false },
      createdAt: new Date(), updatedAt: new Date(), ...o,
    };
    T.approvals.push(r);
    return r;
  };

  await check("grant (Blind CIM): the same link upgraded, token kept, expiry from today, the email to the link's address under the codename", async () => {
    const link = mkAccess({ expiresAt: new Date(now + 5 * DAY) });
    const req = mkRequest(link);
    sent.length = 0;
    const r = await call("POST", `/api/buyer-approvals/${req.id}/broker-review`, { action: "grant", grantLevel: "blind" }, broker);
    assert.equal(r.status, 200, r.text);
    const a = find("access", (x) => x.id === link.id);
    assert.equal(a.accessLevel, "blind");
    assert.equal(a.accessToken, link.accessToken, "one link, kept");
    assert.ok(new Date(a.expiresAt).getTime() > now + 25 * DAY, "30 days from today");
    assert.ok(a.accessEvents.some((e: { type: string; by?: string }) => e.type === "extended" && e.by === "upgrade"));
    assert.ok(a.accessEvents.some((e: { type: string; accessLevel?: string }) => e.type === "level_changed" && e.accessLevel === "blind"));
    const rq = find("approvals", (x) => x.id === req.id);
    assert.deepEqual([rq.status, rq.grantedBy, rq.grantAccessLevel, rq.grantedBuyerAccessId], ["access_granted", "broker", "blind", link.id]);
    const mail = sent.find((m) => m.to.includes("natalie@cascaderidge.invalid"))!;
    assert.ok(mail, "the buyer is told");
    assert.equal(mail.subject, "The CIM for Project Meridian is ready");
    assert.ok(!/Pacific/.test(mail.html));
    assert.ok(mail.html.includes(`/view/${link.accessToken}`), "the same link");
    assert.equal(T.access.filter((x) => x.buyerEmail === link.buyerEmail).length, 1, "no new link");
    const notice = T.notifications.filter((n) => n.type === "buyer_approval_seller_approved").at(-1);
    assert.equal(notice.title, "You gave Natalie Vasconcelos the Blind CIM");
  });

  await check("grant (Full CIM) names the business; an expiry already later is kept", async () => {
    const link = mkAccess({ buyerEmail: "lee@acquirer.invalid", buyerName: "Lee Park", expiresAt: new Date(now + 60 * DAY) });
    const req = mkRequest(link);
    sent.length = 0;
    await call("POST", `/api/buyer-approvals/${req.id}/broker-review`, { action: "grant", grantLevel: "named" }, broker);
    const a = find("access", (x) => x.id === link.id);
    assert.equal(a.accessLevel, "named");
    assert.equal(new Date(a.expiresAt).getTime(), now + 60 * DAY);
    assert.equal(sent.find((m) => m.to.includes("lee@acquirer.invalid"))!.subject, "The CIM for Pacific Coast Logistics Ltd. is ready");
  });

  await check("notifyBuyer:false → no buyer email; the teaser level can never be granted", async () => {
    const link = mkAccess({ buyerEmail: "quiet@buyer.invalid" });
    const req = mkRequest(link);
    sent.length = 0;
    const r = await call("POST", `/api/buyer-approvals/${req.id}/broker-review`, { action: "grant", grantLevel: "due_diligence", notifyBuyer: false }, broker);
    assert.equal(r.status, 200, r.text);
    assert.ok(!sent.some((m) => m.to.includes("quiet@buyer.invalid")));
    assert.equal(find("access", (x) => x.id === link.id).accessLevel, "due_diligence");
    const link2 = mkAccess({ buyerEmail: "t@buyer.invalid" });
    const req2 = mkRequest(link2);
    const bad = await call("POST", `/api/buyer-approvals/${req2.id}/broker-review`, { action: "grant", grantLevel: "teaser_only" }, broker);
    assert.equal(bad.status, 400);
  });

  await check("not live → approved_waiting_publish (granted at publish); the seller-review GET refuses it", async () => {
    deal.isLive = false;
    const link = mkAccess({ buyerEmail: "wait@buyer.invalid" });
    const req = mkRequest(link);
    const r = await call("POST", `/api/buyer-approvals/${req.id}/broker-review`, { action: "grant", grantLevel: "named" }, broker);
    assert.equal(r.status, 200, r.text);
    const rq = find("approvals", (x) => x.id === req.id);
    assert.deepEqual([rq.status, rq.grantedBy, rq.grantAccessLevel], ["approved_waiting_publish", "broker", "named"]);
    assert.equal(find("access", (x) => x.id === link.id).accessLevel, "teaser_only", "nothing opened yet");
    const { waitingForPublish } = await import("../../server/teaser/requests");
    assert.equal(waitingForPublish(rq), true);
    assert.equal(waitingForPublish({ ...rq, grantedBuyerAccessId: "A1" }), false);
    assert.equal(waitingForPublish({ status: "pending_broker_review" }), false);
    const g = await call("GET", `/api/buyer-approval-review/${rq.sellerReviewToken}`);
    assert.equal(g.status, 403);
    deal.isLive = true;
  });

  await check("the seller path carries the chosen level", async () => {
    const link = mkAccess({ buyerEmail: "seller-path@buyer.invalid" });
    const req = mkRequest(link);
    await call("POST", `/api/buyer-approvals/${req.id}/broker-review`, { action: "approve", grantLevel: "named" }, broker);
    const rq = find("approvals", (x) => x.id === req.id);
    assert.deepEqual([rq.status, rq.grantAccessLevel, rq.grantedBy], ["pending_seller_review", "named", "seller"]);
    const r = await call("POST", `/api/buyer-approval-review/${rq.sellerReviewToken}`, { action: "approve", reviewerName: "Harjit" });
    assert.equal(r.status, 200, r.text);
    assert.equal(find("access", (x) => x.id === link.id).accessLevel, "named");
  });

  await check("decline: a short polite email to a teaser requester, no reason given", async () => {
    const link = mkAccess({ buyerEmail: "no@buyer.invalid", buyerName: "Dana Wu" });
    const req = mkRequest(link);
    sent.length = 0;
    const r = await call("POST", `/api/buyer-approvals/${req.id}/broker-review`, { action: "reject", notes: "Competitor" }, broker);
    assert.equal(r.status, 200, r.text);
    const mail = sent.find((m) => m.to.includes("no@buyer.invalid"))!;
    assert.equal(mail.subject, "Your request about Project Meridian");
    assert.ok(!/Competitor/.test(mail.html), "no reason given");
    assert.match(mail.html, /isn't able to share more on this opportunity right now/);
  });

  await check("an expired teaser link → a new link at the level", async () => {
    const link = mkAccess({ buyerEmail: "old@buyer.invalid", expiresAt: new Date(now - DAY) });
    const req = mkRequest(link);
    const r = await call("POST", `/api/buyer-approvals/${req.id}/broker-review`, { action: "grant", grantLevel: "blind", notifyBuyer: false }, broker);
    assert.equal(r.status, 200, r.text);
    const rows = T.access.filter((x) => x.buyerEmail === "old@buyer.invalid");
    assert.equal(rows.length, 2);
    assert.equal(rows[1].accessLevel, "blind");
    assert.equal(find("access", (x) => x.id === link.id).accessLevel, "teaser_only", "the old link is left as it was");
  });

  await check("auto-grant Blind CIM with the CIM live: at once, grantedBy auto, no buyer email; a name mismatch is never auto-granted", async () => {
    await h.teasers.update("D-PAC", () => ({ autoGrant: "blind" }));
    // Matching name: auto.
    const link = mkAccess({ buyerEmail: "auto@buyer.invalid", buyerName: "Natalie Vasconcelos" });
    await call("POST", `/api/view/${link.accessToken}/email-check`);
    const code = /(\d{3}) (\d{3})/.exec(h.codes.at(-1)!.html)!.slice(1).join("");
    await call("POST", `/api/view/${link.accessToken}/email-check/verify`, { code });
    const p = await call("GET", `/api/view/${link.accessToken}/buyer-profile`);
    sent.length = 0;
    const s = await call("POST", `/api/view/${link.accessToken}/sign-nda`, { profile: PROFILE, signerName: "Natalie Vasconcelos", termsHash: p.json.nda.hash });
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.autoGranted, true);
    assert.equal(find("access", (x) => x.id === link.id).accessLevel, "blind");
    const rq = T.approvals.find((x) => x.buyerAccessId === link.id);
    assert.deepEqual([rq.status, rq.grantedBy], ["access_granted", "auto"]);
    assert.ok(!sent.some((m) => m.to.includes("auto@buyer.invalid")), "no buyer email");
    // Mismatch: signed by someone else → waits for the broker.
    const link2 = mkAccess({ buyerEmail: "fwd@buyer.invalid", buyerName: "Natalie Vasconcelos" });
    await call("POST", `/api/view/${link2.accessToken}/email-check`);
    const code2 = /(\d{3}) (\d{3})/.exec(h.codes.at(-1)!.html)!.slice(1).join("");
    await call("POST", `/api/view/${link2.accessToken}/email-check/verify`, { code: code2 });
    const p2 = await call("GET", `/api/view/${link2.accessToken}/buyer-profile`);
    const s2 = await call("POST", `/api/view/${link2.accessToken}/sign-nda`, { profile: { ...PROFILE, name: "Dana Wu" }, signerName: "Dana Wu", termsHash: p2.json.nda.hash });
    assert.equal(s2.status, 200, s2.text);
    assert.equal(s2.json.autoGranted, false);
    const rq2 = T.approvals.find((x) => x.buyerAccessId === link2.id);
    assert.equal(rq2.status, "pending_broker_review");
    assert.equal(rq2.teaserRequest.mismatch, true);
    assert.equal(find("access", (x) => x.id === link2.id).accessLevel, "teaser_only");
  });

  await check("auto-grant never applies before the CIM is live", async () => {
    deal.isLive = false;
    const link = mkAccess({ buyerEmail: "early@buyer.invalid", buyerName: "Natalie Vasconcelos" });
    await call("POST", `/api/view/${link.accessToken}/email-check`);
    const code = /(\d{3}) (\d{3})/.exec(h.codes.at(-1)!.html)!.slice(1).join("");
    await call("POST", `/api/view/${link.accessToken}/email-check/verify`, { code });
    const p = await call("GET", `/api/view/${link.accessToken}/buyer-profile`);
    const s = await call("POST", `/api/view/${link.accessToken}/sign-nda`, { profile: PROFILE, signerName: "Natalie Vasconcelos", termsHash: p.json.nda.hash });
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.autoGranted, false);
    assert.equal(T.approvals.find((x) => x.buyerAccessId === link.id).status, "pending_broker_review");
    deal.isLive = true;
    await h.teasers.update("D-PAC", () => ({ autoGrant: "off" }));
  });

  await check("the broker is told with the existing event; buyer-typed values are escaped", async () => {
    const link = mkAccess({ buyerEmail: "xss@buyer.invalid", buyerName: "Eve" });
    await call("POST", `/api/view/${link.accessToken}/email-check`);
    const code = /(\d{3}) (\d{3})/.exec(h.codes.at(-1)!.html)!.slice(1).join("");
    await call("POST", `/api/view/${link.accessToken}/email-check/verify`, { code });
    const p = await call("GET", `/api/view/${link.accessToken}/buyer-profile`);
    await call("POST", `/api/view/${link.accessToken}/sign-nda`, { profile: { ...PROFILE, name: "Eve", background: 'We buy firms. <a href="https://evil.invalid">click</a>' }, signerName: "Eve", termsHash: p.json.nda.hash });
    const n = T.notifications.filter((x) => x.type === "buyer_approval_requested").at(-1);
    assert.equal(n.title, "Eve asked for the CIM");
    assert.ok(!n.body.includes('<a href="https://evil.invalid">'), "escaped");
    assert.ok(n.body.includes("&lt;a href="));
    assert.equal(n.metadata.source, "teaser_request");
  });

  await check("NOTIFICATION_ROUTING is unchanged (snapshot)", async () => {
    const { NOTIFICATION_ROUTING } = await import("../../shared/schema");
    // The keys other streams may ADD (never change an existing one): gl's two, vdr's one (merged at release step 6).
    const added = Object.keys(NOTIFICATION_ROUTING).filter((k) => SANCTIONED_ADDITIONS.includes(k));
    const base = Object.fromEntries(Object.entries(NOTIFICATION_ROUTING).filter(([k]) => !SANCTIONED_ADDITIONS.includes(k)));
    const digest = createHash("sha256").update(JSON.stringify(base)).digest("hex").slice(0, 16);
    assert.ok(!("teaser_request" in NOTIFICATION_ROUTING) && !("buyer_asked_for_cim" in NOTIFICATION_ROUTING));
    assert.ok("buyer_approval_requested" in NOTIFICATION_ROUTING);
    console.log(`    (routing digest ${digest}; sanctioned additions present: ${added.join(", ") || "none"})`);
    assert.equal(digest, ROUTING_DIGEST, "NOTIFICATION_ROUTING changed — the teaser must not touch it");
    const routing = NOTIFICATION_ROUTING as Record<string, { teams: string[]; roles: string[] }>;
    if ("seller_document_request" in routing) {
      assert.deepEqual(routing.seller_document_request, { teams: ["seller"], roles: ["owner", "representative", "accountant"] }, "vdr's key as INTEGRATION §4.3 lists it");
    }
  });

  await h.close();
  console.log(`\n${passed} checks passed`);
  process.exit(0);
}
/** sha256 of JSON.stringify(NOTIFICATION_ROUTING) at the base (c12adfb), first 16 hex. */
const ROUTING_DIGEST = "3dc6390740ad9e4c";
/** INTEGRATION §4.3 / §8 Q21: the only keys a later stream may add (gl: 2, vdr: 1), each additive. */
const SANCTIONED_ADDITIONS = ["seller_gl_request", "gl_needs_broker", "seller_document_request"];
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
