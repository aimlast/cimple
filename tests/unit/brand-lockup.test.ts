/**
 * The Cimple brand is the icon OR the wordmark, never both side by side (founder, 2026-10-09:
 * "take away the icon logo beside the name cimple on the landing page or anywhere else where
 * they are both together … it should only show Cimple text logo when you expand it and then
 * when it collapses it shows just the icon").
 *
 *   - Broker sidebar: collapsed rail = icon only (pixel-identical to before); open (hover,
 *     Ctrl/⌘+B, the phone sheet) = wordmark only. Phone top bar = wordmark only.
 *   - Every other app page uses <CimpleWordmark /> (theme-aware, never the old green).
 *   - Landing pages (v1/v2/v3): wordmark only in the nav and footer; the icon PNG is gone
 *     entirely (the v3 hero mock CIM shows a dashed "Logo" box: CIMs carry the broker's brand).
 *   - Tab icons are the icon alone (favicon.svg / favicon-32.png / favicon.ico / apple-touch-icon.png).
 *   - The artwork exists once (client/public/); the stacked lockup picture is gone from the repo.
 *   - Emails carry no logo image at all.
 *
 * NOTE: the phone-sheet case is checked here only through class rules, because SSR can't render
 * the Radix portal (`useIsMobile` is false on the server). The live check is the brand spec's
 * §10.3 "Phone bar + sheet" screenshot probe, which is mandatory.
 *
 * If this fails after a merge: use <CimpleWordmark /> / <CimpleMark /> from
 * client/src/components/brand/CimpleLogo.tsx — never the logo PNGs directly, never a
 * hand-made mask, never the two side by side.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsx compiles the app's JSX with the classic runtime (Vite uses the automatic one).
(globalThis as any).React = React;
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

import { Router } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidebarProvider } from "../../client/src/components/ui/sidebar";
import { AppSidebar, BrokerMobileHeader, SidebarBrand } from "../../client/src/components/app-sidebar";
import { ThemeProvider } from "../../client/src/components/ThemeProvider";
import { CimpleMark, CimpleWordmark } from "../../client/src/components/brand/CimpleLogo";
import { BuyerAuthCard, BuyerNav } from "../../client/src/pages/buyer/shared";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
/** The tab-icon mark, traced from cimple-icon.png (IoU 0.992 against its alpha). */
const MARK_PATH = "M0 0H167V213H0ZM14.4 13H153V200H128.8Z";

// ── helpers ────────────────────────────────────────────────────────────────
type State = "expanded" | "collapsed" | "sheet";
const HIDE = new Set(["hidden", "invisible", "opacity-0"]);
const SHOW = new Set(["opacity-100", "visible", "flex", "block"]);
const G = "group-data-[collapsible=icon]:";

/**
 * Is an element with these classes visible in a sidebar state? Base tokens (no ":") apply
 * everywhere; `group-data-[collapsible=icon]:` tokens apply only on the collapsed desktop rail.
 * The phone sheet is portalled outside the `.group[data-collapsible]` wrapper, so only the
 * base tokens apply there (the same as "expanded").
 */
export function visibleIn(state: State, classes: string): boolean {
  const toks = classes.split(/\s+/).filter(Boolean);
  const base = toks.filter((t) => !t.includes(":"));
  let vis = !base.some((t) => HIDE.has(t));
  if (state === "collapsed") {
    for (const t of toks.filter((x) => x.startsWith(G)).map((x) => x.slice(G.length))) {
      if (HIDE.has(t)) vis = false;
      else if (SHOW.has(t)) vis = true;
    }
  }
  return vis;
}
const brands = (html: string) =>
  [...html.matchAll(/<(img|span)\b[^>]*data-brand="(mark|wordmark)"[^>]*>/g)].map((m) => ({
    kind: m[2],
    cls: (m[0].match(/class="([^"]*)"/) || [, ""])[1] as string,
    tag: m[0],
  }));
const wrap = (el: React.ReactElement) => React.createElement(Router, { ssrPath: "/broker/deals" } as any, el);
const render = (el: React.ReactElement) => renderToStaticMarkup(wrap(el));

