/**
 * GlProgressCard — the seller's progress-page card for "Show us where a few
 * costs are in your books" (gl spec §3.2). Only when the broker asked, and
 * only on the owner's or the accountant's link (the server sends nothing to
 * anyone else). One card, the right words for where they are.
 */
import { Link } from "wouter";
import { BookCheck, ChevronRight, Clock, MessageSquare, RotateCcw, UserRound } from "lucide-react";

export interface SellerGlProgress {
  state: "requested" | "in_progress" | "question" | "reopened" | "waiting_for_accountant" | "waiting_for_broker" | "withdrawn" | "done" | "not_requested";
  total: number;
  done: number;
  question: { costId: string; sellerLabel: string; text: string } | null;
  reopened: Array<{ costId: string; sellerLabel: string }>;
  accountantName: string | null;
  ledgerOnFile: boolean;
  firstLabel: string | null;
}

const lower = (s: string) => (/^[A-Z][a-z]/.test(s) && !/^[A-Z][a-z]+\s+[A-Z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

export function GlProgressCard({ token, gl }: { token: string; gl: SellerGlProgress | null | undefined }) {
  if (!gl || gl.state === "withdrawn" || gl.state === "done" || gl.state === "not_requested") return null;
  const books = `/seller/${token}/books`;
  let title: string;
  let description: string;
  let button = "Start";
  let href = books;
  let Icon = BookCheck;
  const n = gl.total;
  switch (gl.state) {
    case "question":
      title = "Your broker has a question about your books";
      description = `About: ${gl.question?.sellerLabel ?? "a cost"}. ${gl.question?.text ?? ""}`.trim();
      button = "Answer";
      href = gl.question ? `${books}?cost=${gl.question.costId}` : books;
      Icon = MessageSquare;
      break;
    case "reopened":
      title = `Your broker updated ${gl.reopened.length} cost${gl.reopened.length === 1 ? "" : "s"}`;
      description = `Please check the entries still fit: ${gl.reopened.map((r) => r.sellerLabel).join(", ")}.`;
      button = "Check";
      href = gl.reopened[0] ? `${books}?cost=${gl.reopened[0].costId}` : books;
      Icon = RotateCcw;
      break;
    case "waiting_for_accountant":
      title = `Waiting for ${gl.accountantName ?? "your accountant"}`;
      description = `Your broker is sending ${(gl.accountantName ?? "them").split(/\s+/)[0]} their own link. You'll see the ledger here once they've uploaded it.`;
      button = "Do it myself instead";
      Icon = UserRound;
      break;
    case "waiting_for_broker":
      title = "Thanks — your broker is checking your entries";
      description = "You can still change anything until they finish.";
      button = "Review what you sent";
      Icon = Clock;
      break;
    case "in_progress":
      title = gl.ledgerOnFile ? "Check a few costs we found in your books" : "Show us where a few costs are in your books";
      description = `${gl.done} of ${n} done. Pick up where you left off — everything is saved.`;
      button = "Continue";
      break;
    default:
      if (gl.ledgerOnFile) {
        title = "Check a few costs we found in your books";
        description = `Your broker listed ${n} cost${n === 1 ? "" : "s"}. We've already found the likely entries in the ledger you uploaded — check they're right. About 15–30 minutes; everything saves as you go.`;
      } else {
        title = "Show us where a few costs are in your books";
        description = `Your broker listed ${n} cost${n === 1 ? "" : "s"} the business pays that a new owner wouldn't${gl.firstLabel ? ` — like ${lower(gl.firstLabel)}` : ""}. Buyers will ask to see them in your bookkeeping. Upload your general ledger, then check the entries we find. About 20–40 minutes; everything saves as you go.`;
      }
  }
  return (
    <Link href={href} className="block">
      <div className="rounded-lg border border-teal/30 bg-teal/5 p-5 hover:bg-teal/8 transition-colors cursor-pointer group" data-testid="cta-gl-books" aria-label={button}>
        <div className="flex items-start gap-4">
          <div className="h-10 w-10 rounded-lg bg-teal/15 flex items-center justify-center shrink-0">
            <Icon className="h-5 w-5 text-teal" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-medium">{title}</h3>
            <p className="text-sm text-muted-foreground mt-1">{description}</p>
            <p className="text-sm text-teal mt-2">{button}</p>
          </div>
          <ChevronRight className="h-5 w-5 text-teal/40 group-hover:text-teal mt-1 shrink-0" />
        </div>
      </div>
    </Link>
  );
}
