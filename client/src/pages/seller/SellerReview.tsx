/**
 * SellerReview — the seller reads their CIM and approves it, or asks for
 * changes. Route: /seller/:token/review (inside SellerLayout).
 *
 * Before this page, "Seller approved" was a step nobody could take but the
 * broker ("Approve as Seller"), so a CIM could reach buyers without the
 * seller reading it. The seller sees the named CIM exactly as an LOI buyer
 * would, once the broker has approved it (content, then design).
 */
import { useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowLeft, CheckCircle2, Clock, Loader2, MessageSquareText, RefreshCw } from "lucide-react";
import type { CimSection } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { buildBranding } from "@/components/cim/CimBrandingContext";
import { CimDesignProvider, buildCimDesign, type CimDesignPayload } from "@/components/cim/CimDesignContext";
import { CimMediaProvider } from "@/components/cim/CimMediaContext";
import { CimSheet } from "@/components/cim/CimSheet";
import { CimSectionRenderer } from "@/components/cim/CimSectionRenderer";
import { SectionBoundary } from "@/components/cim/SectionBoundary";
import { CimContactPage, CimDisclaimerPage, withBrokeragePages } from "@/components/cim/CimFrontBackPages";
// dd: what buyers read about the figures, in the owner's words (D22).
import { FigureNotesReview, type SellerFigureNoteRow } from "./review/FigureNotesReview";

type Stage = "not_ready" | "content" | "design" | "waiting" | "approved";

interface ReviewData {
  stage: Stage;
  businessName: string;
  approvals: { content: boolean; design: boolean };
  /** The deal's own broker is looking at the seller's link. */
  previewByBroker?: boolean;
  /** This link may approve / ask for changes (the owner's). An accountant's or attorney's link reads only. */
  canApprove?: boolean;
  sections: CimSection[];
  design: CimDesignPayload | null;
  changesRequested?: { id: string; note: string; at: string }[];
  /** dd: approved notes on the figures that quote the owner. */
  figureNotes?: SellerFigureNoteRow[];
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body && typeof body.error === "string" && body.error) || fallback;
}

