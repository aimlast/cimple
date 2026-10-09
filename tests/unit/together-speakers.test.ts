/**
 * Interview together — who is speaking, and the pure rules of a sitting's
 * lines (shared/together-speakers.ts, shared/together.ts):
 *  - the helpers moved from the old question flow keep working where they
 *    were (client/src/lib/interview-sync.ts and AIConversationInterface re-export them);
 *  - automatic roles: Daily (you = broker, the other = seller), typed lines
 *    are the broker's, the browser's basic recognition is no one, the room's
 *    broker is whoever reads a suggested question aloud (or asks 2 of the
 *    first 4 questions), the meeting's broker is the name match (else the
 *    host) and a third participant stays unknown; the broker's own choice
 *    always wins and the other voice follows;
 *  - lines: body validation, the cross-speaker duplicate rule, a legacy
 *    "Broker: … / Seller: …" exchange reduced to the seller's words;
 *  - the notetaker's states and the listening copy.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/together-speakers.test.ts
 */
import assert from "node:assert/strict";
import * as shared from "../../shared/together-speakers";
import * as sync from "../../client/src/lib/interview-sync";
import {
  CROSS_SPEAKER_DUPLICATE_MS,
  isCrossSpeakerDuplicate,
  listenCopy,
  listenIsProblem,
  notetakerState,
  sellerPartOfExchange,
  summaryLine,
  validateLinesBody,
  type ListenState,
} from "../../shared/together";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

// ── Moved helpers are the same functions where they used to live ──
assert.equal(sync.nameMatches, shared.nameMatches);
assert.equal(sync.botSpeakerFor, shared.botSpeakerFor);
assert.equal(sync.newBotSpeakerState, shared.newBotSpeakerState);
assert.equal(sync.brokerNameFromMe, shared.brokerNameFromMe);
assert.equal(sync.isThinkingAloud, shared.isThinkingAloud);
assert.equal(sync.looksLikeQuestionEcho, shared.looksLikeQuestionEcho);
assert.ok(shared.nameMatches("Morgan Ellis (Brassline)", "morgan ellis"));
assert.ok(!shared.nameMatches("Morgan Smith", "morgan ellis"));
assert.ok(shared.isThinkingAloud("Hmm, let me think."));
assert.ok(!shared.isThinkingAloud("About forty."));
assert.ok(shared.looksLikeQuestionEcho("which months are your busiest and quietest", "Which months are your busiest, and which are the quietest?"));
assert.ok(!shared.looksLikeQuestionEcho("June through August, then December", "Which months are your busiest, and which are the quietest?"));
ok("moved helpers: one implementation, re-exported from interview-sync");

