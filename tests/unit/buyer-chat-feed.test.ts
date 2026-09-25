/**
 * Buyer Q&A chat history — no database, no AI, no React.
 *   npx tsx tests/unit/buyer-chat-feed.test.ts
 *
 * Regression from the 2026-09-25 confidentiality round: answers kept private
 * to the buyer who asked (named-CIM answers for LOI / DD buyers, and blind
 * answers that name the business) arrive in the feed as
 * `isMine: true, status: "published", isPublished: false`. After a reload
 * they showed as "Forwarded to your broker / awaiting your broker" and the
 * poll never marked them answered. They must read as answered — while
 * nothing another buyer is not entitled to becomes visible.
 */
import assert from "node:assert/strict";
import {
  DECLINED_TEXT,
  PENDING_TEXT,
  answerForReader,
  resolvePolledFeed,
  seedFromFeed,
  type BuyerQuestionFeedItem,
} from "../../client/src/components/buyer/chat-feed";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`, err);
    process.exitCode = 1;
  }
}

const at = "2026-09-25T10:00:00.000Z";
function item(over: Partial<BuyerQuestionFeedItem>): BuyerQuestionFeedItem {
  return {
    id: "q1",
    question: "What was revenue last year?",
    status: "published",
    isPublished: true,
    aiAnswer: "Revenue was $2.1M.",
    publishedAnswer: "Revenue was $2.1M.",
    createdAt: at,
    updatedAt: at,
    isMine: false,
    ...over,
  };
}

// The exact shape buildBuyerQuestionFeed sends for a private answer.
const privateMine = item({ id: "loi1", isMine: true, isPublished: false, status: "published" });

console.log("buyer chat feed");

test("a private answer to my own question is readable by me", () => {
  assert.equal(answerForReader(privateMine), "Revenue was $2.1M.");
});

test("reload: my private answered question seeds as answered, not awaiting the broker", () => {
  const { messages, pendingIds } = seedFromFeed([privateMine], "Project Coastal");
  assert.deepEqual(pendingIds, []);
  assert.ok(messages.some((m) => m.id === "pa-loi1" && m.role === "ai" && m.content === "Revenue was $2.1M."));
  assert.ok(!messages.some((m) => m.content === PENDING_TEXT));
  assert.ok(!messages.some((m) => m.status === "pending_broker"));
  assert.equal(messages.find((m) => m.id === "pq-loi1")?.origin, "mine");
});

test("a knowledge-base answer with only aiAnswer still counts", () => {
  const onlyAi = item({ id: "kb1", isMine: true, isPublished: false, publishedAnswer: null });
  assert.equal(answerForReader(onlyAi), "Revenue was $2.1M.");
  assert.deepEqual(seedFromFeed([onlyAi], "X").pendingIds, []);
});

test("my question still with the broker stays pending and is polled", () => {
  const pending = item({ id: "p1", isMine: true, isPublished: false, status: "pending_broker", aiAnswer: null, publishedAnswer: null });
  const { messages, pendingIds } = seedFromFeed([pending], "X");
  assert.deepEqual(pendingIds, ["p1"]);
  assert.ok(messages.some((m) => m.id === "ps-p1" && m.status === "pending_broker" && m.content === PENDING_TEXT));
});

test("my declined question says so and is not polled", () => {
  const declined = item({ id: "d1", isMine: true, isPublished: false, status: "declined", aiAnswer: null, publishedAnswer: null });
  const { messages, pendingIds } = seedFromFeed([declined], "X");
  assert.deepEqual(pendingIds, []);
  assert.ok(messages.some((m) => m.id === "ps-d1" && m.status === "declined" && m.content === DECLINED_TEXT));
});

test("another buyer's unshared question never shows, even with an answer attached", () => {
  const theirs = item({ id: "o1", isMine: false, isPublished: false, status: "published" });
  assert.equal(answerForReader(theirs), null);
  assert.ok(!seedFromFeed([theirs], "X").messages.some((m) => m.questionId === "o1"));
});

test("a pending question with a stray draft answer is not treated as answered", () => {
  const draft = item({ id: "p2", isMine: true, isPublished: false, status: "pending_seller" });
  assert.equal(answerForReader(draft), null);
  assert.deepEqual(seedFromFeed([draft], "X").pendingIds, ["p2"]);
});

test("shared answers from other buyers still seed as before", () => {
  const { messages, pendingIds } = seedFromFeed([item({ id: "s1" })], "X");
  assert.deepEqual(pendingIds, []);
  assert.equal(messages.find((m) => m.id === "pq-s1")?.origin, "other");
  assert.ok(messages.some((m) => m.id === "pa-s1"));
});

test("poll: a pending question answered privately is marked answered and its answer appended", () => {
  const pending = item({ id: "p3", isMine: true, isPublished: false, status: "pending_broker", aiAnswer: null, publishedAnswer: null });
  const seed = seedFromFeed([pending], "X");
  const answeredPrivately = { ...pending, status: "published", publishedAnswer: "Lease runs to 2031." };
  const result = resolvePolledFeed([answeredPrivately], seed.pendingIds, seed.messages);
  assert.ok(result);
  assert.deepEqual(result!.resolvedIds, ["p3"]);
  assert.equal(result!.answeredCount, 1);
  assert.equal(result!.messages.find((m) => m.id === "ps-p3")?.status, "answered");
  assert.equal(result!.messages.find((m) => m.id === "pq-p3")?.status, undefined);
  assert.ok(result!.messages.some((m) => m.id === "pa-p3" && m.content === "Lease runs to 2031."));
});

test("poll: nothing changes while the question is still with the broker", () => {
  const pending = item({ id: "p4", isMine: true, isPublished: false, status: "pending_seller", aiAnswer: null, publishedAnswer: null });
  const seed = seedFromFeed([pending], "X");
  assert.equal(resolvePolledFeed([pending], seed.pendingIds, seed.messages), null);
});

test("poll: a declined question is resolved as declined", () => {
  const pending = item({ id: "p5", isMine: true, isPublished: false, status: "pending_broker", aiAnswer: null, publishedAnswer: null });
  const seed = seedFromFeed([pending], "X");
  const result = resolvePolledFeed([{ ...pending, status: "declined" }], seed.pendingIds, seed.messages);
  assert.deepEqual(result?.resolvedIds, ["p5"]);
  assert.equal(result?.answeredCount, 0);
  assert.equal(result?.messages.find((m) => m.id === "ps-p5")?.content, DECLINED_TEXT);
});

test("poll: applying the same answer twice does not duplicate the bubble", () => {
  const pending = item({ id: "p6", isMine: true, isPublished: false, status: "pending_broker", aiAnswer: null, publishedAnswer: null });
  const seed = seedFromFeed([pending], "X");
  const answered = { ...pending, status: "published", publishedAnswer: "Yes." };
  const first = resolvePolledFeed([answered], seed.pendingIds, seed.messages)!;
  const second = resolvePolledFeed([answered], seed.pendingIds, first.messages)!;
  assert.equal(second.messages.filter((m) => m.id === "pa-p6").length, 1);
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
