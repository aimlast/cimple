import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ArrowLeft } from "lucide-react";

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
    mutationFn: async (data: { businessName: string; industry: string; description?: string }) => {
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
    <div className="p-6 max-w-lg mx-auto">

      {/* Back */}
      <button
        onClick={() => setLocation("/")}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
        data-testid="button-back"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </button>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">New Deal</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Start the CIM creation process for a new business.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-5">

            <div className="space-y-1.5">
              <Label htmlFor="businessName" className="text-sm">Business Name</Label>
              <Input
                id="businessName"
                placeholder="e.g., Joe's Italian Restaurant"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                className="h-9"
                data-testid="input-business-name"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="industry" className="text-sm">Industry</Label>
              <Select value={industry} onValueChange={setIndustry}>
                <SelectTrigger className="h-9" data-testid="select-industry">
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

            <div className="space-y-1.5">
              <Label htmlFor="websiteUrl" className="text-sm">
                Website <span className="text-muted-foreground font-normal">(optional — used for public data scrape)</span>
              </Label>
              <Input
                id="websiteUrl"
                placeholder="e.g., https://joes-restaurant.com"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                className="h-9"
                type="url"
                data-testid="input-website-url"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="description" className="text-sm">
                Notes <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Textarea
                id="description"
                placeholder="Any initial notes about this deal..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="resize-none text-sm"
                data-testid="input-description"
              />
            </div>

            <Button
              type="submit"
              className="w-full bg-amber text-amber-foreground hover:bg-amber/90"
              disabled={createDealMutation.isPending}
              data-testid="button-create-deal"
            >
              {createDealMutation.isPending ? "Creating..." : "Create Deal"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
