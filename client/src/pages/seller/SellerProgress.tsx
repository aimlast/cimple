/**
 * SellerProgress — Progress dashboard for sellers.
 *
 * Route: /seller/:token/progress (rendered inside SellerLayout)
 * Token-aware: links use the token from the URL.
 */
import { useParams } from "wouter";
import { ProgressTracker } from "@/components/ProgressTracker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { MessageSquare, Upload } from "lucide-react";

export default function SellerProgress() {
  const { token } = useParams<{ token: string }>();

  const steps = [
    { id: "1", title: "Business Type Selection", status: "completed" as const },
    { id: "2", title: "Initial Questionnaire", status: "completed" as const },
    { id: "3", title: "AI Interview", status: "current" as const },
    { id: "4", title: "Document Upload", status: "pending" as const },
    { id: "5", title: "Review & Approval", status: "pending" as const },
  ];

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">My CIM Progress</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Track your progress in creating your business documentation
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Progress Overview</CardTitle>
          </CardHeader>
          <CardContent>
            <ProgressTracker steps={steps} />
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardContent className="p-6">
              <h3 className="font-semibold mb-2">Current Step: AI Interview</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Our AI assistant is gathering detailed information about your business.
                This helps create a comprehensive CIM.
              </p>
              <Link href={`/seller/${token}/interview`}>
                <Button className="w-full" data-testid="button-continue-interview">
                  <MessageSquare className="h-4 w-4 mr-2" />
                  Continue Interview
                </Button>
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <h3 className="font-semibold mb-2">Upload Documents</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Speed up the process by uploading existing business documents.
              </p>
              <Link href={`/seller/${token}/documents`}>
                <Button variant="outline" className="w-full" data-testid="button-upload-docs">
                  <Upload className="h-4 w-4 mr-2" />
                  Upload Documents
                </Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Overall Progress</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm">60% Complete</span>
              <span className="text-sm text-muted-foreground">Estimated 2 days remaining</span>
            </div>
            <div className="h-3 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: "60%" }} />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