function walk(dir: string, ok: (f: string) => boolean, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ok, out);
    else if (ok(p)) out.push(p);
  }
  return out;
}
/** Width × height from a PNG's IHDR (bytes 16–24). */
function pngSize(buf: Buffer): string {
  assert.equal(buf.subarray(1, 4).toString("latin1"), "PNG", "not a PNG");
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}
const ICON = "167x213", WORDMARK = "517x144", TAB = "32x32";

// ── 1. The visibility rule (the core) ─────────────────────────────────────
const strip = render(React.createElement(SidebarBrand));
const stripBrands = brands(strip);
assert.deepEqual(stripBrands.map((b) => b.kind).sort(), ["mark", "wordmark"], "the strip holds one mark and one wordmark");
for (const st of ["collapsed", "expanded", "sheet"] as State[]) {
  const vis = stripBrands.filter((b) => visibleIn(st, b.cls)).map((b) => b.kind);
  assert.deepEqual(
    vis,
    st === "collapsed" ? ["mark"] : ["wordmark"],
    `sidebar ${st}: exactly the ${st === "collapsed" ? "icon" : "wordmark"} is visible (got ${vis.join(", ") || "nothing"})`,
  );
}
// The rule catches the founder's complaint: the pre-2026-10-09 markup had both visible when open.
const before = `<img src="/cimple-icon.png" class="h-7 w-auto shrink-0 select-none"><img src="/cimple-text.png" class="h-4 w-auto select-none group-data-[collapsible=icon]:hidden">`;
assert.equal(
  [...before.matchAll(/class="([^"]*)"/g)].filter((m) => visibleIn("expanded", m[1])).length,
  2,
  "the helper flags the old lockup (both visible when expanded)",
);

// ── 2. Geometry and accessibility ─────────────────────────────────────────
const header = strip.match(/<div[^>]*data-sidebar="header"[^>]*>/)?.[0] ?? "";
assert.match(header, /h-\[53px\]/, "the brand strip keeps a fixed 53 px height (nothing below moves on hover)");
assert.match(header, /overflow-hidden/, "the hidden wordmark is clipped, never over the page");
const markWrap = strip.match(/<span class="([^"]*)"><img[^>]*data-brand="mark"/)?.[1] ?? "";
assert.ok(/\bw-\[47px\]/.test(markWrap), "the collapsed icon must stay at x=12.53; see spec §4.2 (47 px box)");
const wordWrap = strip.match(/<span class="([^"]*)"><img[^>]*data-brand="wordmark"/)?.[1] ?? "";
assert.ok(/\bleft-5\b/.test(wordWrap), "the open wordmark lines up with the nav icons (left-5)");
for (const b of stripBrands) {
  assert.match(b.cls, /motion-reduce:transition-none/, `${b.kind}: instant swap with reduced motion`);
  assert.match(b.cls, /\bmax-w-none\b/, `${b.kind}: never squeezed by a narrow rail`);
  assert.match(b.tag, /alt=""/, `${b.kind}: decorative (the link names it)`);
  assert.match(b.tag, /aria-hidden="true"/, `${b.kind}: hidden from screen readers`);
}
assert.match(strip, /aria-label="Cimple — dashboard"/, "the brand link has a name");
assert.match(strip, /data-testid="link-brand"/);

// ── 3. Phone top bar: the wordmark alone ──────────────────────────────────
const mob = render(React.createElement(SidebarProvider, { defaultOpen: false } as any, React.createElement(BrokerMobileHeader)));
assert.deepEqual(brands(mob).map((b) => b.kind), ["wordmark"], "phone bar: wordmark only, no icon");
assert.match(mob, /aria-label="Cimple — dashboard"/);

