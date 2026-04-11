/**
 * SellerProfilePanel — AI-generated Seller Communication Profile.
 *
 * Displays the communication style, emotional state, and strategic insights
 * the AI has inferred about the seller. Brokers can view, correct, and
 * annotate the profile so the interview agent adapts accordingly.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Brain,
  RefreshCw,
  AlertTriangle,
  User,
  Heart,
  Clock,
  Shield,
  Loader2,
  Pencil,
  Check,
  X,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SellerCommunicationProfile {
  communicationStyle: string;
  emotionalState: string;
  sellingReason: string;
  sophistication: string;
  businessAttachment: string;
  timeOrientation: string;
  familyInvolvement: string;
  sensitiveTopics: string[];
  personalInsights: string[];
  sellerStory: string;
  industryContext: string;
  confidenceScore: number;
  dataSources: string[];
  generatedAt: string;
  brokerOverrides?: Record<string, any>;
}

interface SellerProfilePanelProps {
  dealId: string;
}

// ── Field option maps ─────────────────────────────────────────────────────────

const COMMUNICATION_STYLES = [
  "Direct",
  "Analytical",
  "Expressive",
  "Amiable",
  "Reserved",
  "Storyteller",
];

const EMOTIONAL_STATES = [
  "Confident",
  "Anxious",
  "Reluctant",
  "Eager",
  "Nostalgic",
  "Detached",
  "Overwhelmed",
  "Defensive",
];

const SOPHISTICATION_LEVELS = [
  "High",
  "Moderate",
  "Low",
  "Variable",
];

const ATTACHMENT_LEVELS = [
  "Very High",
  "High",
  "Moderate",
  "Low",
  "Detached",
];

const TIME_ORIENTATIONS = [
  "Urgent",
  "Flexible",
  "No Rush",
  "Deadline-Driven",
  "Hesitant",
];

const FAMILY_INVOLVEMENT = [
  "Primary Decision-Maker",
  "Spouse Involved",
  "Family Business — Multiple Stakeholders",
  "Partners Involved",
  "Solo Decision",
  "Unknown",
];

// ── Badge field config ────────────────────────────────────────────────────────

const BADGE_FIELDS = [
  {
    key: "communicationStyle" as const,
    label: "Style",
    icon: User,
    options: COMMUNICATION_STYLES,
  },
  {
    key: "emotionalState" as const,
    label: "Emotional State",
    icon: Heart,
    options: EMOTIONAL_STATES,
  },
  {
    key: "sophistication" as const,
    label: "Sophistication",
    icon: Shield,
    options: SOPHISTICATION_LEVELS,
  },
  {
    key: "businessAttachment" as const,
    label: "Attachment",
    icon: Heart,
    options: ATTACHMENT_LEVELS,
  },
  {
    key: "timeOrientation" as const,
    label: "Timing",
    icon: Clock,
    options: TIME_ORIENTATIONS,
  },
  {
    key: "familyInvolvement" as const,
    label: "Decision Makers",
    icon: User,
    options: FAMILY_INVOLVEMENT,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function confidenceLabel(score: number): string {
  if (score >= 0.8) return "High";
  if (score >= 0.5) return "Moderate";
  return "Low";
}

function confidenceColor(score: number): string {
  if (score >= 0.8) return "text-emerald-400";
  if (score >= 0.5) return "text-amber-400";
  return "text-red-400";
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SellerProfilePanel({ dealId }: SellerProfilePanelProps) {
  const { toast } = useToast();
  const [editingField, setEditingField] = useState<string | null>(null);
  const [brokerNotes, setBrokerNotes] = useState<string>("");
  const [notesLoaded, setNotesLoaded] = useState(false);

  // Fetch the profile
  const {
    data: profile,
    isLoading,
    error,
  } = useQuery<SellerCommunicationProfile | null>({
    queryKey: ["/api/deals", dealId, "seller-profile"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/seller-profile`, {
        credentials: "include",
      });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("Failed to load seller profile");
      return r.json();
    },
  });

  // Seed broker notes from profile on first load
  if (profile && !notesLoaded) {
    setBrokerNotes(
      (profile.brokerOverrides?.brokerNotes as string) || ""
    );
    setNotesLoaded(true);
  }

  // Generate profile
  const generate = useMutation({
    mutationFn: async () => {
      const r = await apiRequest(
        "POST",
        `/api/deals/${dealId}/seller-profile/generate`
      );
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/deals", dealId, "seller-profile"],
      });
      setNotesLoaded(false);
      toast({
        title: "Profile generated",
        description:
          "The seller communication profile has been created from available data.",
      });
    },
    onError: (e: Error) =>
      toast({
        title: "Generation failed",
        description: e.message,
        variant: "destructive",
      }),
  });

  // Patch profile (field edits + broker notes)
  const patch = useMutation({
    mutationFn: async (updates: Record<string, any>) => {
      const r = await apiRequest(
        "PATCH",
        `/api/deals/${dealId}/seller-profile`,
        updates
      );
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/deals", dealId, "seller-profile"],
      });
      setEditingField(null);
      toast({ title: "Profile updated" });
    },
    onError: (e: Error) =>
      toast({
        title: "Update failed",
        description: e.message,
        variant: "destructive",
      }),
  });

  // ── Empty state: no profile yet ───────────────────────────────────────────

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">
            Loading seller profile...
          </span>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <AlertTriangle className="h-5 w-5 text-red-400 mr-2" />
          <span className="text-sm text-muted-foreground">
            Failed to load seller profile.
          </span>
        </CardContent>
      </Card>
    );
  }

  if (!profile) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Brain className="h-4 w-4 text-teal" />
            Seller Communication Profile
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center text-center py-6 gap-4">
            <div className="rounded-full bg-muted p-3">
              <User className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground mb-1">
                No profile generated yet.
              </p>
              <p className="text-xs text-muted-foreground/70">
                The AI will analyze interview sessions, uploaded documents, and
                scraped data to build a communication profile for this seller.
              </p>
            </div>
            <Button
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
              className="bg-teal hover:bg-teal/90 text-white"
            >
              {generate.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Brain className="h-4 w-4 mr-2" />
              )}
              Generate Seller Profile
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ── Profile view ──────────────────────────────────────────────────────────

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Brain className="h-4 w-4 text-teal" />
            Seller Communication Profile
          </CardTitle>
          <div className="flex items-center gap-3">
            {/* Confidence indicator */}
            <span
              className={`text-xs font-medium ${confidenceColor(profile.confidenceScore)}`}
            >
              {confidenceLabel(profile.confidenceScore)} confidence
            </span>
            {/* Regenerate */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
              className="text-muted-foreground hover:text-foreground h-8 px-2"
            >
              {generate.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              <span className="ml-1.5 text-xs">Regenerate</span>
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Generated {formatDate(profile.generatedAt)}
        </p>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* ── Key Badges ─────────────────────────────────────────────────── */}
        <div className="flex flex-wrap gap-2">
          {BADGE_FIELDS.map((field) => {
            const Icon = field.icon;
            const value =
              profile[field.key as keyof SellerCommunicationProfile] as string;
            const isEditing = editingField === field.key;

            if (isEditing) {
              return (
                <div
                  key={field.key}
                  className="inline-flex items-center gap-1.5"
                >
                  <Select
                    defaultValue={value}
                    onValueChange={(val) => {
                      patch.mutate({ [field.key]: val });
                    }}
                  >
                    <SelectTrigger className="h-7 text-xs w-auto min-w-[120px] bg-muted border-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {field.options.map((opt) => (
                        <SelectItem key={opt} value={opt}>
                          {opt}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <button
                    onClick={() => setEditingField(null)}
                    className="p-0.5 rounded hover:bg-muted text-muted-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            }

            return (
              <button
                key={field.key}
                onClick={() => setEditingField(field.key)}
                className="group inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/50 px-2.5 py-1 text-xs font-medium text-foreground/90 hover:border-teal/40 hover:bg-muted transition-colors"
                title={`${field.label} — click to edit`}
              >
                <Icon className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground/70">{field.label}:</span>
                <span>{value}</span>
                <Pencil className="h-2.5 w-2.5 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            );
          })}
        </div>

        {/* ── Selling Reason ──────────────────────────────────────────────── */}
        {profile.sellingReason && (
          <div className="text-xs">
            <span className="text-muted-foreground/70 font-medium">
              Reason for selling:
            </span>{" "}
            <span className="text-foreground/80">{profile.sellingReason}</span>
          </div>
        )}

        {/* ── Seller Story ───────────────────────────────────────────────── */}
        <div>
          <h4 className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wider mb-2">
            Seller Story
          </h4>
          <p className="text-sm text-foreground/85 leading-relaxed">
            {profile.sellerStory}
          </p>
        </div>

        {/* ── Industry Context ───────────────────────────────────────────── */}
        {profile.industryContext && (
          <div>
            <h4 className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wider mb-2">
              Industry Context
            </h4>
            <p className="text-sm text-foreground/85 leading-relaxed">
              {profile.industryContext}
            </p>
          </div>
        )}

        {/* ── Personal Insights ──────────────────────────────────────────── */}
        {profile.personalInsights.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wider mb-2">
              Personal Insights
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {profile.personalInsights.map((insight, i) => (
                <Badge
                  key={i}
                  variant="secondary"
                  className="bg-muted/60 text-foreground/75 border-0 text-xs font-normal"
                >
                  {insight}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* ── Sensitive Topics ───────────────────────────────────────────── */}
        {profile.sensitiveTopics.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-amber-400/80 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <AlertTriangle className="h-3 w-3" />
              Sensitive Topics
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {profile.sensitiveTopics.map((topic, i) => (
                <Badge
                  key={i}
                  variant="outline"
                  className="border-amber-500/30 bg-amber-500/5 text-amber-300 text-xs font-normal"
                >
                  {topic}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* ── Broker Notes ───────────────────────────────────────────────── */}
        <div>
          <h4 className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wider mb-2">
            Broker Notes
          </h4>
          <Textarea
            value={brokerNotes}
            onChange={(e) => setBrokerNotes(e.target.value)}
            placeholder="Add context, corrections, or notes about this seller's communication preferences..."
            className="min-h-[80px] text-sm bg-muted/30 border-border/50 resize-none focus:border-teal/40"
          />
          <div className="flex justify-end mt-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={
                patch.isPending ||
                brokerNotes ===
                  ((profile.brokerOverrides?.brokerNotes as string) || "")
              }
              onClick={() =>
                patch.mutate({
                  brokerOverrides: {
                    ...profile.brokerOverrides,
                    brokerNotes,
                  },
                })
              }
              className="text-xs h-7 px-3 text-teal hover:text-teal hover:bg-teal/10"
            >
              {patch.isPending ? (
                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
              ) : (
                <Check className="h-3 w-3 mr-1.5" />
              )}
              Save Notes
            </Button>
          </div>
        </div>

        {/* ── Data Sources ───────────────────────────────────────────────── */}
        {profile.dataSources.length > 0 && (
          <div className="pt-2 border-t border-border/30">
            <p className="text-[11px] text-muted-foreground/50">
              <span className="font-medium">Sources:</span>{" "}
              {profile.dataSources.join(" \u00B7 ")}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
