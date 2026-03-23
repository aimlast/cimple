import { useState } from "react";
import { EditCIMDialog } from "@/components/EditCIMDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download, Edit, FileText, ArrowLeft } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import type { Cim } from "@shared/schema";

export default function CIMPreview() {
  const params = useParams();
  const cimId = params.id;
  const [, setLocation] = useLocation();
  const [editDialogOpen, setEditDialogOpen] = useState(false);

  const { data: cim, isLoading, error } = useQuery<Cim>({
    queryKey: ["/api/cims", cimId],
    enabled: !!cimId,
  });

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

  if (error || !cim) {
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
  const questionnaireData = cim.questionnaireData as any || {};

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-4 mb-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLocation(`/cim/${cimId}`)}
          data-testid="button-back"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Review
        </Button>
      </div>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">CIM Preview - {cim.businessName}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Review the generated CIM document
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="outline"
            onClick={() => setEditDialogOpen(true)}
            data-testid="button-edit"
          >
            <Edit className="h-4 w-4 mr-2" />
            Edit Details
          </Button>
          <Button data-testid="button-download">
            <Download className="h-4 w-4 mr-2" />
            Download PDF
          </Button>
        </div>
      </div>

      <div className="grid lg:grid-cols-4 gap-6">
        <div className="lg:col-span-1 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Sections</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {[
                "Executive Summary",
                "Business Overview",
                "Financial Performance",
                "Operations",
                "Market Analysis",
                "Growth Opportunities",
                "Assets & Equipment",
                "Management Team",
              ].map((section) => (
                <button
                  key={section}
                  className="w-full text-left px-3 py-2 text-sm rounded-md hover-elevate"
                  data-testid={`nav-${section.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  {section}
                </button>
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-3 space-y-6">
          <Card>
            <CardContent className="p-8 space-y-6">
              <div className="text-center space-y-4">
                <div className="h-16 w-16 rounded-lg bg-primary/10 flex items-center justify-center mx-auto">
                  <FileText className="h-8 w-8 text-primary" />
                </div>
                <div>
                  <h2 className="text-3xl font-bold">{cim.businessName}</h2>
                  <p className="text-lg text-muted-foreground mt-2">
                    Confidential Information Memorandum
                  </p>
                </div>
                <div className="flex gap-2 justify-center flex-wrap">
                  <Badge>{cim.industry}</Badge>
                  {extractedInfo.yearsOperating && (
                    <Badge>{extractedInfo.yearsOperating} in operation</Badge>
                  )}
                </div>
              </div>

              <Separator />

              <div className="space-y-4">
                <h3 className="text-xl font-semibold">Executive Summary</h3>
                <p className="text-sm leading-relaxed">
                  {cim.description || "No description provided."}
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="text-xl font-semibold">Key Highlights</h3>
                <ul className="space-y-2 text-sm">
                  {extractedInfo.annualRevenue && (
                    <li className="flex items-start gap-2">
                      <span className="text-primary font-bold">•</span>
                      <span>
                        <strong>Annual Revenue:</strong> {extractedInfo.annualRevenue}
                        {extractedInfo.revenueGrowth && ` with ${extractedInfo.revenueGrowth} growth`}
                      </span>
                    </li>
                  )}
                  {extractedInfo.operatingMargins && (
                    <li className="flex items-start gap-2">
                      <span className="text-primary font-bold">•</span>
                      <span>
                        <strong>Profitability:</strong> {extractedInfo.operatingMargins}
                      </span>
                    </li>
                  )}
                  {(extractedInfo.employees || questionnaireData.employees) && (
                    <li className="flex items-start gap-2">
                      <span className="text-primary font-bold">•</span>
                      <span>
                        <strong>Team:</strong> {extractedInfo.employees || questionnaireData.employees} employees
                      </span>
                    </li>
                  )}
                  {(extractedInfo.locations || questionnaireData.locations) && (
                    <li className="flex items-start gap-2">
                      <span className="text-primary font-bold">•</span>
                      <span>
                        <strong>Locations:</strong> {extractedInfo.locations || questionnaireData.locations} location(s)
                      </span>
                    </li>
                  )}
                </ul>
              </div>

              <div className="space-y-4">
                <h3 className="text-xl font-semibold">Financial Overview</h3>
                <div className="grid md:grid-cols-3 gap-4">
                  <Card className="bg-muted/50">
                    <CardContent className="p-4">
                      <p className="text-xs text-muted-foreground mb-1">Revenue</p>
                      <p className="text-2xl font-bold">
                        {extractedInfo.annualRevenue || questionnaireData["annual-revenue"] || "N/A"}
                      </p>
                    </CardContent>
                  </Card>
                  <Card className="bg-muted/50">
                    <CardContent className="p-4">
                      <p className="text-xs text-muted-foreground mb-1">Growth</p>
                      <p className="text-2xl font-bold">
                        {extractedInfo.revenueGrowth || questionnaireData["revenue-growth"] || "N/A"}
                      </p>
                    </CardContent>
                  </Card>
                  <Card className="bg-muted/50">
                    <CardContent className="p-4">
                      <p className="text-xs text-muted-foreground mb-1">Employees</p>
                      <p className="text-2xl font-bold">
                        {extractedInfo.employees || questionnaireData.employees || "N/A"}
                      </p>
                    </CardContent>
                  </Card>
                </div>
              </div>

              {extractedInfo.competitiveAdvantage && (
                <div className="space-y-4">
                  <h3 className="text-xl font-semibold">Competitive Advantage</h3>
                  <p className="text-sm leading-relaxed">
                    {extractedInfo.competitiveAdvantage}
                  </p>
                </div>
              )}

              {extractedInfo.targetMarket && (
                <div className="space-y-4">
                  <h3 className="text-xl font-semibold">Target Market</h3>
                  <p className="text-sm leading-relaxed">
                    {extractedInfo.targetMarket}
                  </p>
                </div>
              )}

              {extractedInfo.keyProducts && (
                <div className="space-y-4">
                  <h3 className="text-xl font-semibold">Products & Services</h3>
                  <p className="text-sm leading-relaxed">
                    {extractedInfo.keyProducts}
                  </p>
                </div>
              )}

              {extractedInfo.reasonForSale && (
                <div className="space-y-4">
                  <h3 className="text-xl font-semibold">Reason for Sale</h3>
                  <p className="text-sm leading-relaxed">
                    {extractedInfo.reasonForSale}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

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