// ── 4. The full sidebar: one mark + one wordmark, no stray logo images ────
for (const open of [false, true]) {
  const html = render(
    React.createElement(ThemeProvider, null,
      React.createElement(SidebarProvider, { defaultOpen: open } as any, React.createElement(AppSidebar))),
  );
  assert.deepEqual(brands(html).map((b) => b.kind).sort(), ["mark", "wordmark"], `AppSidebar defaultOpen=${open}: one mark + one wordmark`);
  const stray = [...html.matchAll(/<img\b[^>]*src="\/cimple-(icon|text)\.png"[^>]*>/g)].filter((m) => !/data-brand=/.test(m[0]));
  assert.equal(stray.length, 0, `AppSidebar defaultOpen=${open}: no logo <img> outside the brand components`);
}

// ── 5. Component contract ─────────────────────────────────────────────────
{
  const mark = renderToStaticMarkup(React.createElement(CimpleMark, { className: "h-7" }));
  assert.match(mark, /^<img\b/);
  assert.match(mark, /src="\/cimple-icon\.png"/);
  assert.match(mark, /data-brand="mark"/);
  assert.match(mark, /alt="Cimple"/);
  assert.doesNotMatch(mark, /aria-hidden/);
  const markDeco = renderToStaticMarkup(React.createElement(CimpleMark, { decorative: true }));
  assert.match(markDeco, /alt=""/);
  assert.match(markDeco, /aria-hidden="true"/);

  const cream = renderToStaticMarkup(React.createElement(CimpleWordmark, { tone: "cream", className: "h-4" }));
  assert.match(cream, /^<img\b/);
  assert.match(cream, /src="\/cimple-text\.png"/);
  assert.match(cream, /data-brand="wordmark"/);
  assert.match(cream, /alt="Cimple"/);

  const auto = renderToStaticMarkup(React.createElement(CimpleWordmark, { className: "h-6" }));
  assert.match(auto, /^<span\b/, "the theme-aware wordmark is a masked span");
  assert.match(auto, /data-brand="wordmark"/);
  const cls = auto.match(/class="([^"]*)"/)?.[1] ?? "";
  assert.ok(/\bblock\b/.test(cls), "block, not inline-block (no line-box strut; bars keep their height)");
  assert.ok(/\btext-foreground\b/.test(cls), "the colour follows the theme (cream on dark, ink on light)");
  assert.ok(/\bh-6\b/.test(cls));
  const style = auto.match(/style="([^"]*)"/)?.[1] ?? "";
  assert.match(style, /background-color:currentColor/);
  assert.match(style, /mask-image:url\(&#x27;\/cimple-text\.png&#x27;\)|mask-image:url\('\/cimple-text\.png'\)/);
  assert.match(style, /aspect-ratio:517 \/ 144/);
  assert.doesNotMatch(style, /hsl\(/, "never a hard-coded colour");
  assert.match(auto, /role="img"/);
  assert.match(auto, /aria-label="Cimple"/);
  const autoDeco = renderToStaticMarkup(React.createElement(CimpleWordmark, { decorative: true }));
  assert.match(autoDeco, /aria-hidden="true"/);
  assert.doesNotMatch(autoDeco, /role="img"/);
}

// Buyer chrome renders the wordmark alone (the card and the nav).
{
  const qc = new QueryClient();
  const card = render(React.createElement(BuyerAuthCard, null, "x"));
  assert.deepEqual(brands(card).map((b) => b.kind), ["wordmark"], "buyer sign-in card: wordmark only");
  assert.match(brands(card)[0].cls, /\bmx-auto\b/, "buyer sign-in wordmark is centred");
  const nav = render(React.createElement(QueryClientProvider, { client: qc }, React.createElement(BuyerNav)));
  assert.deepEqual(brands(nav).map((b) => b.kind), ["wordmark"], "buyer nav: wordmark only");
}

// ── 6. Source scan of the client ──────────────────────────────────────────
{
  const SRC = path.join(ROOT, "client/src");
  const LOGO_FILE = "client/src/components/brand/CimpleLogo.tsx";
  const files = walk(SRC, (f) => /\.(ts|tsx)$/.test(f));
  assert.ok(files.length > 50, "the scan sees the client source");
  const both: string[] = [];
  for (const f of files) {
    const r = rel(f);
    const s = fs.readFileSync(f, "utf8");
    if (r !== LOGO_FILE) {
      for (const png of ["/cimple-icon.png", "/cimple-text.png", "/cimple-logo.png"]) {
        assert.ok(
          !s.includes(png),
          `${r} uses ${png} directly — use <CimpleWordmark /> / <CimpleMark /> from components/brand/CimpleLogo.tsx`,
        );
      }
      const hasMark = s.includes("<CimpleMark");
      const hasWord = s.includes("<CimpleWordmark");
      if (hasMark && hasWord) both.push(r);
      assert.ok(
        !hasMark || r === "client/src/components/app-sidebar.tsx",
        `${r} renders <CimpleMark /> — the icon belongs only on the collapsed broker sidebar rail`,
      );
    }
    // The wordmark's colour always comes from `tone` and the theme.
    for (const m of s.matchAll(/<CimpleWordmark\b[\s\S]*?\/>/g)) {
      const tag = m[0];
      assert.ok(!/\bstyle=/.test(tag), `${r}: <CimpleWordmark> takes no style prop (${tag.slice(0, 80)})`);
      const classes = (tag.match(/className="([^"]*)"/)?.[1] ?? "").split(/\s+/).filter(Boolean);
      for (const t of classes) {
        const util = t.split(":").pop() ?? "";
        assert.ok(
          !util.startsWith("text-") && !util.startsWith("bg-"),
          `${r}: <CimpleWordmark> colour comes from tone/theme, not "${t}"`,
        );
      }
    }
  }
  assert.deepEqual(both, ["client/src/components/app-sidebar.tsx"], "only the sidebar has both pieces (they swap by state)");
  for (const f of ["client/src/layouts/SellerLayout.tsx", "client/src/pages/broker/BrokerResetPassword.tsx"]) {
    assert.ok(!fs.readFileSync(path.join(ROOT, f), "utf8").includes("hsl(162, 65%, 38%)"), `${f}: the old green brand is gone`);
  }
}

// ── 7. Landing pages ──────────────────────────────────────────────────────
{
  const fav32 = fs.readFileSync(path.join(ROOT, "client/public/favicon-32.png")).toString("base64");
  for (const name of ["index", "v1", "v2"]) {
    const file = `server/landing/${name}.html`;
    const s = fs.readFileSync(path.join(ROOT, file), "utf8");
    const pngs = [...s.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)].map((m) => ({
      b64: m[1],
      size: pngSize(Buffer.from(m[1], "base64")),
    }));
    assert.equal(pngs.filter((p) => p.size === ICON).length, 0, `${file}: the icon PNG appears nowhere (nav, footer, hero, tab icon)`);

    const brandBlocks = [...s.matchAll(/<a class="brand"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]);
    assert.equal(brandBlocks.length, 2, `${file}: nav + footer brand links`);
    for (const block of brandBlocks) {
      const imgs = [...block.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
      assert.equal(imgs.length, 1, `${file}: a brand link holds exactly one image (the wordmark)`);
      const b64 = imgs[0].match(/base64,([A-Za-z0-9+/=]+)/)?.[1] ?? "";
      assert.equal(pngSize(Buffer.from(b64, "base64")), WORDMARK, `${file}: the brand image is the wordmark`);
      assert.match(imgs[0], /class="brand-wordmark"/);
      assert.match(imgs[0], /alt="Cimple"/);
      assert.ok(!/<svg\b/.test(block), `${file}: no drawn icon in a brand link`);
    }
    assert.match(s, /\.brand-wordmark \{ display: block; height: 20px; width: auto; \}/);
    assert.match(s, /footer \.brand-wordmark \{ height: 16px; opacity: \.85; \}/);
    assert.match(s, /\.nav \.brand-wordmark \{ height: 18px; \}/);

    const icons = [...s.matchAll(/<link rel="icon"[^>]*>/g)].map((m) => m[0]);
    assert.equal(icons.length, 2, `${file}: two tab icons (PNG fallback, then SVG)`);
    assert.match(icons[0], /type="image\/png"/);
    assert.match(icons[0], /sizes="32x32"/, `${file}: sizes on the bitmap keeps Chromium on the SVG`);
    assert.equal(icons[0].match(/base64,([A-Za-z0-9+/=]+)/)?.[1], fav32, `${file}: the PNG tab icon is client/public/favicon-32.png`);
    assert.equal(pngSize(Buffer.from(fav32, "base64")), TAB);
    assert.match(icons[1], /type="image\/svg\+xml"/);
    assert.ok(icons[1].includes(MARK_PATH), `${file}: the SVG tab icon draws the mark`);

    if (name === "index") {
      assert.match(s, /<div class="doc-brand">\s*<span class="doc-logo" aria-hidden="true">Logo<\/span>/, "v3 hero mock CIM shows a broker-logo placeholder, not the Cimple icon");
      assert.match(s, /\.doc-logo \{/);
    }
  }
}

// ── 8. Assets ─────────────────────────────────────────────────────────────
{
  const pub = (f: string) => path.join(ROOT, "client/public", f);
  assert.ok(!fs.existsSync(pub("cimple-logo.png")), "the stacked lockup picture (icon above the word) is removed");
  assert.ok(fs.existsSync(pub("cimple-icon.png")), "the icon artwork stays (CimpleMark)");
  assert.ok(fs.existsSync(pub("cimple-text.png")), "the wordmark artwork stays (CimpleWordmark)");
  assert.equal(pngSize(fs.readFileSync(pub("cimple-icon.png"))), ICON);
  assert.equal(pngSize(fs.readFileSync(pub("cimple-text.png"))), WORDMARK);
  const svg = fs.readFileSync(pub("favicon.svg"), "utf8");
  for (const needle of [MARK_PATH, "#0A0A0A", "#FCF8EB", "prefers-color-scheme:dark"]) {
    assert.ok(svg.includes(needle), `favicon.svg contains ${needle}`);
  }
  assert.equal(pngSize(fs.readFileSync(pub("favicon-32.png"))), TAB);
  assert.equal(pngSize(fs.readFileSync(pub("apple-touch-icon.png"))), "180x180");
  // /favicon.ico (asked for by browsers without the link tags, crawlers, link previews) is the
  // same tab icon: favicon-32.png inside a one-image ICO wrapper.
  const ico = fs.readFileSync(pub("favicon.ico"));
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 1], "favicon.ico: a one-image ICO header");
  assert.deepEqual([ico[6], ico[7]], [32, 32], "favicon.ico: a 32×32 entry");
  const icoLen = ico.readUInt32LE(14), icoOff = ico.readUInt32LE(18);
  assert.equal(icoOff + icoLen, ico.length, "favicon.ico: one image, nothing after it");
  assert.ok(ico.subarray(icoOff).equals(fs.readFileSync(pub("favicon-32.png"))), "favicon.ico wraps exactly client/public/favicon-32.png");

  const index = fs.readFileSync(path.join(ROOT, "client/index.html"), "utf8");
  const links = [...index.matchAll(/<link rel="(icon|apple-touch-icon)"[^>]*>/g)].map((m) => m[0]);
  assert.equal(links.length, 3, "client/index.html: three icon links");
  assert.match(links[0], /type="image\/png" sizes="32x32" href="\/favicon-32\.png"/);
  assert.match(links[1], /type="image\/svg\+xml" href="\/favicon\.svg"/);
  assert.match(links[2], /rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
}

// ── 9. Emails and server pages carry no logo image ────────────────────────
{
  const files = walk(path.join(ROOT, "server"), (f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f));
  for (const f of files) {
    const s = fs.readFileSync(f, "utf8");
    for (const png of ["cimple-icon.png", "cimple-text.png", "cimple-logo.png"]) {
      assert.ok(!s.includes(png), `${rel(f)} references ${png} — emails and server pages use the text label only (logo rule)`);
    }
  }
}

// ── 10. One copy of the artwork; the rejected lockup nowhere in the repo ──
{
  // The stacked picture (icon above the word, 891×891) removed on 2026-10-09. A copy under any
  // name or folder could be wired up again, so its bytes may not exist anywhere in the repo.
  const LOCKUP_MD5 = "e34b114975ccfef6c562846bced2abf1";
  const SKIP = new Set(["node_modules", "dist", "uploads"]);
  const files: string[] = [];
  const scan = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else files.push(p);
    }
  };
  scan(ROOT);
  assert.ok(files.some((f) => rel(f) === "client/public/favicon.svg"), "the scan sees the repo");
  const artwork = files.map(rel).filter((r) => /(^|\/)cimple-(logo|icon|text)\.[a-z]+$/i.test(r)).sort();
  assert.deepEqual(
    artwork,
    ["client/public/cimple-icon.png", "client/public/cimple-text.png"],
    "the Cimple artwork exists once, in client/public/ (icon + wordmark); remove any other copy, and never a cimple-logo file",
  );
  for (const f of files.filter((f) => /\.png$/i.test(f))) {
    const md5 = crypto.createHash("md5").update(fs.readFileSync(f)).digest("hex");
    assert.notEqual(md5, LOCKUP_MD5, `${rel(f)} is the removed stacked lockup (icon above the word) — delete it`);
  }
}

