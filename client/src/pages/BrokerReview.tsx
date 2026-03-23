import { useState } from "react";
import { MissingInfoCard } from "@/components/MissingInfoCard";
import { EditCIMDialog } from "@/components/EditCIMDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, Eye, ArrowRight, ArrowLeft, Edit } from "lucide-react";
import { Link, useRoute, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { Cim } from "@shared/schema";

export default function BrokerReview() {
  const [, params] = useRoute("/cim/:id");
  const [, setLocation] = useLocation();
  const cimId = params?.id || "1";
  const [editDialogOpen, setEditDialogOpen] = useState(false);

  const { data: cim, isLoading } = useQuery<Cim>({
    queryKey: ["/api/cims", cimId],
    enabled: !!cimId,
  });

  const handleAuthorizeSkip = (field: string) => {
    console.log("Authorized skip for:", field);
  };

  const handleRetry = (field: string) => {
    console.log("Retry collection for:", field);
  };

  // Determine where user should continue based on CIM progress
  const getContinuePath = () => {
    if (!cim) return null;
    
    // If no questionnaire data, continue with questionnaire
    if (!cim.questionnaireData) {
      return "/cim/new-questionnaire";
    }
    
    // If questionnaire done but no extracted info, continue with documents/interview
    if (!cim.extractedInfo) {
      return "/cim/new-documents";
    }
    
    // If we have some extracted info but CIM is not completed, continue with interview
    if (cim.status !== "completed") {
      return `/cim/${cimId}/interview`;
    }
    
    return null; // CIM is complete
  };

  const continuePath = getContinuePath();
  const showContinueButton = continuePath && cim?.status !== "completed";

  const handleContinue = () => {
    if (!continuePath) return;
    
    // Set current CIM ID for the forms to use (for legacy /cim/new-* routes)
    localStorage.setItem("currentCimId", cimId);
    
    // Navigate to the appropriate step
    setLocation(continuePath);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center space-y-2">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
          <p className="text-sm text-muted-foreground">Loading CIM...</p>
        </div>
      </div>
    );
  }

  if (!cim) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center space-y-2">
          <p className="text-lg font-semibold">CIM Not Found</p>
          <p className="text-sm text-muted-foreground">
            The requested CIM could not be loaded.
          </p>
        </div>
      </div>
    );
  }

  const extractedInfo = cim.extractedInfo as any || {};
  
  // Calculate completion metrics
  const allFields = [
    "businessName", "industry", "annualRevenue", "revenueGrowth", "employees",
    "yearsOperating", "locations", "targetMarket", "competitiveAdvantage",
    "keyProducts", "customerBase", "marketingChannels", "revenueStreams",
    "operatingMargins", "assets", "leaseDetails", "suppliers",
    "managementTeam", "reasonForSale"
  ];
  
  const filledFields = allFields.filter(field => extractedInfo[field]).length;
  const completionPercentage = Math.round((filledFields / allFields.length) * 100);
  const missingCount = allFields.length - filledFields;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-4 mb-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLocation("/")}
          data-testid="button-back"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Dashboard
        </Button>
      </div>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Review CIM - {cim.businessName}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Review captured information and approve missing data points
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="outline"
            onClick={() => setEditDialogOpen(true)}
            data-testid="button-edit-cim"
          >
            <Edit className="h-4 w-4 mr-2" />
            Edit Details
          </Button>
          {showContinueButton && (
            <Button onClick={handleContinue} data-testid="button-continue">
              <ArrowRight className="h-4 w-4 mr-2" />
              Continue Creating CIM
            </Button>
          )}
          <Link href={`/cim/${cimId}/preview`}>
            <Button variant="outline" data-testid="button-preview">
              <Eye className="h-4 w-4 mr-2" />
              Preview CIM
            </Button>
          </Link>
          <Button data-testid="button-export">
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Completion Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm">{completionPercentage}% Complete</span>
              <span className="text-sm text-muted-foreground">
                {missingCount} {missingCount === 1 ? 'item needs' : 'items need'} attention
              </span>
            </div>
            <div className="h-3 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${completionPercentage}%` }} />
            </div>
          </div>
        </CardContent>
      </Card>

      <div>
        <h2 className="text-lg font-semibold mb-4">Missing Information</h2>
        {missingCount === 0 ? (
          <Card>
            <CardContent className="p-6 text-center">
              <p className="text-sm text-muted-foreground">
                All information has been captured! You can now preview or export the CIM.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {!extractedInfo.annualRevenue && (
              <MissingInfoCard
                field="Annual Revenue Breakdown"
                description="We need detailed revenue information by product line for the past 3 years. This helps buyers understand your revenue streams and growth patterns."
                status="review_needed"
                onAuthorizeSkip={() => handleAuthorizeSkip("Annual Revenue Breakdown")}
                onRetry={() => handleRetry("Annual Revenue Breakdown")}
              />
            )}
            {!extractedInfo.customerBase && (
              <MissingInfoCard
                field="Customer Retention Rate"
                description="Please provide customer retention metrics to demonstrate business stability and recurring revenue potential."
                status="ai_attempting"
              />
            )}
            {!extractedInfo.competitiveAdvantage && (
              <MissingInfoCard
                field="Competitive Advantages"
                description="What are your unique competitive advantages? Include proprietary technology, exclusive contracts, or market positioning."
                status="review_needed"
                onAuthorizeSkip={() => handleAuthorizeSkip("Competitive Advantages")}
                onRetry={() => handleRetry("Competitive Advantages")}
              />
            )}
          </div>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Captured Information Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="font-medium mb-1">Business Overview</p>
              <p className="text-muted-foreground">
                {extractedInfo.businessName && extractedInfo.industry ? "✓ Complete" : "⚠ Partial"}
              </p>
            </div>
            <div>
              <p className="font-medium mb-1">Financial Information</p>
              <p className="text-muted-foreground">
                {extractedInfo.annualRevenue && extractedInfo.operatingMargins ? "✓ Complete" : "⚠ Partial"}
              </p>
            </div>
            <div>
              <p className="font-medium mb-1">Operations</p>
              <p className="text-muted-foreground">
                {extractedInfo.employees && extractedInfo.locations ? "✓ Complete" : "⚠ Partial"}
              </p>
            </div>
            <div>
              <p className="font-medium mb-1">Market Analysis</p>
              <p className="text-muted-foreground">
                {extractedInfo.targetMarket && extractedInfo.competitiveAdvantage ? "✓ Complete" : "⚠ Partial"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {cim && (
        <EditCIMDialog
          cim={cim}
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
        />
      )}
    </div>
  );
}
