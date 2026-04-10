import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Mail, Database, Phone, Video, ArrowRight,
  CheckCircle2, Circle, ExternalLink, Plug, X, Plus, Trash2,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

type IntegrationStatus = "connected" | "disconnected" | "coming_soon";

interface IntegrationCard {
  id: string;
  provider: string;
  name: string;
  description: string;
  icon: React.ElementType;
  category: "email" | "crm" | "calls";
  status: IntegrationStatus;
  connectedId?: string;
}

const INTEGRATION_CATALOG: Omit<IntegrationCard, "status" | "connectedId">[] = [
  {
    id: "gmail",
    provider: "gmail",
    name: "Gmail",
    description: "Read email threads between you and sellers to pre-populate the knowledge base before the AI interview.",
    icon: Mail,
    category: "email",
  },
  {
    id: "outlook",
    provider: "outlook",
    name: "Outlook",
    description: "Connect your Outlook account to automatically pull in seller communication history.",
    icon: Mail,
    category: "email",
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
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium bg-emerald-500/10 text-emerald-600">
        <CheckCircle2 className="h-3 w-3" /> Connected
      </span>
    );
  }
  if (status === "coming_soon") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium bg-amber-500/10 text-amber-600">
        Coming Soon
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium bg-neutral-100 text-neutral-500">
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
  const isComingSoon = card.status === "coming_soon";
  const isConnected = card.status === "connected";

  return (
    <div
      className={`relative rounded-xl border p-5 transition-all ${
        isComingSoon
          ? "border-neutral-200 bg-neutral-50/50 opacity-70"
          : isConnected
          ? "border-emerald-200 bg-emerald-50/30"
          : "border-neutral-200 bg-white hover:border-teal/40 hover:shadow-sm"
      }`}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div
            className={`h-10 w-10 rounded-lg flex items-center justify-center ${
              isConnected
                ? "bg-emerald-100 text-emerald-600"
                : "bg-neutral-100 text-neutral-500"
            }`}
          >
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <h3 className="font-semibold text-sm text-neutral-900">{card.name}</h3>
            <StatusBadge status={card.status} />
          </div>
        </div>
      </div>

      <p className="text-xs text-neutral-500 leading-relaxed mb-4">{card.description}</p>

      {isComingSoon ? (
        <button
          disabled
          className="w-full py-2 px-3 rounded-lg text-xs font-medium bg-neutral-100 text-neutral-400 cursor-not-allowed"
        >
          Coming Soon
        </button>
      ) : isConnected ? (
        <button
          onClick={() => onConnect(card.provider)}
          className="w-full py-2 px-3 rounded-lg text-xs font-medium bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
        >
          Disconnect
        </button>
      ) : (
        <button
          onClick={() => onConnect(card.provider)}
          className="w-full py-2 px-3 rounded-lg text-xs font-medium bg-teal text-white hover:bg-teal/90 transition-colors flex items-center justify-center gap-1.5"
        >
          Connect <ArrowRight className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export default function Integrations() {
  const queryClient = useQueryClient();
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

  // Merge catalog with connected status
  const cards: IntegrationCard[] = INTEGRATION_CATALOG.map((c) => {
    const connected = connectedIntegrations.find((i: any) => i.provider === c.provider && i.status === "connected");
    const comingSoon = ["salesforce", "hubspot", "zoom", "otter", "fireflies"].includes(c.provider);
    return {
      ...c,
      status: connected ? "connected" as const : comingSoon ? "coming_soon" as const : "disconnected" as const,
      connectedId: connected?.id,
    };
  });

  const filteredCards = activeCategory === "all" ? cards : cards.filter((c) => c.category === activeCategory);

  const handleConnect = async (provider: string) => {
    const existing = connectedIntegrations.find((i: any) => i.provider === provider && i.status === "connected");
    if (existing) {
      // Disconnect
      await fetch(`/api/integrations/${existing.id}`, { method: "DELETE" });
      queryClient.invalidateQueries({ queryKey: ["/api/integrations"] });
    } else {
      // Start OAuth flow
      window.location.href = `/api/auth/${provider}`;
    }
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
            <div className="h-9 w-9 rounded-lg bg-teal/10 flex items-center justify-center">
              <Plug className="h-5 w-5 text-teal" />
            </div>
            <h1 className="text-2xl font-bold text-neutral-900 tracking-tight">Integrations</h1>
          </div>
          <p className="text-sm text-neutral-500 max-w-2xl leading-relaxed">
            Connect your email, CRM, and call recording tools to automatically feed existing communications
            and notes into the AI. The more context the AI has before the seller interview, the
            less the seller needs to repeat — and the better the CIM.
          </p>
        </div>

        {/* Stats bar */}
        <div className="flex items-center gap-6 mb-6 pb-6 border-b border-neutral-200">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            <span className="text-sm text-neutral-600">
              <span className="font-semibold text-neutral-900">{connectedProviders.size}</span> connected
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Circle className="h-4 w-4 text-neutral-300" />
            <span className="text-sm text-neutral-600">
              <span className="font-semibold text-neutral-900">{INTEGRATION_CATALOG.length - connectedProviders.size}</span> available
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
                  ? "bg-teal/10 text-teal"
                  : "text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100"
              }`}
            >
              {CatIcon && <CatIcon className="h-3.5 w-3.5" />}
              {label}
            </button>
          ))}
        </div>

        {/* Category description (when filtered) */}
        {activeCategory !== "all" && (
          <div className="mb-6 p-4 rounded-lg bg-neutral-50 border border-neutral-100">
            <div className="flex items-center gap-2 mb-1">
              {(() => {
                const CatIcon = CATEGORY_INFO[activeCategory].icon;
                return <CatIcon className="h-4 w-4 text-teal" />;
              })()}
              <h2 className="text-sm font-semibold text-neutral-900">
                {CATEGORY_INFO[activeCategory].title}
              </h2>
            </div>
            <p className="text-xs text-neutral-500 leading-relaxed">
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
        <div className="mt-12 p-6 rounded-xl bg-neutral-50 border border-neutral-100">
          <h2 className="text-sm font-semibold text-neutral-900 mb-4">How integrations work</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <div className="h-8 w-8 rounded-full bg-teal/10 text-teal flex items-center justify-center text-sm font-bold mb-2">
                1
              </div>
              <h3 className="text-xs font-semibold text-neutral-800 mb-1">Connect your tools</h3>
              <p className="text-2xs text-neutral-500 leading-relaxed">
                Securely authorize Cimple to read (never write) data from your connected accounts.
              </p>
            </div>
            <div>
              <div className="h-8 w-8 rounded-full bg-teal/10 text-teal flex items-center justify-center text-sm font-bold mb-2">
                2
              </div>
              <h3 className="text-xs font-semibold text-neutral-800 mb-1">Specify what to read</h3>
              <p className="text-2xs text-neutral-500 leading-relaxed">
                For each deal, tell us which email addresses, CRM records, or call recordings to pull in.
              </p>
            </div>
            <div>
              <div className="h-8 w-8 rounded-full bg-teal/10 text-teal flex items-center justify-center text-sm font-bold mb-2">
                3
              </div>
              <h3 className="text-xs font-semibold text-neutral-800 mb-1">AI builds the knowledge base</h3>
              <p className="text-2xs text-neutral-500 leading-relaxed">
                The AI reads everything and pre-populates the seller's profile. The interview starts smarter — less repetition, better questions.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
