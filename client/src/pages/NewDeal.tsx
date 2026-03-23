import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ArrowLeft, Building, Briefcase } from "lucide-react";

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
        title: "Deal Created",
        description: `${deal.businessName} has been added to your pipeline.`,
      });
      setLocation(`/deal/${deal.id}`);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: "Failed to create deal. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!businessName.trim() || !industry) {
      toast({
        title: "Missing Information",
        description: "Please enter a business name and select an industry.",
        variant: "destructive",
      });
      return;
    }
    
    createDealMutation.mutate({
      businessName: businessName.trim(),
      industry,
      description: description.trim() || undefined,
    });
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <Button
        variant="ghost"
        className="mb-6"
        onClick={() => setLocation("/")}
        data-testid="button-back"
      >
        <ArrowLeft className="h-4 w-4 mr-2" />
        Back to Dashboard
      </Button>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Briefcase className="h-5 w-5" />
            New Deal
          </CardTitle>
          <CardDescription>
            Start the CIM creation process for a new business
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="businessName">Business Name</Label>
              <div className="relative">
                <Building className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="businessName"
                  placeholder="e.g., Joe's Italian Restaurant"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  className="pl-10"
                  data-testid="input-business-name"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="industry">Industry</Label>
              <Select value={industry} onValueChange={setIndustry}>
                <SelectTrigger data-testid="select-industry">
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

            <div className="space-y-2">
              <Label htmlFor="description">Brief Description (Optional)</Label>
              <Textarea
                id="description"
                placeholder="Any initial notes about this business..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                data-testid="input-description"
              />
            </div>

            <div className="pt-4">
              <Button
                type="submit"
                className="w-full"
                disabled={createDealMutation.isPending}
                data-testid="button-create-deal"
              >
                {createDealMutation.isPending ? "Creating..." : "Create Deal"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