// ── Automatic roles ──
{
  const r = shared.autoRoles({}, [
    { speaker: "daily:local", text: "So what are the busy months?" },
    { speaker: "daily:abc123", text: "Summer, mostly." },
    { speaker: "typed:broker", text: "22 trucks" },
  ]);
  assert.equal(r.speakers["daily:local"].role, "broker");
  assert.equal(r.speakers["daily:abc123"].role, "seller");
  assert.equal(r.speakers["typed:broker"].role, "broker");
  assert.ok(r.changed);
  ok("Cimple call: your microphone is the broker, the other participant the seller; typed lines are yours");
}
{
  const r = shared.autoRoles({}, [{ speaker: "room", text: "We lease the building." }]);
  assert.equal(r.speakers.room.role, "unknown", "basic listening never knows who spoke");
  ok("basic listening: never anyone (answers are only possible answers)");
}
{
  const asks = ["Which months are your busiest, and which are the quietest?", "How many people work in the business, full-time and part-time?"];
  const r = shared.autoRoles({}, [
    { speaker: "dg:0", text: "Which months are your busiest and which are the quietest" },
    { speaker: "dg:1", text: "June to August, then the cold snaps." },
  ], { asks });
  assert.equal(r.speakers["dg:0"].role, "broker");
  assert.equal(r.speakers["dg:0"].by, "auto");
  assert.equal(r.speakers["dg:1"].role, "seller");
  const q = shared.autoRoles({}, [
    { speaker: "dg:1", text: "We started in 2009." },
    { speaker: "dg:0", text: "Who owns the shares?" },
    { speaker: "dg:1", text: "My wife and me." },
    { speaker: "dg:0", text: "And is the building yours?" },
  ]);
  assert.equal(q.speakers["dg:0"].role, "broker", "asked 2 of the first 4 questions");
  assert.equal(q.speakers["dg:1"].role, "seller");
  const none = shared.autoRoles({}, [{ speaker: "dg:0", text: "Hello there." }, { speaker: "dg:1", text: "Hi." }]);
  assert.equal(none.speakers["dg:0"].role, "unknown");
  assert.equal(none.speakers["dg:1"].role, "unknown");
  ok("in the room: the voice reading a suggested question (or asking 2 of the first 4) is the broker, the other the seller; otherwise unknown");
}
{
  const lines = [
    { speaker: "rc:7", text: "Thanks for joining.", name: "Morgan Ellis", isHost: false },
    { speaker: "rc:9", text: "Happy to.", name: "Tony Moretti", isHost: true },
    { speaker: "rc:12", text: "I'm the accountant.", name: "Denise Park", isHost: false },
  ];
  const r = shared.autoRoles({}, lines, { brokerName: "morgan ellis" });
  assert.equal(r.speakers["rc:7"].role, "broker", "the name match, not the host");
  assert.equal(r.speakers["rc:9"].role, "seller");
  assert.equal(r.speakers["rc:12"].role, "unknown", "a third participant is never filed as the seller");
  assert.equal(r.speakers["rc:9"].name, "Tony Moretti");
  const host = shared.autoRoles({}, lines.slice(0, 2), { brokerName: "" });
  assert.equal(host.speakers["rc:9"].role, "broker", "no display name: the host");
  assert.equal(host.speakers["rc:7"].role, "seller");
  const noMatch = shared.autoRoles({}, lines.slice(0, 2), { brokerName: "jamie lee" });
  assert.equal(noMatch.speakers["rc:7"].role, "unknown", "a name that matches nobody: nobody is guessed");
  ok("meetings: the broker by name (else the host), the first other participant the seller, a third one unknown");
}
{
  // The broker's choice wins and the other voice follows.
  const present = ["dg:0", "dg:1"];
  const chosen = shared.applySpeakerChoice({ "dg:0": { role: "broker", by: "auto" }, "dg:1": { role: "seller", by: "auto" } }, present, "dg:1", "broker");
  assert.deepEqual(chosen["dg:1"], { role: "broker", by: "broker" });
  assert.equal(chosen["dg:0"].role, "seller");
  const again = shared.autoRoles(chosen, [{ speaker: "dg:0", text: "Which months are your busiest?" }, { speaker: "dg:1", text: "Fine." }], { asks: ["Which months are your busiest, and which are the quietest?"] });
  assert.equal(again.speakers["dg:1"].role, "broker", "automatic rules never overrule the broker");
  assert.equal(again.speakers["dg:0"].role, "seller");
  const other = shared.applySpeakerChoice({}, ["dg:0", "dg:1", "dg:2"], "dg:2", "other");
  assert.equal(other["dg:2"].role, "other");
  assert.equal(other["dg:0"], undefined, "three voices: nothing follows");
  ok("the broker's choice always wins; in a two-voice room the other follows");
}
{
  const sp = { "dg:0": { role: "broker" as const, by: "auto" as const }, "dg:1": { role: "seller" as const, by: "auto" as const } };
  assert.equal(shared.lineRole(sp, { speaker: "dg:0" }), "broker");
  assert.equal(shared.lineRole(sp, { speaker: "dg:0", attested: true }), "seller", "a line the broker attested counts as the seller's");
  assert.equal(shared.lineRole({}, { speaker: "daily:local" }), "broker");
  assert.equal(shared.lineRole({}, { speaker: "room" }), "unknown");
  assert.ok(shared.rolesKnown(sp, ["dg:0", "dg:1"]));
  assert.ok(!shared.rolesKnown({}, ["dg:0", "dg:1"]));
  assert.ok(!shared.rolesKnown({}, ["room"]));
  assert.equal(shared.speakerDisplay("dg:1", undefined, ["dg:0", "dg:1"]), "Speaker 2");
  ok("line roles (attested = the seller's), roles known, display names");
}

