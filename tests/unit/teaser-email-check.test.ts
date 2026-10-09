/**
 * The email check on a teaser link (server/teaser/email-check.ts):
 *  - the code goes to the link's own address only;
 *  - a wrong code → triesLeft; 5 failures lock it; expiry → "expired";
 *  - the send limits (3 an hour, 10 a day per link);
 *  - a verified buyer account with the same email skips it; a different email doesn't;
 *  - a demo deal skips it without sending;
 *  - only the HMAC is stored (never the code).
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/teaser-email-check.test.ts
 */
import assert from "node:assert/strict";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main() {
  process.env.SESSION_SECRET = "test-secret";
  const ec = await import("../../server/teaser/email-check");
  const { storage } = await import("../../server/storage");
  const mem = ec.memoryEmailCheckStore();
  ec._setEmailCheckStoreForTests(mem);
  const sent: Array<{ to: string; subject: string; html: string }> = [];
  ec._setEmailSenderForTests(async (to, subject, html) => {
    sent.push({ to, subject, html });
    return true;
  });
  const buyers: Record<string, { id: string; email: string; emailVerified: boolean }> = {
    good: { id: "good", email: "natalie@cascaderidge.invalid", emailVerified: true },
    unverified: { id: "unverified", email: "natalie@cascaderidge.invalid", emailVerified: false },
    other: { id: "other", email: "someone@else.invalid", emailVerified: true },
  };
  (storage as unknown as { getBuyerUser: (id: string) => Promise<unknown> }).getBuyerUser = async (id: string) => buyers[id];

  const access = { id: "A1", dealId: "D1", accessToken: "tok-1", buyerEmail: "natalie@cascaderidge.invalid" };
  const deal = { demoKey: null, businessName: "Pacific Coast Logistics Ltd.", blindCodename: "Project Meridian" };
  const codeOf = () => /(\d{3}) (\d{3})/.exec(sent[sent.length - 1].html)!.slice(1).join("");

  await check("the code goes to the link's own address, named by the codename; only the HMAC is stored", async () => {
    const r = await ec.sendEmailCode(access as never, deal as never);
    assert.deepEqual(r, { sent: true, maskedEmail: "n•••@cascaderidge.invalid" });
    assert.equal(sent[0].to, "natalie@cascaderidge.invalid");
    assert.equal(sent[0].subject, "Your code for Project Meridian");
    assert.ok(!/Pacific/.test(sent[0].html));
    assert.match(sent[0].html, /works for 15 minutes/);
    const code = codeOf();
    const row = mem.rows[0];
    assert.notEqual(row.codeHash, code);
    assert.ok(!JSON.stringify(mem.rows).includes(code), "the code itself is never stored");
    assert.equal(row.codeHash, ec.codeHash("A1", code));
  });

  await check("a wrong code → triesLeft; the right one verifies; the state then reads verified", async () => {
    const code = codeOf();
    const wrong = code === "123456" ? "654321" : "123456";
    assert.deepEqual(await ec.verifyEmailCode(access, wrong), { verified: false, code: "wrong", triesLeft: 4 });
    assert.deepEqual(await ec.verifyEmailCode(access, code.slice(0, 3) + " " + code.slice(3)), { verified: true });
    const st = await ec.emailCheckState(access as never, deal as never, null);
    assert.deepEqual([st.needed, st.verified, st.method], [false, true, "code"]);
  });

  await check("5 failures lock the code; an expired code says so", async () => {
    ec._resetEmailCheckLimitsForTests();
    const a2 = { ...access, id: "A2", accessToken: "tok-2" };
    await ec.sendEmailCode(a2 as never, deal as never);
    for (let i = 0; i < 4; i++) await ec.verifyEmailCode(a2, "000001");
    assert.deepEqual(await ec.verifyEmailCode(a2, "000001"), { verified: false, code: "locked" });
    assert.deepEqual(await ec.verifyEmailCode(a2, codeOf()), { verified: false, code: "locked" }, "even the right code, once locked");
    const a3 = { ...access, id: "A3", accessToken: "tok-3" };
    await ec.sendEmailCode(a3 as never, deal as never);
    assert.deepEqual(await ec.verifyEmailCode(a3, codeOf(), Date.now() + ec.CODE_TTL_MS + 1000), { verified: false, code: "expired" });
  });

  await check("send limits: 3 an hour per link", async () => {
    ec._resetEmailCheckLimitsForTests();
    const a4 = { ...access, id: "A4", accessToken: "tok-4" };
    for (let i = 0; i < 3; i++) assert.ok("sent" in (await ec.sendEmailCode(a4 as never, deal as never)));
    const fourth = await ec.sendEmailCode(a4 as never, deal as never, { firm: "Brassline Advisory Partners" });
    assert.ok("limited" in fourth);
    assert.match((fourth as { error: string }).error, /Try again in an hour or contact Brassline Advisory Partners/);
  });

  await check("a signed-in, verified account with the link's email skips the check; another email doesn't; unverified doesn't", async () => {
    const a5 = { ...access, id: "A5", accessToken: "tok-5" };
    assert.deepEqual((await ec.emailCheckState(a5 as never, deal as never, "good")).method, "account");
    assert.equal((await ec.emailCheckState(a5 as never, deal as never, "other")).verified, false);
    assert.equal((await ec.emailCheckState(a5 as never, deal as never, "unverified")).verified, false);
    const before = sent.length;
    assert.ok("skipped" in (await ec.sendEmailCode(a5 as never, deal as never, { buyerId: "good" })));
    assert.equal(sent.length, before, "nothing sent");
    const req = await ec.requireEmailCheck(a5 as never, deal as never, "good");
    assert.deepEqual(req, { ok: true, method: "account" });
    assert.equal(mem.rows.filter((r) => r.buyerAccessId === "A5" && r.method === "account").length, 1, "recorded as the method");
  });

  await check("a demo deal skips the check without sending", async () => {
    const a6 = { ...access, id: "A6", accessToken: "tok-6" };
    const demo = { ...deal, demoKey: "pacific-qa-oct" };
    const before = sent.length;
    assert.ok("skipped" in (await ec.sendEmailCode(a6 as never, demo as never)));
    assert.equal(sent.length, before);
    assert.deepEqual(await ec.requireEmailCheck(a6 as never, demo as never, null), { ok: true, method: "demo" });
    assert.deepEqual(await ec.requireEmailCheck({ ...access, id: "A7" } as never, deal as never, null), { ok: false });
  });

  console.log(`\n${passed} checks passed`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
