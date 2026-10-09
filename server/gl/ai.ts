/**
 * ai.ts — the two places "Add-backs in the books" may ask the model (gl spec
 * §7.3–7.4, D8, D9), and their daily budgets:
 *
 *   map-columns-ai.ts  an unusual spreadsheet layout the rules can't read
 *   rank-ai.ts         the entries behind a SENT add-back the rules left unsure
 *
 * Seller actions (ticking, searching, notes) never call the model. A ledger
 * the seller uploads may, from its own budget; the broker's clicks have
 * another. Each call is reserved BEFORE it is made, by one atomic statement
 * per deal and UTC day (store.reserveAi):
 *
 *   broker  3 mappings + 12 rankings a day  (≤ $0.30)
 *   seller  2 mappings +  8 rankings a day  (≤ $0.20)
 *
 * With ANTHROPIC_API_KEY unset or "disabled" (every local run) nothing is
 * reserved and nothing is called: a ledger waits for its columns; the
 * rules' proposals stand.
 */
import Anthropic from "@anthropic-ai/sdk";
import { glStore, type GlAiKind } from "./store";

export const GL_AI_CAPS: Record<GlAiKind, number> = {
  broker_mapping: 3,
  broker_ranking: 12,
  seller_mapping: 2,
  seller_ranking: 8,
};

/** The minimal client shape gl uses (the SDK's messages.create; tests stub it). */
export interface GlAiClient {
  messages: { create(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; name?: string; input?: unknown; text?: string }>; stop_reason?: string | null }> };
}

let testClient: GlAiClient | null | undefined;
let client: GlAiClient | null = null;

/** Tests: a stubbed client (null = "no key"); undefined restores the real one. */
export function _setGlAiClientForTests(c: GlAiClient | null | undefined): void {
  testClient = c;
}

/** The model client, or null when the key is missing or disabled (no call is ever made then). */
export function glAiClient(): GlAiClient | null {
  if (testClient !== undefined) return testClient;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === "disabled") return null;
  return (client ??= new Anthropic({ apiKey: key, timeout: 120_000 }) as unknown as GlAiClient);
}

/** The UTC day the counters are kept for. */
export function glAiDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Reserve one call (true) or say the day's budget is spent (false). The
 * deal's tracing row must exist (the callers' context creates it).
 */
export async function reserveGlAi(dealId: string, who: "broker" | "seller", what: "mapping" | "ranking", now: Date = new Date()): Promise<boolean> {
  const kind = `${who}_${what}` as GlAiKind;
  try {
    return await glStore().reserveAi(dealId, kind, GL_AI_CAPS[kind], glAiDay(now));
  } catch (err) {
    // Can't count → don't spend.
    console.warn(`[gl] AI budget for ${dealId} couldn't be read:`, (err as Error).message);
    return false;
  }
}

/** The forced tool call's input, or null (no tool call / wrong tool). */
export function toolInput(res: Awaited<ReturnType<GlAiClient["messages"]["create"]>>, name: string): Record<string, unknown> | null {
  const block = (res?.content ?? []).find((b) => b.type === "tool_use" && b.name === name);
  const input = block?.input;
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
}
