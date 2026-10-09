/**
 * GlEvidenceBlock — the due-diligence page "Where each add-back is in the
 * books" (gl spec §3.6), drawn on the CIM paper from the payload
 * server/gl/evidence.ts built (rendered for layoutType "gl_evidence").
 *
 * Per add-back: its status, then "Where the cost is in the books" — each
 * year's entries (date · account · paid to · description · amount; the
 * first 12, "Show all", at most 200, the rest in the general ledger), the
 * subtotal against what was added back, supporting documents — then "Why
 * it's added back" (the broker's words) and, when the broker shows them,
 * the owner's explanation and the broker's note. Withheld entries keep
 * their date, account and amount. Words from shared/gl-evidence.ts: "found
 * in the books … not an audit" — never "verified".
 *
 * Phones: entries stack as two-line rows; nothing scrolls sideways.
 * Paper colours only (.cim-doc is theme-locked).
 */
import { createContext, useContext, useState } from "react";
import { useRoute } from "wouter";
import { BookCheck, FileText, Loader2, MessageSquare } from "lucide-react";
import {
  GL_BUYER_STATUS_WORDS, GL_EVIDENCE_FIRST_ENTRIES, glConfirmationText, glIntroText, glShareText, glTieOutLines, isGlEvidencePayload,
  type GlBuyerStatus, type GlEvidenceEntry, type GlEvidenceLine, type GlEvidencePayload, type GlEvidenceYear,
} from "@shared/gl-evidence";
import { accountPath, formatDay } from "@shared/gl-copy";
import { useBlockAttrs } from "../blocks";
import { useGlLinks } from "./GlLinks";
import { GL_FOUND_INK } from "./GlMark";