// ── 11. Every branded page still shows the wordmark (merge guard) ─────────
{
  // A merge that rewrites one of these files must keep the wordmark: dropping the line leaves the
  // page with no brand at all, and taking another branch's copy of the file brings back a
  // hand-made mask (caught by group 6). Interview.tsx belongs to the "together" stream; brand
  // owns one import and the seller-mode top-bar line there.
  const IMPORT = /^import \{[^}]*\bCimpleWordmark\b[^}]*\} from "@\/components\/brand\/CimpleLogo";$/m;
  const SITES: Array<[string, RegExp, string]> = [
    ["client/src/layouts/SellerLayout.tsx", /<CimpleWordmark\b/, "the seller pages' top bar"],
    ["client/src/components/seller/SellerOnboarding.tsx", /<CimpleWordmark\b/, "the seller intro"],
    [
      "client/src/components/shared/Interview.tsx",
      /\{!isBroker\s*&&\s*\(\s*<CimpleWordmark className="h-3\.5" \/>\s*\)\}/,
      'the seller interview\'s top bar: `{!isBroker && (<CimpleWordmark className="h-3.5" />)}`',
    ],
    ["client/src/pages/broker/BrokerLogin.tsx", /<CimpleWordmark\b/, "the broker sign-in card"],
    ["client/src/pages/broker/BrokerResetPassword.tsx", /<CimpleWordmark\b/, "the set-a-new-password card"],
    ["client/src/pages/buyer/shared.tsx", /<CimpleWordmark\b[\s\S]*<CimpleWordmark\b/, "the buyer sign-in card and the buyer nav"],
  ];
  for (const [file, site, where] of SITES) {
    const s = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.match(s, IMPORT, `${file} must import CimpleWordmark from "@/components/brand/CimpleLogo"`);
    assert.match(s, site, `${file} must render <CimpleWordmark /> in ${where} — re-apply it after the merge`);
  }
  // The import sits in Interview.tsx's FIRST import block (beside AIConversationInterface). The
  // together stream deletes the stray imports below `interface SectionCoverage`; an import placed
  // there conflicts on merge, and resolving it with together's copy restores the old mask.
  const iv = fs.readFileSync(path.join(ROOT, "client/src/components/shared/Interview.tsx"), "utf8");
  const firstDecl = iv.search(/^(interface|type|const|let|function|class|export)\b/m);
  const imp = iv.search(IMPORT);
  assert.ok(firstDecl > 0 && imp >= 0 && imp < firstDecl,
    "Interview.tsx: keep `import { CimpleWordmark }` in the first import block, beside AIConversationInterface (merge-safe with the together stream)");
}

console.log("brand-lockup: ok");
