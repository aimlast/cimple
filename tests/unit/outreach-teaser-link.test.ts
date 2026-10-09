/**
 * Outreach with teaser links (spec §4.9), through the real routes:
 *  - with a published teaser, every draft carries the line with the
 *    placeholder {teaser link} (the template path here — the AI is off; an AI
 *    draft that leaves it out gets it appended before the sign-off);
 *  - send replaces it with each buyer's OWN link: an existing active link on
 *    the deal is reused, else a teaser_only link is created once (lasting as
 *    the teaser's setting says), teaser_access_id recorded, the link escaped;
 *  - a {teaser link} email with no published teaser → 409 before anything is sent;
 *  - an email without the placeholder creates no link.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/outreach-teaser-link.test.ts
 */
import { T, now, DAY, mkAccess, seedPacific, startHarness, sent, pacificWritten, find } from "../utils/teaser-harness";
import assert from "node:assert/strict";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main() {
  const { withTeaserLink, TEASER_LINK_LINE } = await import("../../server/teaser/outreach");
  await check("an AI draft without the line gets it before the sign-off", () => {
    const body = "Hi Lee,\n\nA regional carrier in BC just came to market.\n\nBest,\nMorgan Ellis";
    const out = withTeaserLink(body, "Morgan Ellis");
    assert.equal(out, `Hi Lee,\n\nA regional carrier in BC just came to market.\n\n${TEASER_LINK_LINE}\n\nBest,\nMorgan Ellis`);
    assert.equal(withTeaserLink(out, "Morgan Ellis"), out, "kept exactly once");
  });

  const h = await startHarness();
  const { call, broker } = h;
  seedPacific();
  T.buyers.push(
    { id: "U-new", email: "lee@acquirer.invalid", name: "Lee Park", company: "Northern Freight", emailVerified: true, buyerCriteria: {}, targetIndustries: [], targetLocations: [] },
    { id: "U-has", email: "natalie@cascaderidge.invalid", name: "Natalie Vasconcelos", company: "Cascade Ridge", emailVerified: false, buyerCriteria: {}, targetIndustries: [], targetLocations: [] },
  );
  const existing = mkAccess({ accessLevel: "blind", buyerEmail: "natalie@cascaderidge.invalid" });

  await check("no published teaser: a {teaser link} email is refused before anything is sent", async () => {
    sent.length = 0;
    const r = await call("POST", "/api/deals/D-PAC/send-outreach", { outreach: [{ buyerUserId: "U-new", subject: "A carrier", body: `Hi Lee,\n\n${TEASER_LINK_LINE}\n\nBest,\nMorgan` }] }, broker);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "teaser_not_published");
    assert.equal(sent.length, 0);
    assert.equal(T.outreach.length, 0);
  });

  // Publish a teaser (links last 90 days).
  h.modelReplies.push(pacificWritten());
  await call("POST", "/api/deals/D-PAC/teaser/generate", { templateKey: "one_page" }, broker);
  const { waitForTeaser } = await import("../../server/teaser/generate");
  let row = (await waitForTeaser("D-PAC"))!;
  row = (await call("PATCH", "/api/deals/D-PAC/teaser/settings", { rev: row.draftRev, linkLifetime: "90" }, broker)).json.teaser;
  assert.equal((await call("POST", "/api/deals/D-PAC/teaser/publish", { rev: row.draftRev }, broker)).status, 200);

  await check("drafts carry the teaser line (template path) and say so", async () => {
    const r = await call("POST", "/api/deals/D-PAC/draft-outreach", { buyerUserIds: ["U-new"] }, broker);
    assert.equal(r.status, 200, r.text);
    const d = r.json.drafts[0];
    assert.equal(d.teaserLink, true);
    assert.ok(d.body.includes("{teaser link}"), d.body);
    assert.ok(d.body.includes("ask for it from the summary"), "the next step points at the summary");
    assert.ok(!/\/view\//.test(d.body), "drafts never carry a token");
  });

  await check("send: each buyer's own link — a new teaser link once, an existing link reused; HTML escaped; teaser_access_id recorded", async () => {
    sent.length = 0;
    const body = (name: string) => `Hi ${name},\n\nA regional carrier <BC> just came to market.\n\n${TEASER_LINK_LINE}\n\nBest,\nMorgan`;
    const r = await call("POST", "/api/deals/D-PAC/send-outreach", { outreach: [
      { buyerUserId: "U-new", subject: "A carrier", body: body("Lee") },
      { buyerUserId: "U-has", subject: "A carrier", body: body("Natalie") },
    ] }, broker);
    assert.equal(r.status, 200, r.text);
    const created = T.access.filter((a) => a.buyerEmail === "lee@acquirer.invalid");
    assert.equal(created.length, 1);
    assert.equal(created[0].accessLevel, "teaser_only");
    assert.equal(created[0].buyerUserId, "U-new", "a verified account is linked");
    assert.ok(Math.abs(new Date(created[0].expiresAt).getTime() - (now + 90 * DAY)) < 60_000, "lasts as the teaser's setting says");
    assert.deepEqual(created[0].accessEvents.map((e: { type: string; via?: string }) => [e.type, e.via]), [["granted", "outreach"]]);
    const leeMail = sent.find((m) => m.to.includes("lee@acquirer.invalid"))!;
    assert.ok(leeMail.html.includes(`<a href="https://app.test/view/${created[0].accessToken}"`), "the link is a link");
    assert.ok(leeMail.html.includes("&lt;BC&gt;"), "the broker's text is escaped");
    assert.ok(!leeMail.html.includes("{teaser link}"));
    const natMail = sent.find((m) => m.to.includes("natalie@cascaderidge.invalid"))!;
    assert.ok(natMail.html.includes(`/view/${existing.accessToken}`), "her existing link is reused");
    assert.equal(T.access.filter((a) => a.buyerEmail === "natalie@cascaderidge.invalid").length, 1);
    const recs = T.outreach.slice(-2);
    assert.deepEqual(recs.map((o) => o.teaserAccessId).sort(), [created[0].id, existing.id].sort());
    assert.ok(recs.every((o) => o.body.includes("{teaser link}")), "the stored body keeps the placeholder, never the token");
    // A second send reuses Lee's new link.
    await call("POST", "/api/deals/D-PAC/send-outreach", { outreach: [{ buyerUserId: "U-new", subject: "Again", body: body("Lee") }] }, broker);
    assert.equal(T.access.filter((a) => a.buyerEmail === "lee@acquirer.invalid").length, 1);
  });

  await check("an email without the placeholder creates no link", async () => {
    T.buyers.push({ id: "U-plain", email: "plain@buyer.invalid", name: "Pat", emailVerified: false, buyerCriteria: {} });
    const r = await call("POST", "/api/deals/D-PAC/send-outreach", { outreach: [{ buyerUserId: "U-plain", subject: "Hello", body: "Hi Pat,\n\nJust reply.\n\nMorgan" }] }, broker);
    assert.equal(r.status, 200, r.text);
    assert.equal(T.access.filter((a) => a.buyerEmail === "plain@buyer.invalid").length, 0);
    assert.equal(find("outreach", (o) => o.buyerEmail === "plain@buyer.invalid").teaserAccessId, null);
  });

  await h.close();
  console.log(`\n${passed} checks passed`);
  process.exit(0);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
