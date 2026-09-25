/**
 * The deal's CRM card — which Pipedrive record the seller is, and importing
 * what the CRM holds (fields, notes, activities, emails, files) into the
 * deal's information. `variant="full"` on the Information tab,
 * `variant="compact"` on the Overview.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { AlertCircle, ArrowRight, Database, ExternalLink, Loader2, Lock, Plug, RefreshCw } from "lucide-react";
import type { CrmStatusResponse, CrmSearchResult } from "@shared/crm-seller";
import { CrmRecordSearch } from "./CrmRecordSearch";
import { RECORD_TYPE_LABEL, linkBody, timeAgo, useCrmAction, useCrmStatus } from "./useCrm";

type Variant = "full" | "compact";

export function CrmLinkCard({ dealId, variant = "full" }: { dealId: string; variant?: Variant }) {
  const { data, isLoading, error, refetch } = useCrmStatus(dealId);
  const action = useCrmAction(dealId);
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [searching, setSearching] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  if (isLoading) return variant === "compact" ? <Skeleton className="h-14 w-full" /> : <Skeleton className="h-32 w-full" />;
  if (error || !data) {
    if (variant === "compact") return null;
    return (
      <Shell>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <AlertCircle className="h-3.5 w-3.5 text-red-400" /> Couldn't load the CRM link.
          <button type="button" className="text-teal hover:underline" onClick={() => refetch()}>Try again</button>
        </div>
      </Shell>
    );
  }

  const link = data.link;
  const imp = data.import;
  const running = imp?.state === "running";

  const pick = (r: CrmSearchResult) => {
    setPicking(`${r.type}:${r.id}`);
    action.mutate(
      { method: "POST", path: "/crm/link", body: linkBody(r.type, r.id, true) },
      {
        onSuccess: () => {
          setSearching(false);
          toast({ title: "Linked to Pipedrive", description: `Importing ${r.title} — facts appear as each item is read.` });
        },
        onError: (e) => toast({ title: "Couldn't link", description: (e as Error).message, variant: "destructive" }),
        onSettled: () => setPicking(null),
      },
    );
  };
  const runImport = () =>
    action.mutate(
      { method: "POST", path: "/crm/import" },
      { onError: (e) => toast({ title: "Couldn't start the import", description: (e as Error).message, variant: "destructive" }) },
    );
  const unlink = () =>
    action.mutate(
      { method: "DELETE", path: "/crm/link" },
      {
        onSuccess: () => toast({ title: "Unlinked from Pipedrive", description: "Sources already imported stay on the deal." }),
        onError: (e) => toast({ title: "Couldn't unlink", description: (e as Error).message, variant: "destructive" }),
        onSettled: () => setConfirmUnlink(false),
      },
    );

  // ── Not connected ──
  if (!data.connected && !link) {
    if (variant === "compact") return null;
    return (
      <Shell>
        <Header />
        <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
          Keep the seller in Pipedrive? Connect it and Cimple pulls the seller's record, notes, emails and files into this deal —
          each fact labelled as coming from your CRM.
        </p>
        <Button size="sm" variant="outline" className="h-8 mt-3 gap-1.5 text-xs" onClick={() => setLocation("/broker/integrations")}>
          <Plug className="h-3.5 w-3.5" /> Connect Pipedrive
        </Button>
      </Shell>
    );
  }

  // ── Connected, not linked ──
  if (!link) {
    if (variant === "compact" && !searching) {
      return (
        <CompactShell>
          <Database className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Seller in Pipedrive?</p>
            <p className="text-[11px] text-muted-foreground">Link their record to import its fields, notes, emails and files.</p>
          </div>
          <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={() => setSearching(true)} data-testid="button-crm-link-compact">
            Link
          </Button>
        </CompactShell>
      );
    }
    return (
      <Shell>
        <Header />
        <p className="text-xs text-muted-foreground mt-1.5 mb-3 leading-relaxed">
          Link the seller's record in Pipedrive. Cimple imports its fields, notes, emails and files — privately — and every fact
          it finds shows "CRM" as its source.
        </p>
        <CrmRecordSearch dealId={dealId} onPick={pick} pickingId={picking} autoFocus={variant === "compact"} />
        {variant === "compact" && (
          <button type="button" className="mt-2 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setSearching(false)}>
            Cancel
          </button>
        )}
      </Shell>
    );
  }

  // ── Linked ──
  const pct = running && imp?.total ? Math.round(((imp.processed ?? 0) / imp.total) * 100) : 0;
  const statusLine = running ? (
    <span className="inline-flex items-center gap-1.5 text-teal">
      <Loader2 className="h-3 w-3 animate-spin" />
      {imp?.total ? `Importing… ${imp.processed ?? 0} of ${imp.total}` : "Reading Pipedrive…"}
    </span>
  ) : imp?.state === "failed" ? (
    <span className="inline-flex items-start gap-1.5 text-red-400">
      <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" /> {imp.message || "The import failed."}
    </span>
  ) : imp?.state === "done" ? (
    <span>
      Imported {timeAgo(imp.finishedAt ?? link.lastImportAt)}
      {imp.message ? ` · ${imp.message}` : ""}
    </span>
  ) : (
    <span>Not imported yet</span>
  );

  const importButton = (
    <Button
      size="sm"
      className={`h-8 text-xs gap-1.5 ${link.lastImportAt ? "" : "bg-teal text-teal-foreground hover:bg-teal/90"}`}
      variant={link.lastImportAt ? "outline" : "default"}
      disabled={running || action.isPending || !data.connected}
      onClick={runImport}
      data-testid="button-crm-import"
    >
      {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
      {link.lastImportAt ? "Re-import" : "Import"}
    </Button>
  );

  if (variant === "compact") {
    return (
      <CompactShell>
        <Database className="h-4 w-4 text-teal shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">
            <span className="text-muted-foreground font-normal hidden sm:inline">Pipedrive · </span>
            {link.title}
          </p>
          <p className="text-[11px] text-muted-foreground line-clamp-2">{statusLine}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {importButton}
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs gap-1 text-muted-foreground hidden sm:inline-flex"
            onClick={() => setLocation(`/deal/${dealId}/information`)}
          >
            Information <ArrowRight className="h-3 w-3" />
          </Button>
        </div>
        {running && <Progress value={pct} className="h-1 absolute left-0 right-0 bottom-0 rounded-none" />}
      </CompactShell>
    );
  }

  return (
    <Shell>
      <Header />
      <div className="mt-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug break-words">
            {link.url ? (
              <a href={link.url} target="_blank" rel="noreferrer" className="hover:text-teal inline-flex items-start gap-1">
                {link.title}
                <ExternalLink className="h-3 w-3 mt-1 shrink-0 text-muted-foreground" />
              </a>
            ) : (
              link.title
            )}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {link.linkedType ? `${RECORD_TYPE_LABEL[link.linkedType]} in Pipedrive` : "Pipedrive"}
            {link.importedCount > 0 && ` · ${link.importedCount} item${link.importedCount === 1 ? "" : "s"} imported`}
          </p>
        </div>
      </div>

      <div className="mt-3 text-xs text-muted-foreground" data-testid="crm-import-status">{statusLine}</div>
      {running && <Progress value={pct} className="h-1 mt-2" />}
      {!running && imp?.warnings?.map((w) => (
        <p key={w} className="text-[11px] text-muted-foreground/80 mt-1.5 leading-snug">{w}</p>
      ))}
      {!data.connected && (
        <p className="text-[11px] text-amber-500 mt-1.5">Pipedrive is no longer connected — reconnect it in Integrations to import again.</p>
      )}

      {searching ? (
        <div className="mt-3">
          <CrmRecordSearch dealId={dealId} onPick={pick} pickingId={picking} autoFocus placeholder="Search Pipedrive for a different record" />
          <button type="button" className="mt-2 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setSearching(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {importButton}
          <Button size="sm" variant="ghost" className="h-8 text-xs text-muted-foreground" disabled={running || !data.connected} onClick={() => setSearching(true)}>
            Change
          </Button>
          <Button size="sm" variant="ghost" className="h-8 text-xs text-muted-foreground" disabled={running || action.isPending} onClick={() => setConfirmUnlink(true)}>
            Unlink
          </Button>
        </div>
      )}

      <p className="mt-3 pt-3 border-t border-border/50 flex items-start gap-1.5 text-[11px] text-muted-foreground/80 leading-snug">
        <Lock className="h-3 w-3 mt-0.5 shrink-0" />
        Imported notes, emails and files are private to you. The seller never sees them; the interview only confirms their facts with the seller.
      </p>

      <AlertDialog open={confirmUnlink} onOpenChange={setConfirmUnlink}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink from Pipedrive?</AlertDialogTitle>
            <AlertDialogDescription>
              Nothing more is imported from "{link.title}". Sources already imported — and the facts they gave — stay on the deal; you can delete
              them from the Sources list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the link</AlertDialogCancel>
            <AlertDialogAction onClick={unlink}>Unlink</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Shell>
  );
}

function Header() {
  return (
    <div className="flex items-center gap-2">
      <Database className="h-4 w-4 text-teal" />
      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">CRM</h3>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4 min-w-0" data-testid="crm-card">
      {children}
    </section>
  );
}

function CompactShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="relative overflow-hidden rounded-lg border border-border bg-card px-4 py-3 flex items-center gap-3" data-testid="crm-card-compact">
      {children}
    </section>
  );
}

export type { CrmStatusResponse };