const money = (d: number) => `${d < 0 ? "−" : ""}$${Math.abs(Math.round(d)).toLocaleString("en-US")}`;
const exact = (d: number) => `${d < 0 ? "−" : ""}$${Math.abs(d).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const PILL: Record<GlBuyerStatus, { color: string; bg: string }> = {
  found: { color: GL_FOUND_INK, bg: `${GL_FOUND_INK}12` },
  document: { color: GL_FOUND_INK, bg: `${GL_FOUND_INK}12` },
  partly_found: { color: "hsl(var(--cim-caution))", bg: "hsl(var(--cim-caution) / 0.10)" },
  not_found: { color: "hsl(var(--cim-ink-muted))", bg: "hsl(var(--cim-stripe))" },
  statement: { color: "hsl(var(--cim-ink-soft))", bg: "hsl(var(--cim-stripe))" },
};

interface Props {
  layoutData: unknown;
}

/** "Ask about this entry" — only in a buyer's view room (/view/:token), never in a broker preview. */
type AskTarget = { lineId: string; rowNo: number | null; about: string };
const AskContext = createContext<{ token: string | null; ask: (t: AskTarget) => void } | null>(null);

export function GlEvidenceBlock({ layoutData }: Props) {
  const ba = useBlockAttrs();
  const [, params] = useRoute("/view/:token");
  const token = params?.token ?? null;
  const [asking, setAsking] = useState<AskTarget | null>(null);
  if (!isGlEvidencePayload(layoutData)) return null;
  const p = layoutData as GlEvidencePayload;
  const tie = glTieOutLines(p.tieOut, money);
  const confirmed = glConfirmationText(p.confirmation);
  return (
    <div className="space-y-5" data-testid="gl-evidence">
      {p.preview && (
        <p className="rounded-md border border-[hsl(var(--cim-brass)/0.4)] bg-[hsl(var(--cim-brass)/0.08)] px-3 py-2 text-xs text-[hsl(var(--cim-ink-soft))]" data-testid="gl-evidence-preview">
          Not shown to buyers yet — this is what they'll see after you publish it on Financials → Add-backs in the books.
        </p>
      )}
      <p className="text-sm leading-relaxed text-[hsl(var(--cim-ink-soft))]" {...ba("intro")}>{glIntroText(p.source)}</p>

      {(tie.length > 0 || confirmed) && (
        <div className="rounded-lg border border-[hsl(var(--cim-line))] bg-[hsl(var(--cim-card))] px-4 py-3" {...ba("summary")}>
          {tie.length > 0 && (
            <>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[hsl(var(--cim-ink-muted))]">Does the ledger match the statements?</p>
              <ul className="mt-1.5 space-y-1 text-sm text-[hsl(var(--cim-ink))]">
                {tie.map((t) => <li key={t}>{t}</li>)}
              </ul>
            </>
          )}
          {confirmed && <p className={`${tie.length ? "mt-2" : ""} text-sm text-[hsl(var(--cim-ink-soft))]`}>{confirmed}</p>}
        </div>
      )}

      <AskContext.Provider value={token && !p.preview ? { token, ask: setAsking } : null}>
        <div className="space-y-4">
          {p.lines.map((line, i) => line.status === "statement" ? null : (
            <LineBlock key={line.lineId} line={line} attrs={ba(`item:${i}`)} asking={asking?.lineId === line.lineId ? asking : null} onDone={() => setAsking(null)} />
          ))}
          <StatementLines lines={p.lines} attrsFor={(i) => ba(`item:${i}`)} />
        </div>
      </AskContext.Provider>
    </div>
  );
}

function AskForm({ target, onDone }: { target: AskTarget; onDone: () => void }) {
  const ctx = useContext(AskContext);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  if (!ctx) return null;
  const send = async () => {
    setState("sending");
    setError(null);
    try {
      const r = await fetch(`/api/view/${ctx.token}/gl/question`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ lineId: target.lineId, rowNo: target.rowNo, text }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || "Your question couldn't be sent — try again.");
      setState("sent");
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "Your question couldn't be sent — try again.");
    }
  };
  return (
    <div className="mt-3 rounded-md border border-[hsl(var(--cim-line))] bg-[hsl(var(--cim-paper))] p-3" data-testid="gl-ask-form">
      {state === "sent" ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-[hsl(var(--cim-ink-soft))]">
          <span>Sent to your broker. Their answer will appear with your questions.</span>
          <button type="button" className="text-xs font-medium text-[hsl(var(--cim-brass))] hover:underline" onClick={onDone}>Close</button>
        </div>
      ) : (
        <>
          <label htmlFor={`gl-ask-${target.lineId}`} className="block text-xs font-medium text-[hsl(var(--cim-ink-soft))]">Ask your broker — {target.about}</label>
          <textarea
            id={`gl-ask-${target.lineId}`}
            className="mt-1.5 w-full rounded-md border border-[hsl(var(--cim-line))] bg-[hsl(var(--cim-card))] px-2.5 py-2 text-sm text-[hsl(var(--cim-ink))] focus:outline-none focus:ring-1 focus:ring-[hsl(var(--cim-brass))]"
            rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Is this lease for the owner's own car?"
          />
          {error && <p className="mt-1 text-xs text-[hsl(var(--cim-caution))]">{error}</p>}
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <button type="button" className="h-8 rounded-md px-3 text-xs text-[hsl(var(--cim-ink-muted))] hover:text-[hsl(var(--cim-ink))]" onClick={onDone}>Cancel</button>
            <button
              type="button" disabled={text.trim().length < 3 || state === "sending"} onClick={send}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[hsl(var(--cim-ink))] px-3 text-xs font-medium text-[hsl(var(--cim-paper))] disabled:opacity-50"
            >
              {state === "sending" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Send privately
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function AskButton({ target, label = "Ask" }: { target: AskTarget; label?: string }) {
  const ctx = useContext(AskContext);
  if (!ctx) return null;
  return (
    <button type="button" className="inline-flex items-center gap-1 text-[11px] font-medium text-[hsl(var(--cim-brass))] hover:underline" onClick={() => ctx.ask(target)} data-testid="gl-ask">
      <MessageSquare className="h-3 w-3" aria-hidden /> {label}
    </button>
  );
}

/** Lines straight from the financial statements (amortization, interest, taxes): one compact card at the end. */
function StatementLines({ lines, attrsFor }: { lines: GlEvidenceLine[]; attrsFor: (i: number) => Record<string, string> }) {
  const links = useGlLinks();
  const rows = lines.map((l, i) => ({ l, i })).filter((x) => x.l.status === "statement");
  if (rows.length === 0) return null;
  return (
    <section className="rounded-lg border border-[hsl(var(--cim-line))] bg-[hsl(var(--cim-paper))] px-4 py-3 sm:px-5" data-testid="gl-statement-lines">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-[hsl(var(--cim-heading))]">From the financial statements</h4>
        <span className="text-xs text-[hsl(var(--cim-ink-muted))]">No separate entries to show</span>
      </div>
      <ul className="mt-2 divide-y divide-[hsl(var(--cim-line-soft))]">
        {rows.map(({ l, i }) => {
          const ys = (l.years ?? []).filter((y) => y.status !== "left_out");
          return (
            <li key={l.lineId} className="flex flex-col gap-0.5 py-1.5 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-4" {...attrsFor(i)}>
              <span className="min-w-0 break-words text-[hsl(var(--cim-ink))]">
                {l.label ?? "Add-back"}
                {(l.statementDocs ?? []).length > 0 && (
                  <span className="ml-1.5 text-xs text-[hsl(var(--cim-ink-muted))]">· {(l.statementDocs ?? []).slice(0, 3).map((d, k) => (
                    <span key={`${d.documentId}-${d.year}`}>{k > 0 && ", "}{links.doc ? links.doc(d.documentId, d.name) : d.name}</span>
                  ))}</span>
                )}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-[hsl(var(--cim-ink-soft))]">{ys.map((y) => `${y.year} ${money(y.claimed)}`).join(" · ")}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function StatusPill({ status }: { status: GlBuyerStatus }) {
  const s = PILL[status];
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ color: s.color, backgroundColor: s.bg }} data-testid={`gl-status-${status}`}>
      {(status === "found" || status === "document") && <BookCheck className="h-3 w-3" aria-hidden />}
      {GL_BUYER_STATUS_WORDS[status]}
    </span>
  );
}

function LineBlock({ line, attrs, asking, onDone }: { line: GlEvidenceLine; attrs: Record<string, string>; asking: AskTarget | null; onDone: () => void }) {
  const links = useGlLinks();
  const askable = !!useContext(AskContext);
  const years = (line.years ?? []).filter((y) => y.status !== "left_out");
  const rows = years.flatMap((y) => y.entries.map((e) => e.rowNo).filter((n): n is number => typeof n === "number"));
  const ledgerLink = line.ledger
    ? links.ledger
      ? links.ledger(line.ledger.documentId, rows)
      : <span className="text-[hsl(var(--cim-ink-muted))]">The full general ledger is in the data room — ask your broker for access.</span>
    : null;
  return (
    <section className="rounded-lg border border-[hsl(var(--cim-line))] bg-[hsl(var(--cim-card))] px-4 py-4 sm:px-5" {...attrs} data-testid={`gl-line-${line.lineId}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="min-w-0 break-words text-[15px] font-semibold text-[hsl(var(--cim-heading))]">{line.label ?? "Add-back"}</h4>
        <StatusPill status={line.status} />
      </header>

      {line.status === "statement" ? (
        <div className="mt-2 space-y-1 text-sm text-[hsl(var(--cim-ink-soft))]">
          <p>{years.map((y) => `${y.yearLabel || y.year}: ${money(y.claimed)}`).join(" · ")}</p>
          <p className="text-xs text-[hsl(var(--cim-ink-muted))]">This line comes straight from the financial statements; there are no separate entries to show.</p>
          {(line.statementDocs ?? []).length > 0 && (
            <p className="text-xs">Shown in: {(line.statementDocs ?? []).map((d, i) => (
              <span key={`${d.documentId}-${d.year}`}>{i > 0 && ", "}{links.doc ? links.doc(d.documentId, d.name) : d.name}</span>
            ))}</p>
          )}
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[hsl(var(--cim-ink-muted))]">Where the cost is in the books</p>
          <div className="mt-2 space-y-4">
            {years.map((y, i) => <YearBlock key={y.year} line={line} year={y} defaultOpen={i === years.length - 1} />)}
          </div>
        </div>
      )}

      {(line.why || line.sellerNote || line.brokerNote) && (
        <div className="mt-4 border-t border-[hsl(var(--cim-line-soft))] pt-3 space-y-2 text-sm">
          {line.why && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[hsl(var(--cim-ink-muted))]">Why it's added back</p>
              <p className="mt-1 text-[hsl(var(--cim-ink))]">{line.why}</p>
            </div>
          )}
          {line.sellerNote && <p className="text-[hsl(var(--cim-ink-soft))]"><span className="font-medium">The owner's explanation: </span>{line.sellerNote}</p>}
          {line.brokerNote && <p className="text-[hsl(var(--cim-ink-soft))]"><span className="font-medium">The broker's note: </span>{line.brokerNote}</p>}
        </div>
      )}

      {(ledgerLink && line.status !== "statement") || askable ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span>{line.status !== "statement" ? ledgerLink : null}</span>
          <AskButton target={{ lineId: line.lineId, rowNo: null, about: `the add-back "${line.label ?? "Add-back"}"` }} label="Ask about this add-back" />
        </div>
      ) : null}
      {asking && <AskForm target={asking} onDone={onDone} />}
    </section>
  );
}