export default function SellerReview() {
  const { token } = useParams<{ token: string }>();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const key = ["/api/seller", token, "cim-review"] as const;

  const { data, isLoading, error, refetch, isFetching } = useQuery<ReviewData>({
    queryKey: key,
    queryFn: async () => {
      const res = await fetch(`/api/seller/${token}/cim-review`);
      if (!res.ok) throw new Error(await readError(res, "Couldn't load your CIM"));
      return res.json();
    },
    enabled: !!token,
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: key });
    queryClient.invalidateQueries({ queryKey: [`/api/seller/${token}/progress`] });
  };

  const approve = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/seller/${token}/cim-review/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Seller-Token": token! },
        body: JSON.stringify({ stage: data?.stage }),
      });
      if (!res.ok) throw new Error(await readError(res, "Couldn't record your approval"));
      return res.json();
    },
    onSuccess: () => {
      refresh();
      toast({ title: "Approved — thank you", description: "Your broker has been told." });
    },
    onError: (e: Error) => {
      refresh();
      toast({ title: "Not approved yet", description: e.message, variant: "destructive" });
    },
  });
  const requestChanges = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/seller/${token}/cim-review/request-changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Seller-Token": token! },
        body: JSON.stringify({ note, stage: data?.stage }),
      });
      if (!res.ok) throw new Error(await readError(res, "Couldn't send your note"));
      return res.json();
    },
    onSuccess: () => {
      setAsking(false);
      setNote("");
      refresh();
      toast({ title: "Sent to your broker", description: "They'll update the CIM and send it back to you." });
    },
    onError: (e: Error) => toast({ title: "Couldn't send it", description: e.message, variant: "destructive" }),
  });

  const back = (
    <Link href={`/seller/${token}/progress`}>
      <div className="h-8 w-8 rounded-lg border border-border flex items-center justify-center hover:bg-muted/50 cursor-pointer transition-colors" aria-label="Back to your progress">
        <ArrowLeft className="h-4 w-4 text-muted-foreground" />
      </div>
    </Link>
  );

  if (isLoading) {
    return (
      <div className="p-6 max-w-4xl mx-auto space-y-6">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-[60vh] bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="rounded-lg border border-border bg-card p-8 text-center space-y-3">
          <AlertCircle className="h-8 w-8 mx-auto text-destructive/70" />
          <h2 className="text-lg font-semibold">Couldn't load your CIM</h2>
          <p className="text-sm text-muted-foreground">{error instanceof Error ? error.message : "Something went wrong."}</p>
          <Button variant="outline" size="sm" disabled={isFetching} onClick={() => refetch()}>
            <RefreshCw className={`h-3.5 w-3.5 mr-2 ${isFetching ? "animate-spin" : ""}`} /> Try again
          </Button>
        </div>
      </div>
    );
  }

  if (data.stage === "not_ready" || data.sections.length === 0) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-6">
        <div className="flex items-center gap-3">{back}<h1 className="text-2xl font-semibold tracking-tight">Your CIM</h1></div>
        <div className="rounded-lg border border-border bg-card p-8 text-center space-y-2">
          <Clock className="h-8 w-8 mx-auto text-muted-foreground/60" />
          <h2 className="text-base font-semibold">Not ready for you yet</h2>
          <p className="text-sm text-muted-foreground">
            Your broker is still preparing your CIM. You'll get an email when it's ready for you to read.
          </p>
        </div>
      </div>
    );
  }

  const design = buildCimDesign(data.design, "normal");
  const branding = buildBranding(null, { businessName: data.businessName });
  const pages = withBrokeragePages(data.sections, {
    disclaimer: design.brokerage.showDisclaimerPage !== false,
    contact: design.brokerage.showContactPage !== false,
  });
  const readOnly = data.canApprove === false;
  const open = !readOnly && (data.stage === "content" || data.stage === "design");
  const pendingRequest = (data.changesRequested?.length ?? 0) > 0;

  return (
    <div className="pb-40 sm:pb-32">
      <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-4">
        <div className="flex items-start gap-3">
          {back}
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">
              {readOnly ? "The CIM" : data.stage === "design" ? "Sign off your CIM" : "Review your CIM"}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              This is the document buyers read about {data.businessName.replace(/\.$/, "")}. Check that everything is accurate and that
              you're comfortable with what it shares.
            </p>
          </div>
        </div>

        {data.previewByBroker && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600">
            You're signed in as the broker — this is the seller's page. Only the seller can approve here; use
            “Approve on the seller's behalf” on the deal if they approved it with you.
          </div>
        )}
        {readOnly && (
          <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground" data-testid="text-review-read-only">
            The business owner signs off the CIM. You can read it here — send any comments to your broker.
          </div>
        )}
        {!open && !readOnly && (
          <div className="rounded-lg border border-teal/30 bg-teal/5 p-4 flex items-start gap-3" data-testid="text-review-done">
            <CheckCircle2 className="h-5 w-5 text-teal shrink-0 mt-0.5" />
            <p className="text-sm">
              {data.stage === "approved"
                ? "You've signed off your CIM. Your broker takes it from here."
                : "You approved the content. Your broker is finishing the design and will send it back for your sign-off."}
            </p>
          </div>
        )}
        {open && pendingRequest && (
          <div className="rounded-lg border border-border bg-card p-4 text-sm" data-testid="text-changes-requested">
            <p className="font-medium flex items-center gap-2"><MessageSquareText className="h-4 w-4 text-teal" /> Your broker has your note</p>
            <p className="text-muted-foreground mt-1 whitespace-pre-wrap break-words">“{data.changesRequested![data.changesRequested!.length - 1].note}”</p>
            <p className="text-xs text-muted-foreground mt-2">They'll update the CIM and let you know. You can still approve it as it is.</p>
          </div>
        )}

        <FigureNotesReview token={token!} notes={data.figureNotes ?? []} canChange={!readOnly && !data.previewByBroker} onChanged={refresh} />

        <CimMediaProvider value={{ sellerToken: token }}>
          <CimDesignProvider design={design} sections={data.sections}>
            <CimSheet className="px-4 py-6 sm:px-10 sm:py-12">
              {pages.map((item) =>
                item.kind === "disclaimer" ? (
                  <CimDisclaimerPage key={item.key} />
                ) : item.kind === "contact" ? (
                  <CimContactPage key={item.key} />
                ) : (
                  <div key={item.key}>
                    <SectionBoundary sectionTitle={item.section.sectionTitle}>
                      <CimSectionRenderer section={item.section} branding={branding} />
                    </SectionBoundary>
                  </div>
                ),
              )}
            </CimSheet>
          </CimDesignProvider>
        </CimMediaProvider>
      </div>

      {/* Decision bar */}
      {open && (
        <div className="fixed bottom-0 inset-x-0 z-30 border-t border-border bg-background/95 backdrop-blur" data-testid="bar-seller-review">
          <div className="max-w-4xl mx-auto px-4 py-3 sm:px-6">
            {asking ? (
              <div className="space-y-2">
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  maxLength={4000}
                  placeholder="What should change? For example: “Revenue for 2023 should be $1.42M” or “Please don't mention our largest customer by name.”"
                  className="text-sm"
                  data-testid="input-change-note"
                />
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>Cancel</Button>
                  <Button
                    size="sm"
                    className="bg-teal text-teal-foreground hover:bg-teal/90"
                    disabled={note.trim().length < 3 || requestChanges.isPending}
                    onClick={() => requestChanges.mutate()}
                    data-testid="button-send-change-note"
                  >
                    {requestChanges.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                    Send to my broker
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
                  Nothing goes to buyers until you've signed off.
                </p>
                <div className="flex flex-col-reverse gap-2 sm:flex-row">
                  <Button variant="outline" onClick={() => setAsking(true)} data-testid="button-request-changes">
                    Ask for changes
                  </Button>
                  <Button
                    className="bg-teal text-teal-foreground hover:bg-teal/90"
                    disabled={approve.isPending || !!data.previewByBroker}
                    onClick={() => approve.mutate()}
                    data-testid="button-approve-cim"
                  >
                    {approve.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                    {data.stage === "design" ? "Sign off the CIM" : "Approve the content"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
