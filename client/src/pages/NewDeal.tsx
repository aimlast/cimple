import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ArrowLeft, Globe } from "lucide-react";

const INDUSTRY_OPTIONS = [
  "Restaurant / Food Service",
  "Retail",
  "Manufacturing",
  "Professional Services",
  "Technology / SaaS",
  "Healthcare",
  "Construction",
  "Automotive",
  "Hospitality",
  "Real Estate",
  "Distribution / Wholesale",
  "E-commerce",
  "Other",
];

export default function NewDeal() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [businessName, setBusinessName] = useState("");
  const [industry, setIndustry] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [description, setDescription] = useState("");

  const createDealMutation = useMutation({
    mutationFn: async (data: { businessName: string; industry: string; websiteUrl?: string; description?: string }) => {
      const response = await apiRequest("POST", "/api/deals", {
        ...data,
        brokerId: "default-broker",
        phase: "phase1_info_collection",
        status: "draft",
      });
      return response.json();
    },
    onSuccess: (deal) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      toast({
        title: "Deal created",
        description: `${deal.businessName} has been added to your pipeline.`,
      });
      setLocation(`/deal/${deal.id}`);
    },
    onError: () => {
      toast({
        title: "Something went wrong",
        description: "Couldn't create the deal. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessName.trim() || !industry) {
      toast({
        title: "Required fields missing",
        description: "Please enter a business name and select an industry.",
        variant: "destructive",
      });
      return;
    }
    createDealMutation.mutate({
      businessName: businessName.trim(),
      industry,
      websiteUrl: websiteUrl.trim() || undefined,
      description: description.trim() || undefined,
    });
  };

  return (
    <div className="min-h-screen px-6 pt-6 pb-12">

      {/* Back */}
      <button
        onClick={() => setLocation("/")}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-8"
        data-testid="button-back"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to deals
      </button>

      <div className="max-w-md">

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">New Deal</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Enter the basics to open the deal. Everything else is collected during the AI interview.
          </p>
        </div>

        <form onSubmit={handleSubmit}>

          {/* ── Required fields ── */}
          <div className="space-y-4">

            <div className="space-y-1.5">
              <Label htmlFor="businessName" className="text-sm font-medium">
                Business Name
              </Label>
              <Input
                id="businessName"
                placeholder="e.g., Joe's Italian Restaurant"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                className="h-9 bg-card border-border"
                data-testid="input-business-name"
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="industry" className="text-sm font-medium">
                Industry
              </Label>
              <Select value={industry} onValueChange={setIndustry}>
                <SelectTrigger
                  id="industry"
                  className="h-9 bg-card border-border"
                  data-testid="select-industry"
                >
                  <SelectValue placeholder="Select an industry" />
                </SelectTrigger>
                <SelectContent>
                  {INDUSTRY_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* ── Divider ── */}
          <div className="my-6 flex items-center gap-3">
            <div className="flex-1 h-px bg-border" />
            <span className="text-2xs text-muted-foreground/50 uppercase tracking-widest font-medium">Optional</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          {/* ── Optional fields ── */}
          <div className="space-y-4">

            <div className="space-y-1.5">
              <Label htmlFor="websiteUrl" className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5" />
                Website
              </Label>
              <Input
                id="websiteUrl"
                placeholder="https://example.com"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                className="h-9 bg-card border-border"
                type="url"
                data-testid="input-website-url"
              />
              <p className="text-xs text-muted-foreground/60 leading-snug">
                If provided, the AI will scrape public information before the interview starts.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="description" className="text-sm font-medium text-muted-foreground">
                Notes
              </Label>
              <Textarea
                id="description"
                placeholder="Any initial notes about this deal, seller context, or deal circumstances..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="resize-none text-sm bg-card border-border"
                data-testid="input-description"
              />
            </div>
          </div>

          {/* ── Submit ── */}
          <div className="mt-8">
            <Button
              type="submit"
              className="w-full h-9 bg-teal text-teal-foreground hover:bg-teal/90 shadow-sm font-medium"
              disabled={createDealMutation.isPending}
              data-testid="button-create-deal"
            >
              {createDealMutation.isPending ? "Creating deal..." : "Create Deal"}
            </Button>
          </div>

        </form>
      </div>
    </div>
  );
}
