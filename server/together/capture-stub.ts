/**
 * A recorded stand-in for the extraction model (specs/together.md §9, §11.3):
 * the local replay (scripts/together-replay.ts) and the replay test file
 * conversation parts with scripted tool outputs — no AI is ever called.
 *
 * Fixture shape (tests/together/fixtures/*.model.json):
 *   { "latencyMs": 3000,
 *     "entries": [ { "match": "cold snaps are crazy",      // words in a NEW line that trigger it
 *                    "focus": "financials:grossProfit",    // optional: only for a ✓ Answered on this item
 *                    "output": { "answers": [{ "key": "seasonality", "value": "…", "quote": "…",
 *                                              "speaker": "seller", "confidence": "confirmed", "basis": "verbatim",
 *                                              "cite": ["so 36 staff", "yes"] }], …, "topicSections": ["seasonality"] } } ] }
 *
 * Line numbers are never in the fixture (the server numbers lines as they
 * arrive): each answer cites the NEW lines that contain its `cite` words
 * (default: its quote), as the real model cites what it read.
 */
import fs from "fs";
import { CaptureError, type CaptureLine, type CaptureModel } from "./capture";

export interface StubEntry {
  match: string;
  focus?: string;
  output: Record<string, unknown>;
}

export interface StubFixture {
  latencyMs?: number;
  /** Every call fails as an unavailable AI does (the "Cimple can't file answers right now" state). */
  failAll?: boolean;
  entries: StubEntry[];
}

const norm = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9$%'.]+/g, " ").trim();

function linesFor(cites: string[], lines: CaptureLine[]): number[] {
  const out: number[] = [];
  for (const c of cites) {
    const n = norm(c);
    if (!n) continue;
    const hit = lines.find((l) => norm(l.text).includes(n)) ?? lines.find((l) => {
      const words = n.split(" ").filter((w) => w.length > 2);
      const t = norm(l.text);
      return words.length > 0 && words.filter((w) => t.includes(w)).length / words.length >= 0.8;
    });
    if (hit && !out.includes(hit.seq)) out.push(hit.seq);
  }
  return out;
}

/** A model that answers from recorded outputs. */
export function stubModel(fixture: StubFixture, opts: { sleep?: (ms: number) => Promise<void> } = {}): CaptureModel {
  const used = new Set<number>();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (req) => {
    if (fixture.latencyMs) await sleep(fixture.latencyMs);
    if (fixture.failAll) throw new CaptureError("The recorded model is set to be unavailable", "unavailable");
    const merged = { answers: [] as unknown[], notKnown: [] as unknown[], brokerUnconfirmed: [] as unknown[], private: [] as unknown[], withdrawn: [] as unknown[], otherFacts: [] as unknown[], followUp: null as unknown, topicSections: [] as string[] };
    const newText = req.lines.map((l) => norm(l.text));
    fixture.entries.forEach((e, idx) => {
      if (e.focus ? e.focus !== req.focusItemId : used.has(idx)) return;
      const m = norm(e.match);
      if (!newText.some((t) => t.includes(m))) return;
      if (!e.focus) used.add(idx);
      const o = e.output as Record<string, unknown[] | unknown>;
      for (const k of ["answers", "notKnown", "brokerUnconfirmed", "private", "withdrawn", "otherFacts"] as const) {
        for (const raw of (Array.isArray(o[k]) ? (o[k] as Array<Record<string, unknown>>) : [])) {
          const cites = Array.isArray(raw.cite) ? (raw.cite as string[]) : [String(raw.quote ?? "")];
          const { cite: _c, ...rest } = raw;
          (merged[k] as unknown[]).push({ ...rest, lines: linesFor(cites, req.lines) });
        }
      }
      if (o.followUp) merged.followUp = o.followUp;
      if (Array.isArray(o.topicSections)) merged.topicSections.push(...(o.topicSections as string[]));
    });
    return { toolInput: merged, usage: { input: 600, output: 200, cacheRead: 4500, cacheWrite: 0, ms: fixture.latencyMs ?? 0, model: "recorded" } };
  };
}

/** The local replay's model, from TOGETHER_CAPTURE_STUB (a path). */
export function stubModelFromFile(path: string): CaptureModel {
  const fixture = JSON.parse(fs.readFileSync(path, "utf-8")) as StubFixture;
  return stubModel(fixture);
}
