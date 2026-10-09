/**
 * GlKpiStrip — the five cells on top of "Add-backs in the books" (gl spec
 * §3.4): the ledger, whether it matches the statements, the add-backs, the
 * seller, buyers. 1440: one row of five; phones: two columns, the last cell
 * full width. Each cell opens the view it's about.
 */
import { KpiCell, ago, shortDate } from "./gl-ui";
import { formatCount, formatPeriod, softwareLabel } from "@shared/gl-copy";
import type { BrokerGlData } from "@/lib/gl-api";

export type GlView = "addbacks" | "ledger" | "statements" | "seller";

export function GlKpiStrip({ data, onOpen, onBuyers }: { data: BrokerGlData; onOpen: (v: GlView) => void; onBuyers?: () => void }) {
  const ledgers = data.ledgers;
  const ready = ledgers.filter((l) => l.status === "ready" && l.role === "ledger");
  const reading = ledgers.some((l) => l.status === "reading");
  const needsColumns = ledgers.some((l) => l.status === "needs_columns");
  const failed = ledgers.some((l) => l.status === "failed");
  const rows = ready.reduce((n, l) => n + l.rowCount, 0);
  const starts = ready.map((l) => l.periodStart).filter(Boolean).sort() as string[];
  const ends = ready.map((l) => l.periodEnd).filter(Boolean).sort() as string[];
  const period = starts.length && ends.length ? formatPeriod(starts[0], ends[ends.length - 1]) : "";
  const privateOnly = ready.length > 0 && ready.every((l) => l.audience === "broker");

  let ledgerText: string;
  let ledgerTone: "good" | "warn" | "muted" = "muted";
  let ledgerSub: string | undefined;
  if (needsColumns) { ledgerText = "Needs columns"; ledgerTone = "warn"; ledgerSub = "Cimple couldn't tell which column is which — check it."; }
  else if (ready.length) {
    const program = ready[0].software && ready[0].software !== "other" ? softwareLabel(ready[0].software).replace(/ export$/, "") : "General ledger";
    ledgerText = `${program} · ${formatCount(rows)} entries`;
    ledgerSub = privateOnly ? "Private to you — the seller can't see it" : period;
    ledgerTone = privateOnly ? "warn" : "good";
  } else if (reading) { ledgerText = "Reading…"; }
  else if (failed) { ledgerText = "Needs another look"; ledgerTone = "warn"; }
  else { ledgerText = "Not uploaded yet"; }

  const tie = data.tieOut?.summary;
  const traces = (data.traces ?? []).filter((t) => t.proof !== "statement" && t.includeInCim);
  const count = (pred: (s: string) => boolean) => traces.filter((t) => pred(t.computed?.overall ?? "not_started")).length;
  const found = count((s) => s === "found" || s === "document");
  const close = count((s) => s === "close");
  const toGo = traces.length - found - close;
  const addbacksText = traces.length === 0 ? "None need proof" : [found ? `${found} found` : "", close ? `${close} close` : "", toGo ? `${toGo} to go` : ""].filter(Boolean).join(" · ");
  const reviewed = traces.filter((t) => t.reviewedAt).length;

  const tr = data.tracing;
  let sellerText = "Not asked yet";
  let sellerSub: string | undefined;
  let sellerTone: "good" | "warn" | "muted" = "muted";
  if (tr?.withdrawnAt) { sellerText = "Request withdrawn"; }
  else if (tr?.sellerDoneAt) { sellerText = `Finished ${shortDate(tr.sellerDoneAt)}`; sellerSub = tr.sellerConfirmation ? `Confirmed by the ${tr.sellerConfirmation.role === "accountant" ? "accountant" : "owner"}` : undefined; sellerTone = "good"; }
  else if (tr?.accountantRequest && !tr.accountantRequest.sentAt && !tr.accountantRequest.declinedAt) { sellerText = "Waiting for you"; sellerSub = `Send ${tr.accountantRequest.name} their link`; sellerTone = "warn"; }
  else if (tr?.cantGetLedger) { sellerText = "Can't get the ledger"; sellerTone = "warn"; }
  else if (tr?.requestedAt) {
    sellerText = "Working on it";
    sellerSub = data.sellerLastActiveAt ? `Last active ${ago(data.sellerLastActiveAt)}` : `Asked ${shortDate(tr.requestedAt)}`;
    if (tr.accountantRequest?.sentAt) sellerSub = `Their accountant, ${tr.accountantRequest.name}, has a link`;
  }

  const shownAt = data.buyers?.publishedAt ?? data.tracing?.publishedAt ?? null;
  const changes = data.buyers?.changes.length ?? 0;
  const notices = data.buyers?.notices?.length ?? 0;
  const v = data.buyers?.versions;
  const versionsWords = v ? [v.dd ? "Due diligence" : "", v.normal ? "Full" : "", v.blind ? "Blind" : ""].filter(Boolean).join(" · ") : undefined;

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-5" data-testid="gl-kpi-strip">
      <KpiCell label="Ledger" tone={ledgerTone} sub={ledgerSub} onClick={() => onOpen("ledger")} testId="gl-kpi-ledger">{ledgerText}</KpiCell>
      <KpiCell label="Matches the statements" tone={tie?.tone === "good" ? "good" : tie?.tone === "warn" ? "warn" : "muted"} onClick={() => onOpen("statements")} testId="gl-kpi-statements">
        {tie?.text ?? "Can't check yet"}
      </KpiCell>
      <KpiCell label="Add-backs" tone={traces.length && toGo === 0 ? "good" : "muted"} sub={traces.length ? `${reviewed} of ${traces.length} reviewed` : undefined} onClick={() => onOpen("addbacks")} testId="gl-kpi-addbacks">
        {addbacksText}
      </KpiCell>
      <KpiCell label="Seller" tone={sellerTone} sub={sellerSub} onClick={() => onOpen("seller")} testId="gl-kpi-seller">{sellerText}</KpiCell>
      <KpiCell
        label="Buyers"
        className="col-span-2 lg:col-span-1"
        tone={shownAt ? "good" : "muted"}
        sub={shownAt ? (changes ? `${changes} change${changes === 1 ? "" : "s"} since — update what they see` : notices ? "One thing to check — see Add-backs" : versionsWords) : "You choose what buyers see once the review is done"}
        onClick={onBuyers}
        testId="gl-kpi-buyers"
      >
        {shownAt ? `Shown since ${shortDate(shownAt)}` : "Not shown yet"}
      </KpiCell>
    </div>
  );
}