/** One year: the latest is open; earlier years show their subtotal and open on a tap (the page stays digestible). */
function YearBlock({ line, year: y, defaultOpen }: { line: GlEvidenceLine; year: GlEvidenceYear; defaultOpen: boolean }) {
  const links = useGlLinks();
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  const shown = all ? y.entries : y.entries.slice(0, GL_EVIDENCE_FIRST_ENTRIES);
  const hasShare = !!line.share && y.target !== y.claimed;
  const diffPct = y.target ? Math.abs(y.difference) / Math.abs(y.target) : 0;
  const noSupport = y.entryCount === 0 && (line.docs ?? []).filter((d) => d.year === y.year).length === 0;
  const docs = (line.docs ?? []).filter((d) => d.year === y.year);
  return (
    <div data-testid={`gl-year-${y.year}`}>
      <p className="text-sm font-medium text-[hsl(var(--cim-ink))]">
        {y.yearLabel || y.year} <span className="font-normal text-[hsl(var(--cim-ink-muted))]">· Added back {money(y.claimed)}</span>
      </p>
      {hasShare && line.share && (
        <p className="mt-0.5 text-xs text-[hsl(var(--cim-ink-muted))]">{glShareText(line.label ?? "The cost's", line.share, y.target, y.claimed, money)}</p>
      )}

      {y.entriesOnRequest ? (
        <p className="mt-1.5 text-xs text-[hsl(var(--cim-ink-muted))]">{y.entryCount} entr{y.entryCount === 1 ? "y" : "ies"} — the entries are available on request. Ask your broker.</p>
      ) : noSupport ? (
        <p className="mt-1.5 text-xs text-[hsl(var(--cim-ink-muted))]">No entries were found in the books for this year.</p>
      ) : y.entries.length > 0 && !open ? (
        <button type="button" className="mt-1 text-xs font-medium text-[hsl(var(--cim-brass))] hover:underline" onClick={() => setOpen(true)} aria-expanded={false} data-testid={`gl-year-open-${y.year}`}>
          Show the {y.entries.length} entr{y.entries.length === 1 ? "y" : "ies"}
        </button>
      ) : y.entries.length > 0 ? (
        <>
          <EntriesTable entries={shown} lineId={line.lineId} />
          {y.entries.length > GL_EVIDENCE_FIRST_ENTRIES && (
            <button type="button" className="mt-1.5 text-xs font-medium text-[hsl(var(--cim-brass))] hover:underline" onClick={() => setAll((v) => !v)} aria-expanded={all}>
              {all ? "Show fewer" : `Show all ${y.entries.length}`}
            </button>
          )}
          {y.moreEntries > 0 && (
            <p className="mt-1 text-xs text-[hsl(var(--cim-ink-muted))]">+{y.moreEntries.toLocaleString("en-US")} more in the general ledger.</p>
          )}
        </>
      ) : null}

      {docs.length > 0 && (
        <ul className="mt-2 space-y-1">
          {docs.map((d) => (
            <li key={`${d.documentId}-${d.year}`} className="flex items-start gap-1.5 text-xs text-[hsl(var(--cim-ink-soft))]">
              <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--cim-ink-muted))]" aria-hidden />
              <span>Shown by: {links.doc ? links.doc(d.documentId, d.name) : d.name} — {money(d.amount)}</span>
            </li>
          ))}
        </ul>
      )}

      {!noSupport && !y.entriesOnRequest && (
        <p className="mt-2 text-xs text-[hsl(var(--cim-ink-soft))]" data-testid={`gl-subtotal-${y.year}`}>
          {y.entryCount > 0 ? "These entries" : "Shown"}: <span className="font-medium tabular-nums">{money(y.found)}</span>
          {" · "}{hasShare ? "The whole cost" : "Added back"}: <span className="tabular-nums">{money(y.target)}</span>
          {" · "}Difference: <span className="tabular-nums">{Math.round(y.difference) === 0 ? "none" : `${money(Math.abs(y.difference))} (${(diffPct * 100).toFixed(1)}%)`}</span>
        </p>
      )}
    </div>
  );
}

