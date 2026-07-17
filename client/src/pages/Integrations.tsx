import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import {
  Mail, Database, Phone, Video, ArrowRight,
  CheckCircle2, Circle, ExternalLink, Plug, X, Plus, Trash2,
  FileText, Loader2,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type IntegrationStatus = "connected" | "disconnected" | "coming_soon" | "available";

interface IntegrationCard {
  id: string;
  provider: string;
  name: string;
  description: string;
  icon: React.ElementType;
  category: "email" | "crm" | "calls";
  status: IntegrationStatus;
  connectedId?: string;
  /** Short honest note rendered under a disabled Coming Soon button */
  comingSoonNote?: string;
  /** When set, the card is a working feature link instead of a connectable provider */
  link?: { href: string; label: string };
}

const INTEGRATION_CATALOG: Omit<IntegrationCard, "status" | "connectedId">[] = [
  {
    id: "gmail",
    provider: "gmail",
    name: "Gmail",
    description: "Read email threads between you and sellers to pre-populate the knowledge base before the AI interview.",
    icon: Mail,
    category: "email",
    comingSoonNote: "Available soon — email sync is in development.",
  },
  {
    id: "outlook",
    provider: "outlook",
    name: "Outlook",
    description: "Connect your Outlook account to automatically pull in seller communication history.",
    icon: Mail,
    category: "email",
    comingSoonNote: "Available soon — email sync is in development.",
  },
  {
    id: "pipedrive",
    provider: "pipedrive",
    name: "Pipedrive",
    description: "Sync deal stages and prefill buyer submissions from your Pipedrive contacts. Works today with your API token.",
    icon: Database,
    category: "crm",
  },
  {
    id: "salesforce",
    provider: "salesforce",
    name: "Salesforce",
    description: "Import deal notes, contact info, and activity history directly from your Salesforce CRM.",
    icon: Database,
    category: "crm",
  },
  {
    id: "hubspot",
    provider: "hubspot",
    name: "HubSpot",
    description: "Pull deal records, contact notes, and communication logs from HubSpot into the knowledge base.",
    icon: Database,
    category: "crm",
  },
  {
    id: "call-transcripts",
    provider: "call_transcripts",
    name: "Call Transcripts",
    description: "Works today — upload or paste call transcripts on any deal's Overview tab; the AI extracts key facts into the deal profile.",
    icon: FileText,
    category: "calls",
    link: { href: "/broker/deals", label: "Go to deals" },
  },
  {
    id: "zoom",
    provider: "zoom",
    name: "Zoom",
    description: "Import call recordings and transcripts from your Zoom meetings with sellers.",
    icon: Video,
    category: "calls",
  },
  {
    id: "otter",
    provider: "otter",
    name: "Otter.ai",
    description: "Pull transcripts from recorded calls and meetings to feed into the interview knowledge base.",
    icon: Phone,
    category: "calls",
  },
  {
    id: "fireflies",
    provider: "fireflies",
    name: "Fireflies.ai",
    description: "Import AI-generated meeting notes and transcripts from Fireflies.",
    icon: Phone,
    category: "calls",
  },
];

const CATEGORY_INFO = {
  email: {
    title: "Email",
    description: "Connect your email to automatically read seller communications. The AI uses these to pre-build the knowledge base before the interview — so sellers don't repeat what they've already told you.",
    icon: Mail,
  },
  crm: {
    title: "CRM",
    description: "Connect your CRM to pull in deal notes, contact info, and activity history. Every note you've already written becomes context for the AI.",
    icon: Database,
  },
  calls: {
    title: "Call Recordings",
    description: "Connect call recording and transcription tools to import transcripts from seller conversations. Every call becomes structured knowledge.",
    icon: Phone,
  },
};

function StatusBadge({ status }: { status: IntegrationStatus }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium bg-success-muted text-success-muted-foreground">
        <CheckCircle2 className="h-3 w-3" /> Connected
      </span>
    );
  }
  if (status === "coming_soon") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium bg-muted text-muted-foreground">
        Coming Soon
      </span>
    );
  }
  if (status === "available") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium bg-teal-muted text-teal-muted-foreground">
        <CheckCircle2 className="h-3 w-3" /> Works Today
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium bg-muted text-muted-foreground">
      <Circle className="h-3 w-3" /> Not Connected
    </span>
  );
}

