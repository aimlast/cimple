/**
 * Replays a recorded "Interview together" conversation into a LOCAL server
 * (specs/together.md §9, §11.5) — for screenshots of the board filling in
 * live, with NO AI: the server answers from a recorded model.
 *
 * The local server must run with:
 *   ANTHROPIC_API_KEY=disabled  TOGETHER_CAPTURE=on  TOGETHER_CAPTURE_STUB=<tests/together/fixtures/lakeshore-sitting.model.json>
 * (live filing refuses any other local combination — server/together/chunker.ts captureEnabled).
 *
 * Refuses unless: this process is not production and has ANTHROPIC_API_KEY=disabled;
 * the server is on localhost; the signed-in broker is qa_cimgen; the deal is
 * qa_cimgen's own and its name starts with "QA OCT —"; the session says live
 * filing is on. Credentials come from a file (never printed).
 *
 * The name checked is the deal ROW's (the deal list), as clone-deal.mjs sets it. A
 * fact edit on the copy (an Information edit, a call note) mirrors the business-name
 * FACT back onto the row and can drop the prefix; rename it again through the app
 * (PATCH /api/deals/:id {"businessName": "QA OCT — <full business name>"} sets both)
 * before the next replay or a clone-deal.mjs --delete.
 *
 *   ANTHROPIC_API_KEY=disabled npx tsx scripts/together-replay.ts --port 5906 --deal <id> \
 *     [--fixture tests/together/fixtures/lakeshore-sitting.json] [--speed 1] [--from 0] [--until 200] [--screen on|off] [--end] [--dry-run] \
 *     [--creds ~/.claude/cimple-qa-broker.txt]
 *
 * --speed N plays N× faster than recorded (default 1); --fast = 20×; --from / --until S play only [from, until) of the
 * recording (segments, for screenshots of each moment; the session resumes between them).
 */
import fs from "fs";
import os from "os";
import path from "path";