// ── Lines ──
{
  const good = { clientId: "3f2a9c1e-aaaa-bbbb-cccc-000000000001", lines: [{ clientSeq: 0, speaker: "dg:0", text: "Hello", source: "deepgram" }] };
  assert.equal(validateLinesBody(good).ok, true);
  assert.equal(validateLinesBody({ ...good, clientId: "bad id!" }).ok, false);
  assert.equal(validateLinesBody({ ...good, clientId: "x".repeat(65) }).ok, false);
  assert.equal(validateLinesBody({ ...good, lines: Array.from({ length: 51 }, (_, i) => ({ clientSeq: i, speaker: "dg:0", text: "a", source: "deepgram" })) }).ok, false);
  assert.equal(validateLinesBody({ ...good, lines: [{ clientSeq: 0, speaker: "dg:0", text: "x".repeat(2001), source: "deepgram" }] }).ok, false);
  assert.equal(validateLinesBody({ ...good, lines: [{ clientSeq: 0, speaker: "dg 0", text: "a", source: "deepgram" }] }).ok, false);
  assert.equal(validateLinesBody({ ...good, lines: [{ clientSeq: 0, speaker: "rc:1", text: "a", source: "recall" }] }).ok, false, "only the webhook adds the notetaker's lines");
  assert.equal(validateLinesBody({ ...good, lines: [{ clientSeq: 0, speaker: "dg:0", text: "a", source: "typed" }] }).ok, false, "typed lines are the broker's");
  assert.equal(validateLinesBody({ ...good, lines: [{ clientSeq: -1, speaker: "dg:0", text: "a", source: "deepgram" }] }).ok, false);
  assert.equal(validateLinesBody({ ...good, lines: [{ clientSeq: 0, speaker: "dg:0", text: "   ", source: "deepgram" }] }).ok, false);
  ok("lines: page id, ≤ 50 per request, ≤ 2,000 characters, speaker ids, sources, numbers");
}
{
  const now = Date.now();
  const recent = [{ speaker: "dg:0", text: "We have twenty-two trucks.", at: new Date(now - 1_000) }];
  assert.ok(isCrossSpeakerDuplicate(recent, { speaker: "dg:1", text: "we have twenty two trucks" }, now), "the other microphone's copy");
  assert.ok(!isCrossSpeakerDuplicate(recent, { speaker: "dg:0", text: "We have twenty-two trucks." }, now), "the same speaker repeating is not a duplicate");
  assert.ok(!isCrossSpeakerDuplicate(recent, { speaker: "dg:1", text: "We have twenty-two trucks." }, now + CROSS_SPEAKER_DUPLICATE_MS + 1_500), "outside 2.5 s");
  ok("two devices in one room: the copy within 2.5 s from another speaker is dropped");
}
{
  assert.equal(sellerPartOfExchange("Broker: So what are the busy months?\nSeller: June to August.\nBroker: And slow?\nSeller: April."), "June to August.\nApril.");
  assert.equal(sellerPartOfExchange("Speaker 1: Who owns it?\nSeller: My wife and I\nwith a holding company."), "My wife and I\nwith a holding company.");
  assert.equal(sellerPartOfExchange("We lease the building."), "We lease the building.", "a plain answer stays");
  assert.equal(sellerPartOfExchange("Broker: The lease runs to 2029, right?"), "", "the broker's words alone are never the owner's");
  ok("legacy together sessions: only the seller's parts (dd quotes nothing else)");
}

// ── Listening ──
{
  assert.equal(notetakerState("in_waiting_room"), "notetaker_waiting_room");
  assert.equal(notetakerState("in_call_recording"), "notetaker_live");
  assert.equal(notetakerState("fatal"), "notetaker_failed");
  assert.equal(notetakerState("call_ended", "bot_kicked_from_call"), "notetaker_removed");
  assert.equal(notetakerState("call_ended", "call_ended_by_host"), "notetaker_ended");
  assert.equal(notetakerState("joining_call"), "notetaker_joining");
  const states: ListenState[] = ["idle", "consent", "starting", "listening", "paused", "mic_blocked", "no_mic", "stopped", "silent", "unavailable", "call_joining", "call_waiting", "call_left", "notetaker_joining", "notetaker_waiting_room", "notetaker_live", "notetaker_silent", "notetaker_removed", "notetaker_failed", "notetaker_ended"];
  for (const s of states) assert.ok(listenCopy(s).length > 3, s);
  assert.match(listenCopy("mic_blocked"), /lock icon in the address bar/);
  assert.match(listenCopy("consent"), /No audio is kept/);
  assert.match(listenCopy("notetaker_waiting_room", "Zoom"), /admit “Cimple Notetaker” in Zoom/);
  for (const s of ["mic_blocked", "no_mic", "stopped", "silent", "notetaker_waiting_room", "notetaker_removed", "notetaker_failed"] as ListenState[]) assert.ok(listenIsProblem(s), s);
  assert.ok(!listenIsProblem("listening"));
  ok("notetaker states from Recall; every listening state has plain copy; problems turn the pill amber");
}
assert.equal(summaryLine({ durationMin: 24, filed: new Array(9).fill({}) as never, toVerify: 2 }), "24 min · 9 answers filed · 2 to verify");
assert.equal(summaryLine({ durationMin: 0, filed: [{}] as never, toVerify: 0 }), "Under a minute · 1 answer filed");
ok("summary line");

console.log(`\n${n} checks passed`);