function EntryText({ e }: { e: GlEvidenceEntry }) {
  if (e.withheld) return <span className="italic text-[hsl(var(--cim-ink-muted))]">{e.memo}</span>;
  return <>{e.memo || "—"}</>;
}

function entryAbout(e: GlEvidenceEntry): string {
  return `the entry of ${formatDay(e.date) || e.date}, ${exact(e.amount)} in ${accountPath(e.account)}`;
}

function EntriesTable({ entries, lineId }: { entries: GlEvidenceEntry[]; lineId: string }) {
  return (
    <>
      {/* ≥ sm: a table */}
      <div className="mt-2 hidden sm:block">
        <table className="w-full table-fixed border-collapse text-xs">
          <thead>
            <tr className="border-b border-[hsl(var(--cim-line))] text-left text-[10px] uppercase tracking-wide text-[hsl(var(--cim-ink-muted))]">
              <th className="w-[15%] py-1.5 pr-2 font-medium">Date</th>
              <th className="w-[24%] py-1.5 pr-2 font-medium">Account</th>
              <th className="w-[20%] py-1.5 pr-2 font-medium">Paid to</th>
              <th className="py-1.5 pr-2 font-medium">Description</th>
              <th className="w-[15%] py-1.5 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={`${e.rowNo ?? i}-${i}`} className="border-b border-[hsl(var(--cim-line-soft))] align-top text-[hsl(var(--cim-ink))]">
                <td className="py-1.5 pr-2 tabular-nums whitespace-nowrap">{formatDay(e.date) || e.date}</td>
                <td className="py-1.5 pr-2 break-words">{accountPath(e.account)}</td>
                <td className="py-1.5 pr-2 break-words">{e.name || <span className="text-[hsl(var(--cim-ink-faint))]">—</span>}</td>
                <td className="py-1.5 pr-2 break-words">
                  <EntryText e={e} />
                  {e.rowNo !== null && <span className="ml-1.5 align-middle"><AskButton target={{ lineId, rowNo: e.rowNo, about: entryAbout(e) }} /></span>}
                </td>
                <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{exact(e.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* phones: two-line rows */}
      <ul className="mt-2 divide-y divide-[hsl(var(--cim-line-soft))] border-y border-[hsl(var(--cim-line-soft))] sm:hidden">
        {entries.map((e, i) => (
          <li key={`${e.rowNo ?? i}-${i}`} className="py-1.5 text-xs">
            <div className="flex items-baseline justify-between gap-2 text-[hsl(var(--cim-ink))]">
              <span className="tabular-nums">{formatDay(e.date) || e.date}</span>
              <span className="tabular-nums font-medium">{exact(e.amount)}</span>
            </div>
            <p className="mt-0.5 break-words text-[hsl(var(--cim-ink-soft))]">
              {accountPath(e.account)}{e.name ? ` · ${e.name}` : ""}
            </p>
            <p className="break-words text-[hsl(var(--cim-ink-muted))]">
              <EntryText e={e} />
              {e.rowNo !== null && <span className="ml-1.5"><AskButton target={{ lineId, rowNo: e.rowNo, about: entryAbout(e) }} /></span>}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}