interface FixtureLine { t: number; speaker?: string; text?: string; source?: string; event?: "speaker" | "answered" | "typed" | "end"; role?: string; itemId?: string }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function credsFrom(file: string): { username: string; password: string } {
  const text = fs.readFileSync(file.replace(/^~/, os.homedir()), "utf-8");
  const get = (k: string) => text.match(new RegExp(`^\\s*${k}\\s*[=:]\\s*(.*)$`, "mi"))?.[1]?.trim() ?? "";
  const username = get("username") || "qa_cimgen";
  const password = get("password");
  if (username !== "qa_cimgen") throw new Error("refusing: the creds file is not for qa_cimgen");
  if (!password) throw new Error("no password in the creds file");
  return { username, password };
}

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("refusing: this replay never runs in production");
  if (process.env.ANTHROPIC_API_KEY !== "disabled") throw new Error("refusing: run it with ANTHROPIC_API_KEY=disabled");
  const port = Number(arg("port") ?? "5906");
  const dealId = arg("deal");
  if (!dealId) throw new Error("usage: --deal <QA OCT copy id> [--port 5906]");
  const fixturePath = arg("fixture") ?? path.join(process.cwd(), "tests/together/fixtures/lakeshore-sitting.json");
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as { via?: string; lines: FixtureLine[] };
  const speed = has("fast") ? 20 : Math.max(0.1, Number(arg("speed") ?? "1"));
  const until = arg("until") ? Number(arg("until")) : Infinity;
  const from = arg("from") ? Number(arg("from")) : 0;
  const screen = arg("screen") ?? "off";
  const via = arg("via") ?? fixture.via ?? "person";
  const base = `http://127.0.0.1:${port}`;

  if (has("dry-run")) {
    console.log(`DRY RUN — nothing is posted. ${fixture.lines.length} steps, via ${via}, ${speed}× speed:`);
    for (const l of fixture.lines) {
      if (l.t >= until) break;
      if (l.t < from) continue;
      console.log(`  ${String(l.t).padStart(6)}s  ${l.event ? `[${l.event}${l.itemId ? ` ${l.itemId}` : ""}${l.text ? ` "${l.text}"` : ""}]` : `${l.speaker}: ${l.text}`}`);
    }
    return;
  }

  // ── Sign in as qa_cimgen (credentials never printed) ──
  const creds = credsFrom(arg("creds") ?? "~/.claude/cimple-qa-broker.txt");
  let cookie = "";
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json };
  };
  const login = await call("POST", "/api/broker-auth/login", { username: creds.username, password: creds.password });
  if (login.status !== 200) throw new Error(`sign-in failed (${login.status})`);
  const me = await call("GET", "/api/broker-auth/me");
  if (me.json?.user?.username !== "qa_cimgen") throw new Error("refusing: the signed-in broker isn't qa_cimgen");
  const deal = await call("GET", `/api/deals/${dealId}`);
  if (deal.status !== 200) throw new Error("refusing: that deal isn't qa_cimgen's");
  // The deal ROW's name (the deal list reads the column): a clone-deal.mjs copy is named "QA OCT — …"
  // there, while GET /api/deals/:id shows the business name from the facts ("Lakeshore Home Comfort Ltd.").
  const list = await call("GET", "/api/deals/list?includeArchived=1");
  const row = Array.isArray(list.json) ? (list.json as Array<{ id: string; businessName?: string }>).find((d) => d.id === dealId) : undefined;
  if (!row) throw new Error("refusing: that deal isn't in qa_cimgen's deal list");
  if (!String(row.businessName ?? "").startsWith("QA OCT —")) throw new Error("refusing: only a 'QA OCT —' copy (the deal's own name must start with it)");

  // ── The session ──
  const start = await call("POST", `/api/deals/${dealId}/together/sittings`, { via });
  if (start.status !== 200) throw new Error(`couldn't start the session (${start.status}): ${start.json?.error ?? ""}`);
  const sid = start.json.sitting.id as string;
  if (!start.json.sitting.filingOn) throw new Error("live filing is off on that server — start it with TOGETHER_CAPTURE=on and TOGETHER_CAPTURE_STUB=<model fixture>");
  await call("POST", `/api/deals/${dealId}/together/sittings/${sid}/consent`, {});
  await call("PATCH", `/api/deals/${dealId}/together/sittings/${sid}`, { sellerSeesScreen: screen === "on" });
  console.log(`replaying ${fixture.lines.length} steps into session ${sid.slice(0, 8)}… (${speed}× speed)`);

  const clientId = `replay-${Date.now().toString(36)}`;
  let seq = 0;
  const t0 = Date.now();
  for (const l of fixture.lines) {
    if (l.t >= until) break;
    if (l.t < from) continue;
    const due = t0 + ((l.t - from) * 1000) / speed;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (l.event === "speaker") {
      await call("POST", `/api/deals/${dealId}/together/sittings/${sid}/speakers`, { speaker: l.speaker, role: l.role });
      console.log(`  ${l.t}s  this is me: ${l.speaker} = ${l.role}`);
    } else if (l.event === "answered") {
      const r = await call("POST", `/api/deals/${dealId}/coverage-board/items/${encodeURIComponent(l.itemId!)}/answer`, { sittingId: sid, mode: "auto" });
      console.log(`  ${l.t}s  ✓ Answered ${l.itemId}: ${r.status}${r.json?.code ? ` ${r.json.code}` : ""}`);
    } else if (l.event === "typed") {
      await call("POST", `/api/deals/${dealId}/together/sittings/${sid}/lines`, { clientId, lines: [{ clientSeq: seq++, speaker: "typed:broker", text: l.text, source: "typed" }] });
      console.log(`  ${l.t}s  typed: ${l.text}`);
    } else if (l.event === "end") {
      await call("POST", `/api/deals/${dealId}/together/sittings/${sid}/file-now`, {});
      if (has("end")) {
        await call("POST", `/api/deals/${dealId}/together/sittings/${sid}/end`, { completeInterview: false, followUps: [], documents: [], addToNextSession: false });
        console.log(`  ${l.t}s  session ended`);
      }
    } else {
      const r = await call("POST", `/api/deals/${dealId}/together/sittings/${sid}/lines`, { clientId, lines: [{ clientSeq: seq++, speaker: l.speaker, text: l.text, source: l.source ?? "deepgram" }] });
      if (r.status !== 200) console.log(`  ${l.t}s  line refused (${r.status} ${r.json?.code ?? ""})`);
    }
  }
  console.log(`done (${Math.round((Date.now() - t0) / 1000)} s)`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
