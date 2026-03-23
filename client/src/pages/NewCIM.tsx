import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowRight } from "lucide-react";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export default function NewCIM() {
  const [, setLocation] = useLocation();
  const cimId = localStorage.getItem("currentCimId") || "";
  
  const [businessName, setBusinessName] = useState(() => {
    if (!cimId) return "";
    const saved = localStorage.getItem(`cim_${cimId}_data`);
    return saved ? JSON.parse(saved).businessName || "" : "";
  });
  const [industry, setIndustry] = useState(() => {
    if (!cimId) return "";
    const saved = localStorage.getItem(`cim_${cimId}_data`);
    return saved ? JSON.parse(saved).industry || "" : "";
  });
  const [description, setDescription] = useState(() => {
    if (!cimId) return "";
    const saved = localStorage.getItem(`cim_${cimId}_data`);
    return saved ? JSON.parse(saved).description || "" : "";
  });
  const [isCreating, setIsCreating] = useState(false);
  const { toast } = useToast();

  // Save data to CIM-specific localStorage whenever it changes
  useEffect(() => {
    if (cimId) {
      localStorage.setItem(`cim_${cimId}_data`, JSON.stringify({
        businessName,
        industry,
        description,
      }));
    }
  }, [businessName, industry, description, cimId]);

  const handleCreate = async () => {
    setIsCreating(true);
    try {
      const response = await apiRequest("POST", "/api/cims", {
        businessName,
        industry,
        description,
        status: "draft",
      });

      const cim = await response.json();
      
      // Invalidate CIM cache so it appears on dashboard
      await queryClient.invalidateQueries({ queryKey: ["/api/cims"] });
      
      // Store CIM ID for use in subsequent pages
      localStorage.setItem("currentCimId", cim.id);
      localStorage.setItem("currentCimData", JSON.stringify({
        businessName,
        industry,
        description,
      }));
      
      console.log("Created CIM:", cim);
      setLocation("/cim/new-questionnaire");
    } catch (error: any) {
      console.error("Failed to create CIM:", error);
      toast({
        title: "Error",
        description: "Failed to create CIM. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Create New CIM</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Let's start with some basic information about the business
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Business Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="business-name">Business Name *</Label>
            <Input
              id="business-name"
              placeholder="Enter business name"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              data-testid="input-business-name"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="industry">Industry *</Label>
            <Select value={industry} onValueChange={setIndustry}>
              <SelectTrigger id="industry" data-testid="select-industry">
                <SelectValue placeholder="Select industry" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="advertising-media-events">Advertising/Media/Events</SelectItem>
                <SelectItem value="agriculture">Agriculture</SelectItem>
                <SelectItem value="automotive">Automotive</SelectItem>
                <SelectItem value="beauty-personal-care">Beauty/Personal Care</SelectItem>
                <SelectItem value="building-construction-property">Building/Construction and Property Management</SelectItem>
                <SelectItem value="childcare-entertainment">Childcare/Entertainment</SelectItem>
                <SelectItem value="education">Education</SelectItem>
                <SelectItem value="financial-services">Financial Services</SelectItem>
                <SelectItem value="franchises">Franchises</SelectItem>
                <SelectItem value="healthcare">Healthcare</SelectItem>
                <SelectItem value="home-services">Home Services</SelectItem>
                <SelectItem value="hotels-motels">Hotels/Motels</SelectItem>
                <SelectItem value="insurance">Insurance</SelectItem>
                <SelectItem value="legal-services">Legal Services</SelectItem>
                <SelectItem value="manufacturing">Manufacturing</SelectItem>
                <SelectItem value="marketing-advertising">Marketing/Advertising Agencies</SelectItem>
                <SelectItem value="online-business">Online Business</SelectItem>
                <SelectItem value="pet-services">Pet Services</SelectItem>
                <SelectItem value="printing-publishing">Printing/Publishing</SelectItem>
                <SelectItem value="professional-services">Professional Services Firms</SelectItem>
                <SelectItem value="real-estate">Real Estate</SelectItem>
                <SelectItem value="restaurants-food">Restaurants/Food</SelectItem>
                <SelectItem value="retail">Retail</SelectItem>
                <SelectItem value="security-services">Security Services</SelectItem>
                <SelectItem value="staffing-recruiting">Staffing/Recruiting</SelectItem>
                <SelectItem value="technology">Technology</SelectItem>
                <SelectItem value="tourism-travel">Tourism/Travel</SelectItem>
                <SelectItem value="transportation-logistics">Transportation/Logistics</SelectItem>
                <SelectItem value="wellness-fitness-lifestyle">Wellness, Fitness, and Lifestyle</SelectItem>
                <SelectItem value="wholesale-distribution">Wholesale/Distribution</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">What does this business do? *</Label>
            <Input
              id="description"
              placeholder="e.g., Italian restaurant serving families, B2B SaaS for construction, automotive parts manufacturing..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="input-description"
            />
            <p className="text-xs text-muted-foreground">
              Just one sentence - the AI will ask detailed questions in the interview
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => setLocation("/")}
          data-testid="button-cancel"
        >
          Cancel
        </Button>
        <Button
          onClick={handleCreate}
          disabled={!businessName || !industry || isCreating}
          data-testid="button-continue"
        >
          {isCreating ? "Creating..." : "Continue"}
          <ArrowRight className="h-4 w-4 ml-2" />
        </Button>
      </div>
    </div>
  );
}