function IntegrationCardComponent({
  card,
  onConnect,
}: {
  card: IntegrationCard;
  onConnect: (provider: string) => void;
}) {
  const Icon = card.icon;
  const [, navigate] = useLocation();
  const isComingSoon = card.status === "coming_soon";
  const isConnected = card.status === "connected";
  const isFeatureLink = card.status === "available" && !!card.link;

  return (
    <div
      className={`relative rounded-xl border p-5 transition-all ${
        isComingSoon
          ? "border-card-border bg-card/60 opacity-70"
          : isConnected
          ? "border-success/30 bg-success-muted/40"
          : "border-card-border bg-card hover:border-teal/40"
      }`}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div
            className={`h-10 w-10 rounded-lg flex items-center justify-center ${
              isConnected
                ? "bg-success-muted text-success-muted-foreground"
                : isFeatureLink
                ? "bg-teal-muted text-teal-muted-foreground"
                : "bg-muted text-muted-foreground"
            }`}
          >
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <h3 className="font-semibold text-sm text-foreground">{card.name}</h3>
            <StatusBadge status={card.status} />
          </div>
        </div>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed mb-4">{card.description}</p>

      {isComingSoon ? (
        <>
          <button
            disabled
            className="w-full py-2 px-3 rounded-lg text-xs font-medium bg-muted text-muted-foreground/70 cursor-not-allowed"
          >
            Coming Soon
          </button>
          {card.comingSoonNote && (
            <p className="text-2xs text-muted-foreground/70 text-center mt-2">{card.comingSoonNote}</p>
          )}
        </>
      ) : isFeatureLink ? (
        <button
          onClick={() => navigate(card.link!.href)}
          className="w-full py-2 px-3 rounded-lg text-xs font-medium bg-teal text-teal-foreground hover:bg-teal/90 transition-colors flex items-center justify-center gap-1.5"
        >
          {card.link!.label} <ArrowRight className="h-3.5 w-3.5" />
        </button>
      ) : isConnected ? (
        <button
          onClick={() => onConnect(card.provider)}
          className="w-full py-2 px-3 rounded-lg text-xs font-medium bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
        >
          Disconnect
        </button>
      ) : (
        <button
          onClick={() => onConnect(card.provider)}
          className="w-full py-2 px-3 rounded-lg text-xs font-medium bg-teal text-teal-foreground hover:bg-teal/90 transition-colors flex items-center justify-center gap-1.5"
        >
          Connect <ArrowRight className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export default function Integrations() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [activeCategory, setActiveCategory] = useState<"all" | "email" | "crm" | "calls">("all");

  const { data: connectedIntegrations = [] } = useQuery<any[]>({
    queryKey: ["/api/integrations"],
    queryFn: async () => {
      try {
        const res = await fetch("/api/integrations");
        if (!res.ok) return [];
        return res.json();
      } catch {
        return [];
      }
    },
  });

  const connectedProviders = new Set(
    connectedIntegrations
      .filter((i: any) => i.status === "connected")
      .map((i: any) => i.provider)
  );

  // Pipedrive connect dialog state
  const [pipedriveOpen, setPipedriveOpen] = useState(false);
  const [pipedriveToken, setPipedriveToken] = useState("");
  const [pipedriveError, setPipedriveError] = useState<string | null>(null);

  const connectPipedrive = useMutation({
    mutationFn: async (apiToken: string) => {
      const res = await fetch("/api/integrations/pipedrive/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ apiToken }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Could not connect to Pipedrive. Check the token and try again.");
      }
      return body;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/integrations"] });
      setPipedriveOpen(false);
      setPipedriveToken("");
      setPipedriveError(null);
      toast({
        title: "Pipedrive connected",
        description: "Deal stages will sync and buyer submissions can now prefill from your Pipedrive contacts.",
      });
    },
    onError: (err) => {
      // Keep the dialog open and surface the error inline
      setPipedriveError(err instanceof Error ? err.message : "Could not connect to Pipedrive.");
    },
  });

  // Providers that are genuinely not connectable yet. Gmail/Outlook stay here
  // until OAuth credentials exist — a live Connect button that always 501s
  // reads as a dead click, so they get the honest Coming Soon treatment.
  const COMING_SOON = ["gmail", "outlook", "salesforce", "hubspot", "zoom", "otter", "fireflies"];

  // Merge catalog with connected status
  const cards: IntegrationCard[] = INTEGRATION_CATALOG.map((c) => {
    const connected = connectedIntegrations.find((i: any) => i.provider === c.provider && i.status === "connected");
    const status: IntegrationStatus = connected
      ? "connected"
      : c.link
      ? "available"
      : COMING_SOON.includes(c.provider)
      ? "coming_soon"
      : "disconnected";
    return { ...c, status, connectedId: connected?.id };
  });

  const filteredCards = activeCategory === "all" ? cards : cards.filter((c) => c.category === activeCategory);

  const handleConnect = async (provider: string) => {
    const existing = connectedIntegrations.find((i: any) => i.provider === provider && i.status === "connected");
    if (existing) {
      // Disconnect
      await fetch(`/api/integrations/${existing.id}`, { method: "DELETE" });
      queryClient.invalidateQueries({ queryKey: ["/api/integrations"] });
      return;
    }
    // Pipedrive connects via an API token dialog — no OAuth round-trip needed.
    if (provider === "pipedrive") {
      setPipedriveToken("");
      setPipedriveError(null);
      setPipedriveOpen(true);
      return;
    }
    // No other provider is connectable yet. The old GET /api/auth/:provider
    // path was removed — it always returned 501 (OAuth secrets not
    // configured), so those cards now render as disabled Coming Soon instead.
  };

  const categories = [
    { key: "all" as const, label: "All" },
    { key: "email" as const, label: "Email", icon: Mail },
    { key: "crm" as const, label: "CRM", icon: Database },
    { key: "calls" as const, label: "Calls", icon: Phone },
  ];

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="h-9 w-9 rounded-lg bg-teal-muted flex items-center justify-center">
              <Plug className="h-5 w-5 text-teal-muted-foreground" />
            </div>
            <h1 className="text-2xl font-bold text-foreground tracking-tight">Integrations</h1>
          </div>
          <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
            Connect your email, CRM, and call recording tools to automatically feed existing communications
            and notes into the AI. The more context the AI has before the seller interview, the
            less the seller needs to repeat — and the better the CIM.
          </p>
        </div>

        {/* Stats bar */}
        <div className="flex items-center gap-6 mb-6 pb-6 border-b border-border">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-success" />
            <span className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">{connectedProviders.size}</span> connected
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Circle className="h-4 w-4 text-muted-foreground/40" />
            <span className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">{INTEGRATION_CATALOG.length - connectedProviders.size}</span> available
            </span>
          </div>
        </div>

        {/* Category tabs */}
        <div className="flex items-center gap-1 mb-6">
          {categories.map(({ key, label, icon: CatIcon }) => (
            <button
              key={key}
              onClick={() => setActiveCategory(key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                activeCategory === key
                  ? "bg-teal-muted text-teal-muted-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              {CatIcon && <CatIcon className="h-3.5 w-3.5" />}
              {label}
            </button>
          ))}
        </div>

        {/* Category description (when filtered) */}
        {activeCategory !== "all" && (
          <div className="mb-6 p-4 rounded-lg bg-card border border-card-border">
            <div className="flex items-center gap-2 mb-1">
              {(() => {
                const CatIcon = CATEGORY_INFO[activeCategory].icon;
                return <CatIcon className="h-4 w-4 text-teal" />;
              })()}
              <h2 className="text-sm font-semibold text-foreground">
                {CATEGORY_INFO[activeCategory].title}
              </h2>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {CATEGORY_INFO[activeCategory].description}
            </p>
          </div>
        )}

        {/* Integration cards grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredCards.map((card) => (
            <IntegrationCardComponent
              key={card.id}
              card={card}
              onConnect={handleConnect}
            />
          ))}
        </div>

        {/* How it works section */}
        <div className="mt-12 p-6 rounded-xl bg-card border border-card-border">
          <h2 className="text-sm font-semibold text-foreground mb-4">How integrations work</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <div className="h-8 w-8 rounded-full bg-teal/10 text-teal flex items-center justify-center text-sm font-bold mb-2">
                1
              </div>
              <h3 className="text-xs font-semibold text-foreground mb-1">Connect your tools</h3>
              <p className="text-2xs text-muted-foreground leading-relaxed">
                Securely authorize Cimple to read (never write) data from your connected accounts.
              </p>
            </div>
            <div>
              <div className="h-8 w-8 rounded-full bg-teal/10 text-teal flex items-center justify-center text-sm font-bold mb-2">
                2
              </div>
              <h3 className="text-xs font-semibold text-foreground mb-1">Specify what to read</h3>
              <p className="text-2xs text-muted-foreground leading-relaxed">
                For each deal, tell us which email addresses, CRM records, or call recordings to pull in.
              </p>
            </div>
            <div>
              <div className="h-8 w-8 rounded-full bg-teal/10 text-teal flex items-center justify-center text-sm font-bold mb-2">
                3
              </div>
              <h3 className="text-xs font-semibold text-foreground mb-1">AI builds the knowledge base</h3>
              <p className="text-2xs text-muted-foreground leading-relaxed">
                The AI reads everything and pre-populates the seller's profile. The interview starts smarter — less repetition, better questions.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Pipedrive connect dialog */}
      <Dialog
        open={pipedriveOpen}
        onOpenChange={(open) => {
          setPipedriveOpen(open);
          if (!open) {
            setPipedriveToken("");
            setPipedriveError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="h-4 w-4 text-teal" /> Connect Pipedrive
            </DialogTitle>
            <DialogDescription>
              Paste your Pipedrive API token — find it in Pipedrive under
              Settings &rarr; Personal preferences &rarr; API.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!pipedriveToken.trim() || connectPipedrive.isPending) return;
              setPipedriveError(null);
              connectPipedrive.mutate(pipedriveToken.trim());
            }}
            className="space-y-3"
          >
            <Input
              type="password"
              autoComplete="off"
              placeholder="Pipedrive API token"
              value={pipedriveToken}
              onChange={(e) => {
                setPipedriveToken(e.target.value);
                if (pipedriveError) setPipedriveError(null);
              }}
              autoFocus
            />
            {pipedriveError && (
              <p className="text-xs text-destructive leading-relaxed" role="alert">
                {pipedriveError}
              </p>
            )}
            <p className="text-2xs text-muted-foreground leading-relaxed">
              The token is stored securely and only used to sync deal stages and
              prefill buyer submissions. You can disconnect at any time.
            </p>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => setPipedriveOpen(false)}
                disabled={connectPipedrive.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="bg-teal text-teal-foreground hover:bg-teal/90"
                disabled={!pipedriveToken.trim() || connectPipedrive.isPending}
              >
                {connectPipedrive.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> Connecting…
                  </>
                ) : (
                  "Connect"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
