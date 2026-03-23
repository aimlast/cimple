import { useState } from "react";
import { AIConversationInterface } from "@/components/AIConversationInterface";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Lightbulb, CheckCircle } from "lucide-react";
import { useLocation, useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { ExtractedInfo, Cim, Deal } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export default function CIMInterview() {
  const [, setLocation] = useLocation();
  const [, cimParams] = useRoute("/cim/:id/interview");
  const [, dealParams] = useRoute("/deal/:id/interview");
  const [extractedInfo, setExtractedInfo] = useState<ExtractedInfo>({});
  const [isCompleting, setIsCompleting] = useState(false);
  const { toast } = useToast();

  // Check if this is a deal or CIM interview
  const isDeal = !!dealParams?.id;
  const entityId = dealParams?.id || cimParams?.id || localStorage.getItem("currentCimId");

  // Load data to get preliminary questionnaire data
  const { data: cim } = useQuery<Cim>({
    queryKey: ["/api/cims", entityId],
    enabled: !!entityId && !isDeal,
  });

  const { data: deal } = useQuery<Deal>({
    queryKey: ["/api/deals", entityId],
    enabled: !!entityId && isDeal,
  });

  const handleComplete = async () => {
    setIsCompleting(true);
    try {
      if (entityId) {
        if (isDeal) {
          await apiRequest("PATCH", `/api/deals/${entityId}`, {
            extractedInfo,
            interviewCompleted: true,
          });
          await queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
          await queryClient.invalidateQueries({ queryKey: ["/api/deals", entityId] });
          setLocation(`/deal/${entityId}`);
        } else {
          await apiRequest("PATCH", `/api/cims/${entityId}`, {
            extractedInfo,
            status: "completed",
          });
          await queryClient.invalidateQueries({ queryKey: ["/api/cims"] });
          setLocation(`/cim/${entityId}`);
        }
        
        console.log("Interview complete, captured info:", extractedInfo);
      } else {
        throw new Error("No ID found");
      }
    } catch (error: any) {
      console.error("Failed to save interview data:", error);
      toast({
        title: "Error",
        description: "Failed to save interview data. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsCompleting(false);
    }
  };

  const infoFields = [
    { key: "businessName", label: "Business Name" },
    { key: "industry", label: "Industry" },
    { key: "annualRevenue", label: "Annual Revenue" },
    { key: "revenueGrowth", label: "Revenue Growth" },
    { key: "employees", label: "Employees" },
    { key: "yearsOperating", label: "Years Operating" },
    { key: "locations", label: "Locations" },
    { key: "targetMarket", label: "Target Market" },
    { key: "competitiveAdvantage", label: "Competitive Advantage" },
    { key: "keyProducts", label: "Key Products/Services" },
    { key: "customerBase", label: "Customer Base" },
    { key: "marketingChannels", label: "Marketing Channels" },
    { key: "revenueStreams", label: "Revenue Streams" },
    { key: "operatingMargins", label: "Operating Margins" },
    { key: "assets", label: "Key Assets" },
    { key: "leaseDetails", label: "Lease Details" },
    { key: "suppliers", label: "Suppliers" },
    { key: "managementTeam", label: "Management Team" },
    { key: "reasonForSale", label: "Reason for Sale" },
  ];

  const capturedCount = Object.values(extractedInfo).filter(Boolean).length;
  const totalFields = infoFields.length;

  // Get preliminary data from deal or CIM questionnaire
  const preliminaryData = isDeal 
    ? (deal?.questionnaireData as Record<string, any> || {})
    : (cim?.questionnaireData as Record<string, any> || {});

  return (
    <div className="flex h-[calc(100vh-73px)]">
      <div className="flex-1 flex flex-col">
        <div className="flex-1 overflow-hidden">
          <AIConversationInterface 
            onInfoUpdate={setExtractedInfo} 
            preliminaryData={preliminaryData}
          />
        </div>
        <div className="border-t p-4 bg-card">
          <div className="max-w-3xl mx-auto flex justify-between items-center gap-4">
            <div className="text-sm text-muted-foreground">
              {capturedCount} of {totalFields} key fields captured
            </div>
            <Button onClick={handleComplete} disabled={isCompleting} data-testid="button-complete">
              <CheckCircle className="h-4 w-4 mr-2" />
              {isCompleting ? "Saving..." : "Complete Interview"}
            </Button>
          </div>
        </div>
      </div>

      <div className="w-80 border-l p-6 space-y-4 overflow-y-auto">
        <div>
          <h3 className="font-semibold mb-1">Information Captured</h3>
          <p className="text-xs text-muted-foreground">
            Updates automatically as you chat
          </p>
        </div>

        <div className="space-y-2">
          {infoFields.map((field) => {
            const value = extractedInfo[field.key as keyof ExtractedInfo];
            const hasValue = Boolean(value);
            
            // Convert value to string for rendering (handles objects, arrays, primitives)
            const displayValue = hasValue 
              ? typeof value === 'object' 
                ? JSON.stringify(value, null, 2) 
                : String(value)
              : "Not captured yet";
            
            return (
              <Card
                key={field.key}
                className={hasValue ? "p-3" : "p-3 opacity-40"}
              >
                <p className="text-xs font-medium mb-1">{field.label}</p>
                <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                  {displayValue}
                </p>
              </Card>
            );
          })}
        </div>

        <div className="pt-4 border-t">
          <div className="flex gap-2 mb-2">
            <Lightbulb className="h-4 w-4 text-primary" />
            <h4 className="text-sm font-semibold">Tips</h4>
          </div>
          <ul className="text-xs text-muted-foreground space-y-1">
            <li>• Be specific with numbers and metrics</li>
            <li>• Include growth trends when possible</li>
            <li>• Mention unique competitive advantages</li>
            <li>• The AI will guide you through everything</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
