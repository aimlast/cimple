import { DocumentUploadZone } from "@/components/DocumentUploadZone";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useLocation } from "wouter";

export default function CIMDocuments() {
  const [, setLocation] = useLocation();

  const handleContinue = () => {
    console.log("Moving to AI interview");
    setLocation("/broker/cim/new-interview");
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Upload Documents</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload existing documents to help pre-fill your CIM (optional)
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Document Upload</CardTitle>
        </CardHeader>
        <CardContent>
          <DocumentUploadZone />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Helpful Documents</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              <span>Financial statements (P&L, Balance Sheet, Cash Flow)</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              <span>Business plan or pitch deck</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              <span>Previous CIM or offering memorandum</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              <span>Tax returns and financial projections</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              <span>Marketing materials and customer data</span>
            </li>
          </ul>
        </CardContent>
      </Card>

      <div className="flex justify-between gap-2">
        <Button
          variant="outline"
          onClick={() => setLocation("/broker/cim/new-questionnaire")}
          data-testid="button-back"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <Button onClick={handleContinue} data-testid="button-continue">
          Continue to AI Interview
          <ArrowRight className="h-4 w-4 ml-2" />
        </Button>
      </div>
    </div>
  );
}
