/**
 * SellerDocuments — Document upload page for sellers.
 *
 * Route: /seller/:token/documents (rendered inside SellerLayout)
 */
import { DocumentUploadZone } from "@/components/DocumentUploadZone";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function SellerDocuments() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Upload Documents</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload existing business documents to help pre-fill your CIM
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
          <CardTitle>Recommended Documents</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              <span>Financial statements (P&L, Balance Sheet)</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              <span>Business plan or executive summary</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              <span>Customer contracts or agreements</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              <span>Marketing materials or presentations</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              <span>Previous CIM or offering memorandum</span>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
