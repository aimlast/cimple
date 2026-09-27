// FREE round, stream "interview" (review F3, F4, F6, F7): the interview
// screen's pure sync rules — which question an answer belongs to, what a
// failed send does, when the room's transcript goes to the AI, and who the
// broker is on a Zoom / Meet / Teams call.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f-interview-client.test.ts
import assert from "node:assert/strict";
import {
  answeringAt,
  afterFailedSend,
  liveExchangeText,
  brokerNameFromMe,
  botSpeakerFor,
  newBotSpeakerState,
  type LiveLine,
} from "../../client/src/lib/interview-sync";

let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };

// ── F3: the question being answered ──
{
  const msgs = [
    { role: "ai", content: "How many staff?", timestamp: "t1" },
    { role: "user", content: "14", timestamp: "t2" },
    { role: "ai", content: "How many full time?", timestamp: "t3" },
    { role: "user", content: "10", timestamp: "t4" },
    { role: "ai", content: "I'm sorry, something went wrong on my end…", timestamp: "t5" },
  ];
  assert.equal(answeringAt(msgs, new Set(["t5"])), "t3", "a local error bubble is not the question");
  assert.equal(answeringAt(msgs, new Set()), "t5");
  assert.equal(answeringAt([], new Set()), undefined);
  ok("F3: answeringAt is the last saved AI question, skipping bubbles the page wrote itself");
}

// ── F4: a failed send the server saved anyway ──
{
  const saved = [
    { role: "ai", content: "How many staff?", timestamp: "t1" },
    { role: "user", content: "We have 14 staff", timestamp: "t2" },
    { role: "ai", content: "How many of them are full time?", timestamp: "t3" },
  ];
  // The phone locked mid-turn; the server finished: show its reply, no resend.
  assert.equal(afterFailedSend(saved, "We have 14 staff"), "adopt");
  assert.equal(afterFailedSend(saved, "  We have   14 staff​ "), "adopt", "whitespace and the dictation marker don't matter");
  // The server hasn't got it (or is still working): the answer goes back in the box.
  assert.equal(afterFailedSend(saved.slice(0, 1), "We have 14 staff"), "restore");
  assert.equal(afterFailedSend([...saved.slice(0, 2)], "We have 14 staff"), "restore", "no reply saved yet");
  assert.equal(afterFailedSend(saved, "About 20 of us"), "restore", "a different answer (out of step) goes back in the box");
  assert.equal(afterFailedSend(null, "x"), "restore");
  ok("F4: after a failed send the saved transcript is adopted when the answer was recorded, else the answer is restored");
}

// ── F6: short spoken answers are sent ──
{
  const label = (s: number) => (s === 0 ? "Broker" : "Seller");
  const question = "Do you own the building or lease it?";
  const isEcho = (t: string) => /own the building or lease/i.test(t);
  const base = { label, isEcho };
  const lines = (...l: Array<[number, string]>): LiveLine[] => l.map(([speaker, text]) => ({ speaker, text }));
  // Broker reads the question, the seller answers in three words, silence → sent.
  assert.equal(
    liveExchangeText(lines([0, "Do you own the building or lease it?"], [1, "We lease it."]), 0, base),
    "Seller: We lease it.",
    "a three-word answer goes after the pause (the question read aloud is dropped)",
  );
  for (const short of ["About forty.", "Twelve years.", "No, all owned.", "Around two million"]) {
    assert.ok(liveExchangeText(lines([1, short]), 0, base), short);
  }
  // Only the broker has spoken (reading the question): nothing to send yet.
  assert.equal(liveExchangeText(lines([0, "Do you own the building or lease it?"]), 0, base), null);
  // The broker spoke after a short seller line (a follow-up): wait for a real answer…
  assert.equal(liveExchangeText(lines([1, "Lease."], [0, "And how long is left on it?"]), 0, base), null);
  // …a real answer then goes.
  assert.ok(liveExchangeText(lines([1, "We lease it from my brother-in-law."], [0, "And the term?"]), 0, base));
  // "Send now" sends whatever is there, even one short line or a broker note.
  assert.equal(liveExchangeText(lines([1, "Lease."], [0, "And how long is left on it?"]), 0, { ...base, force: true }), "Seller: Lease.\nBroker: And how long is left on it?");
  assert.equal(liveExchangeText(lines([0, "He says skip this one."]), 0, { ...base, force: true }), "Broker: He says skip this one.");
  assert.equal(liveExchangeText(lines([0, question]), 0, { ...base, force: true }), null, "the question read aloud alone is never an answer");
  // No broker known yet (in person, before the echo): every line counts as the seller's.
  assert.ok(liveExchangeText(lines([0, "Yes."]), null, { label: (s) => `Speaker ${s + 1}`, isEcho }));
  void question;
  ok("F6: the pause sends short seller answers; a broker follow-up waits for a real answer; Send now always sends");
}

// ── F7: the notetaker recognises the broker by name ──
{
  assert.equal(brokerNameFromMe({ user: { id: "u1", username: "mellis", name: "Morgan Ellis" } }), "morgan ellis", "GET /me answers { user: {…} }");
  assert.equal(brokerNameFromMe({ user: { username: "qa_cimgen", name: null } }), "qa_cimgen");
  assert.equal(brokerNameFromMe(null), "");

  // The SELLER hosts the Zoom; the broker joins: labels must not invert.
  const st = newBotSpeakerState();
  const s1 = botSpeakerFor(st, { participantId: 101, name: "Diane Kline-Morrow", isHost: true }, "morgan ellis");
  assert.equal(st.broker, null, "the host is not assumed to be the broker when the broker's name is known");
  const s2 = botSpeakerFor(st, { participantId: 202, name: "Morgan Ellis", isHost: false }, "morgan ellis");
  assert.equal(st.broker, s2);
  assert.notEqual(s1, s2);
  assert.equal(st.brokerBy, "name");
  // A display name with only the first name still matches.
  const st2 = newBotSpeakerState();
  botSpeakerFor(st2, { participantId: "a", name: "Morgan (Brassline)", isHost: false }, "morgan ellis");
  assert.equal(st2.broker, 0);
  // No broker name known: the host is the fallback.
  const st3 = newBotSpeakerState();
  botSpeakerFor(st3, { participantId: "x", name: "Guest", isHost: false }, "");
  botSpeakerFor(st3, { participantId: "y", name: "Host person", isHost: true }, "");
  assert.equal(st3.broker, 1);
  assert.equal(st3.brokerBy, "host");
  // A third participant gets a third speaker (label buttons work per person); the broker's pick stands.
  const s3 = botSpeakerFor(st, { participantId: 303, name: "Rob Kline", isHost: false }, "morgan ellis");
  assert.equal(s3, 2);
  st.broker = s1; st.brokerBy = "picked";
  botSpeakerFor(st, { participantId: 202, name: "Morgan Ellis", isHost: false }, "morgan ellis");
  assert.equal(st.broker, s1, "the broker's own 'this is me' is never overruled");
  ok("F7: the notetaker reads the broker's name from /me, prefers a name match over the host, and keys speakers by participant");
}

process.stdout.write(`\n${n} groups passed\n`);
