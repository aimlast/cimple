import { useState } from "react";
import { useRoute, useLocation, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Deal, Task, Document as DocType } from "@shared/schema";
import { 
  ArrowLeft, 
  Building, 
  FileText, 
  MessageSquare, 
  CheckCircle, 
  Clock,
  Users,
  Upload,
  Send,
  Eye,
  Edit,
  ChevronRight,
  AlertCircle,
  Trash2,
  FolderOpen,
  DollarSign,
  Scale,
  Megaphone,
  Wrench,
  FileSignature,
  ClipboardList,
  Calculator,
  Mail,
  ExternalLink,
  Copy,
  Palette
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";

const DOCUMENT_CATEGORIES = [
  { value: "financials", label: "Financials", icon: DollarSign, description: "P&L, Balance Sheets, Tax Returns" },
  { value: "legal", label: "Legal", icon: Scale, description: "Contracts, Licenses, Agreements" },
  { value: "marketing", label: "Marketing", icon: Megaphone, description: "Branding, Marketing Materials" },
  { value: "operations", label: "Operations", icon: Wrench, description: "SOPs, Manuals, Processes" },
  { value: "other", label: "Other", icon: FolderOpen, description: "Miscellaneous Documents" },
];

const PHASES = [
  { key: "phase1_info_collection", label: "Phase 1", description: "Info Collection", icon: FileText },
  { key: "phase2_platform_intake", label: "Phase 2", description: "Platform Intake", icon: MessageSquare },
  { key: "phase3_content_creation", label: "Phase 3", description: "Content Creation", icon: Edit },
  { key: "phase4_design_finalization", label: "Phase 4", description: "Design & Final", icon: Eye },
];

function getPhaseProgress(deal: Deal): number {
  const phaseIndex = PHASES.findIndex(p => p.key === deal.phase);
  if (phaseIndex === -1) return 0;
  
  let progress = (phaseIndex) * 25;
  
  if (deal.phase === "phase1_info_collection") {
    let phase1Progress = 0;
    if (deal.ndaSigned) phase1Progress += 33;
    if (deal.sqCompleted) phase1Progress += 34;
    if (deal.valuationCompleted) phase1Progress += 33;
    progress += (phase1Progress / 100) * 25;
  } else if (deal.phase === "phase2_platform_intake") {
    let phase2Progress = 0;
    if (deal.questionnaireData) phase2Progress += 33;
    if (deal.interviewCompleted) phase2Progress += 67;
    progress += (phase2Progress / 100) * 25;
  } else if (deal.phase === "phase3_content_creation") {
    let phase3Progress = 0;
    if (deal.cimContent) phase3Progress += 50;
    if (deal.contentApprovedByBroker) phase3Progress += 25;
    if (deal.contentApprovedBySeller) phase3Progress += 25;
    progress += (phase3Progress / 100) * 25;
  } else if (deal.phase === "phase4_design_finalization") {
    let phase4Progress = 0;
    if (deal.cimDesignData) phase4Progress += 50;
    if (deal.designApprovedByBroker) phase4Progress += 25;
    if (deal.designApprovedBySeller) phase4Progress += 25;
    progress += (phase4Progress / 100) * 25;
  }
  
  if (deal.isLive) progress = 100;
  
  return Math.min(100, Math.round(progress));
}

const CIM_SECTIONS = [
  { key: "executiveSummary", title: "Executive Summary", description: "High-level business overview" },
  { key: "businessDescription", title: "Business Description", description: "Products, services, and operations" },
  { key: "marketAnalysis", title: "Market Analysis", description: "Industry trends and competitive landscape" },
  { key: "financialOverview", title: "Financial Overview", description: "Revenue, margins, and growth trends" },
  { key: "operations", title: "Operations", description: "Team, processes, and infrastructure" },
  { key: "growthOpportunities", title: "Growth Opportunities", description: "Expansion and improvement potential" },
];

interface ContentTabProps {
  deal: Deal;
  dealId: string;
  toast: ReturnType<typeof useToast>["toast"];
}

function ContentTab({ deal, dealId, toast }: ContentTabProps) {
  const generateContentMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/deals/${dealId}/generate-content`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({
        title: "Content Generated",
        description: "AI has generated CIM content sections.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Generation Failed",
        description: error.message || "Failed to generate content.",
        variant: "destructive",
      });
    },
  });

  const approveContentMutation = useMutation({
    mutationFn: async (role: "broker" | "seller") => {
      const updates = role === "broker" 
        ? { contentApprovedByBroker: true }
        : { contentApprovedBySeller: true };
      const response = await apiRequest("PATCH", `/api/deals/${dealId}`, updates);
      return response.json();
    },
    onSuccess: (_, role) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({
        title: "Content Approved",
        description: `${role === "broker" ? "Broker" : "Seller"} has approved the content.`,
      });
    },
  });

  const cimContent = deal.cimContent as Record<string, string> | null;

  if (!deal.interviewCompleted) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">CIM Content</CardTitle>
          <CardDescription>AI-generated content sections</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <Edit className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>Complete the AI interview first to generate CIM content</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!cimContent) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">CIM Content</CardTitle>
          <CardDescription>AI-generated content sections</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <Edit className="h-12 w-12 mx-auto text-primary mb-4" />
            <p className="text-muted-foreground mb-4">
              Ready to generate professional CIM content from interview data
            </p>
            <Button 
              onClick={() => generateContentMutation.mutate()}
              disabled={generateContentMutation.isPending}
              data-testid="button-generate-content"
            >
              {generateContentMutation.isPending ? (
                <>Generating...</>
              ) : (
                <>
                  <Edit className="h-4 w-4 mr-2" />
                  Generate CIM Content
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">CIM Content</CardTitle>
            <CardDescription>Review and approve generated sections</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {deal.contentApprovedByBroker ? (
              <Badge variant="default"><CheckCircle className="h-3 w-3 mr-1" /> Broker Approved</Badge>
            ) : (
              <Button 
                size="sm" 
                variant="outline"
                onClick={() => approveContentMutation.mutate("broker")}
                disabled={approveContentMutation.isPending}
                data-testid="button-approve-broker"
              >
                Approve as Broker
              </Button>
            )}
            {deal.contentApprovedBySeller ? (
              <Badge variant="default"><CheckCircle className="h-3 w-3 mr-1" /> Seller Approved</Badge>
            ) : (
              <Button 
                size="sm" 
                variant="outline"
                onClick={() => approveContentMutation.mutate("seller")}
                disabled={approveContentMutation.isPending}
                data-testid="button-approve-seller"
              >
                Approve as Seller
              </Button>
            )}
          </div>
        </CardHeader>
      </Card>

      {CIM_SECTIONS.map((section) => {
        const content = cimContent[section.key];
        return (
          <Card key={section.key}>
            <CardHeader>
              <CardTitle className="text-base">{section.title}</CardTitle>
              <CardDescription>{section.description}</CardDescription>
            </CardHeader>
            <CardContent>
              {content ? (
                <div className="prose prose-sm max-w-none dark:prose-invert">
                  <p className="whitespace-pre-wrap">{content}</p>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No content generated for this section yet
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}

      <div className="flex justify-center">
        <Button 
          variant="outline"
          onClick={() => generateContentMutation.mutate()}
          disabled={generateContentMutation.isPending}
          data-testid="button-regenerate-content"
        >
          {generateContentMutation.isPending ? "Regenerating..." : "Regenerate All Content"}
        </Button>
      </div>
    </div>
  );
}

interface BuyersTabProps {
  deal: Deal;
  dealId: string;
  toast: ReturnType<typeof useToast>["toast"];
}

function BuyersTab({ deal, dealId, toast }: BuyersTabProps) {
  const [addBuyerDialogOpen, setAddBuyerDialogOpen] = useState(false);
  const [buyerName, setBuyerName] = useState("");
  const [buyerEmail, setBuyerEmail] = useState("");
  const [buyerCompany, setBuyerCompany] = useState("");
  const [expirationDays, setExpirationDays] = useState("30");

  const { data: buyers = [] } = useQuery<any[]>({
    queryKey: ["/api/deals", dealId, "buyers"],
    enabled: !!dealId,
  });

  const addBuyerMutation = useMutation({
    mutationFn: async (data: { buyerName: string; buyerEmail: string; buyerCompany?: string; expiresAt?: string }) => {
      const response = await apiRequest("POST", `/api/deals/${dealId}/buyers`, data);
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "buyers"] });
      setAddBuyerDialogOpen(false);
      setBuyerName("");
      setBuyerEmail("");
      setBuyerCompany("");
      setExpirationDays("30");
      toast({
        title: "Buyer Invited",
        description: "Access link has been generated for the buyer.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to add buyer access.",
        variant: "destructive",
      });
    },
  });

  const revokeBuyerMutation = useMutation({
    mutationFn: async (accessId: string) => {
      await apiRequest("DELETE", `/api/buyer-access/${accessId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "buyers"] });
      toast({
        title: "Access Revoked",
        description: "Buyer access has been revoked.",
      });
    },
  });

  const handleAddBuyer = () => {
    if (!buyerName.trim() || !buyerEmail.trim()) return;
    const expiresAt = expirationDays 
      ? new Date(Date.now() + parseInt(expirationDays) * 24 * 60 * 60 * 1000).toISOString()
      : undefined;
    addBuyerMutation.mutate({
      buyerName,
      buyerEmail,
      buyerCompany: buyerCompany || undefined,
      expiresAt,
    });
  };

  const copyAccessLink = (token: string) => {
    const link = `${window.location.origin}/view/${token}`;
    navigator.clipboard.writeText(link);
    toast({
      title: "Link Copied",
      description: "Buyer access link has been copied to clipboard.",
    });
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">Buyer Access</CardTitle>
            <CardDescription>Manage who can view this CIM</CardDescription>
          </div>
          <Button 
            variant="outline" 
            onClick={() => setAddBuyerDialogOpen(true)}
            data-testid="button-add-buyer"
          >
            <Users className="h-4 w-4 mr-2" />
            Add Buyer
          </Button>
        </CardHeader>
        <CardContent>
          {buyers.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Eye className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No buyers have been granted access yet</p>
              <p className="text-xs mt-1">Add buyers to generate secure viewing links</p>
            </div>
          ) : (
            <div className="space-y-3">
              {buyers.map((buyer) => (
                <div key={buyer.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center gap-3">
                    <Users className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <div className="font-medium">{buyer.buyerName}</div>
                      <div className="text-xs text-muted-foreground">
                        {buyer.buyerEmail}
                        {buyer.buyerCompany && ` • ${buyer.buyerCompany}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {buyer.expiresAt && (
                      <Badge variant="outline" className="text-xs">
                        Expires {new Date(buyer.expiresAt).toLocaleDateString()}
                      </Badge>
                    )}
                    {buyer.viewCount > 0 && (
                      <Badge variant="secondary">
                        <Eye className="h-3 w-3 mr-1" />
                        {buyer.viewCount} views
                      </Badge>
                    )}
                    <Badge variant={buyer.isActive ? "default" : "outline"}>
                      {buyer.isActive ? "Active" : "Revoked"}
                    </Badge>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => copyAccessLink(buyer.accessToken)}
                      data-testid={`button-copy-link-${buyer.id}`}
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                    {buyer.isActive && (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => revokeBuyerMutation.mutate(buyer.id)}
                        data-testid={`button-revoke-${buyer.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={addBuyerDialogOpen} onOpenChange={setAddBuyerDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Buyer Access</DialogTitle>
            <DialogDescription>Generate a secure viewing link for a potential buyer</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="buyer-name">Buyer Name</Label>
              <Input
                id="buyer-name"
                placeholder="John Smith"
                value={buyerName}
                onChange={(e) => setBuyerName(e.target.value)}
                data-testid="input-buyer-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="buyer-email">Buyer Email</Label>
              <Input
                id="buyer-email"
                type="email"
                placeholder="john@example.com"
                value={buyerEmail}
                onChange={(e) => setBuyerEmail(e.target.value)}
                data-testid="input-buyer-email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="buyer-company">Company (Optional)</Label>
              <Input
                id="buyer-company"
                placeholder="Acme Corp"
                value={buyerCompany}
                onChange={(e) => setBuyerCompany(e.target.value)}
                data-testid="input-buyer-company"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="expiration">Link Expiration</Label>
              <Select value={expirationDays} onValueChange={setExpirationDays}>
                <SelectTrigger id="expiration" data-testid="select-expiration">
                  <SelectValue placeholder="Select expiration" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">7 days</SelectItem>
                  <SelectItem value="14">14 days</SelectItem>
                  <SelectItem value="30">30 days</SelectItem>
                  <SelectItem value="60">60 days</SelectItem>
                  <SelectItem value="90">90 days</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Link will expire after this period for security
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => setAddBuyerDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleAddBuyer}
                disabled={!buyerName.trim() || !buyerEmail.trim() || addBuyerMutation.isPending}
                data-testid="button-confirm-add-buyer"
              >
                {addBuyerMutation.isPending ? "Adding..." : "Add Buyer"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface Phase1TabProps {
  deal: Deal;
  dealId: string;
  toast: ReturnType<typeof useToast>["toast"];
}

function Phase1Tab({ deal, dealId, toast }: Phase1TabProps) {
  const [sendQuestionnaireDialogOpen, setSendQuestionnaireDialogOpen] = useState(false);
  const [sellerEmail, setSellerEmail] = useState("");
  const [sellerName, setSellerName] = useState("");
  const [askingPrice, setAskingPrice] = useState(deal.askingPrice || "");
  const [valuationNotes, setValuationNotes] = useState("");

  const updateDealMutation = useMutation({
    mutationFn: async (data: Partial<Deal>) => {
      const response = await apiRequest("PATCH", `/api/deals/${dealId}`, data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: "Updated", description: "Deal information has been updated." });
    },
  });

  const createInviteMutation = useMutation({
    mutationFn: async (data: { sellerEmail: string; sellerName: string }) => {
      const response = await apiRequest("POST", `/api/deals/${dealId}/invites`, data);
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      setSendQuestionnaireDialogOpen(false);
      setSellerEmail("");
      setSellerName("");
      const inviteUrl = `${window.location.origin}/invite/${data.token}`;
      navigator.clipboard.writeText(inviteUrl);
      toast({ 
        title: "Invite Created", 
        description: "Seller invite link has been copied to clipboard." 
      });
    },
  });

  const handleMarkNdaSigned = () => {
    updateDealMutation.mutate({ 
      ndaSigned: true, 
      ndaSignedAt: new Date() 
    });
  };

  const handleMarkQuestionnaireComplete = () => {
    updateDealMutation.mutate({ sqCompleted: true });
  };

  const handleMarkValuationComplete = () => {
    updateDealMutation.mutate({ 
      valuationCompleted: true,
      askingPrice: askingPrice || undefined
    });
  };

  const handleSendQuestionnaire = () => {
    if (!sellerEmail.trim() || !sellerName.trim()) return;
    createInviteMutation.mutate({ sellerEmail, sellerName });
  };

  return (
    <>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <FileSignature className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-base">NDA (Non-Disclosure Agreement)</CardTitle>
                <CardDescription>Ensure confidentiality before sharing sensitive information</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {deal.ndaSigned ? (
              <div className="flex items-center justify-between p-4 bg-green-50 dark:bg-green-950/30 rounded-lg">
                <div className="flex items-center gap-3">
                  <CheckCircle className="h-5 w-5 text-green-600" />
                  <div>
                    <p className="font-medium text-green-800 dark:text-green-200">NDA Signed</p>
                    {deal.ndaSignedAt && (
                      <p className="text-sm text-green-600 dark:text-green-400">
                        Signed on {new Date(deal.ndaSignedAt).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                </div>
                <Badge variant="default">Complete</Badge>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  The NDA should be signed before proceeding with sensitive information collection.
                  Once the seller has signed, mark it as complete below.
                </p>
                <div className="flex gap-2">
                  <Button 
                    onClick={handleMarkNdaSigned}
                    disabled={updateDealMutation.isPending}
                    data-testid="button-mark-nda-signed"
                  >
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Mark NDA as Signed
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <ClipboardList className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-base">Seller Questionnaire</CardTitle>
                <CardDescription>Gather initial business information from the seller</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {deal.sqCompleted ? (
              <div className="flex items-center justify-between p-4 bg-green-50 dark:bg-green-950/30 rounded-lg">
                <div className="flex items-center gap-3">
                  <CheckCircle className="h-5 w-5 text-green-600" />
                  <div>
                    <p className="font-medium text-green-800 dark:text-green-200">Questionnaire Completed</p>
                    <p className="text-sm text-green-600 dark:text-green-400">
                      Initial information has been collected
                    </p>
                  </div>
                </div>
                <Badge variant="default">Complete</Badge>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Send the questionnaire to the seller or mark it complete if it was collected separately.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button 
                    variant="outline"
                    onClick={() => setSendQuestionnaireDialogOpen(true)}
                    data-testid="button-send-questionnaire"
                  >
                    <Mail className="h-4 w-4 mr-2" />
                    Send to Seller
                  </Button>
                  <Button 
                    variant="outline"
                    onClick={handleMarkQuestionnaireComplete}
                    disabled={updateDealMutation.isPending}
                    data-testid="button-mark-questionnaire-complete"
                  >
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Mark as Received/Complete
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Calculator className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-base">Valuation</CardTitle>
                <CardDescription>Business valuation and asking price</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {deal.valuationCompleted ? (
              <div className="flex items-center justify-between p-4 bg-green-50 dark:bg-green-950/30 rounded-lg">
                <div className="flex items-center gap-3">
                  <CheckCircle className="h-5 w-5 text-green-600" />
                  <div>
                    <p className="font-medium text-green-800 dark:text-green-200">Valuation Complete</p>
                    {deal.askingPrice && (
                      <p className="text-sm text-green-600 dark:text-green-400">
                        Asking Price: {deal.askingPrice}
                      </p>
                    )}
                  </div>
                </div>
                <Badge variant="default">Complete</Badge>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="asking-price">Asking Price</Label>
                  <Input
                    id="asking-price"
                    placeholder="e.g., $2,500,000"
                    value={askingPrice}
                    onChange={(e) => setAskingPrice(e.target.value)}
                    data-testid="input-asking-price"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="valuation-notes">Valuation Notes (Optional)</Label>
                  <Textarea
                    id="valuation-notes"
                    placeholder="Any notes about the valuation methodology..."
                    value={valuationNotes}
                    onChange={(e) => setValuationNotes(e.target.value)}
                    data-testid="input-valuation-notes"
                  />
                </div>
                <Button 
                  onClick={handleMarkValuationComplete}
                  disabled={updateDealMutation.isPending}
                  data-testid="button-mark-valuation-complete"
                >
                  <CheckCircle className="h-4 w-4 mr-2" />
                  Complete Valuation
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <FileText className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-base">Engagement Letter</CardTitle>
                <CardDescription>Formal engagement between broker and seller</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {deal.engagementSent ? (
              <div className="flex items-center justify-between p-4 bg-green-50 dark:bg-green-950/30 rounded-lg">
                <div className="flex items-center gap-3">
                  <CheckCircle className="h-5 w-5 text-green-600" />
                  <p className="font-medium text-green-800 dark:text-green-200">Engagement Letter Sent</p>
                </div>
                <Badge variant="default">Complete</Badge>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Mark when the engagement letter has been sent and acknowledged.
                </p>
                <Button 
                  variant="outline"
                  onClick={() => updateDealMutation.mutate({ engagementSent: true })}
                  disabled={updateDealMutation.isPending}
                  data-testid="button-mark-engagement-sent"
                >
                  <CheckCircle className="h-4 w-4 mr-2" />
                  Mark as Sent
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {deal.ndaSigned && deal.sqCompleted && deal.valuationCompleted && (
          <Card className="border-primary/50 bg-primary/5">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold">Ready for Phase 2</h3>
                  <p className="text-sm text-muted-foreground">
                    All Phase 1 requirements are complete. You can proceed to Platform Intake.
                  </p>
                </div>
                <Button data-testid="button-advance-phase-2">
                  Advance to Phase 2
                  <ChevronRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={sendQuestionnaireDialogOpen} onOpenChange={setSendQuestionnaireDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Questionnaire to Seller</DialogTitle>
            <DialogDescription>
              Generate a unique link for the seller to complete the questionnaire online
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="seller-name">Seller Name</Label>
              <Input
                id="seller-name"
                placeholder="John Smith"
                value={sellerName}
                onChange={(e) => setSellerName(e.target.value)}
                data-testid="input-seller-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="seller-email">Seller Email</Label>
              <Input
                id="seller-email"
                type="email"
                placeholder="john@example.com"
                value={sellerEmail}
                onChange={(e) => setSellerEmail(e.target.value)}
                data-testid="input-seller-email"
              />
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => setSendQuestionnaireDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSendQuestionnaire}
                disabled={!sellerName.trim() || !sellerEmail.trim() || createInviteMutation.isPending}
                data-testid="button-generate-invite"
              >
                {createInviteMutation.isPending ? "Generating..." : "Generate Invite Link"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function DealDetail() {
  const [, params] = useRoute("/deal/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const dealId = params?.id;

  const { data: deal, isLoading } = useQuery<Deal>({
    queryKey: ["/api/deals", dealId],
    enabled: !!dealId,
  });

  const { data: tasks = [] } = useQuery<Task[]>({
    queryKey: ["/api/deals", dealId, "tasks"],
    enabled: !!dealId,
  });

  const { data: documents = [] } = useQuery<DocType[]>({
    queryKey: ["/api/deals", dealId, "documents"],
    enabled: !!dealId,
  });

  const advancePhaseMutation = useMutation({
    mutationFn: async (nextPhase: string) => {
      const response = await apiRequest("PATCH", `/api/deals/${dealId}`, {
        phase: nextPhase,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({
        title: "Phase Updated",
        description: "Deal has been moved to the next phase.",
      });
    },
  });

  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [docName, setDocName] = useState("");
  const [docCategory, setDocCategory] = useState<string>("financials");
  const [inviteSellerDialogOpen, setInviteSellerDialogOpen] = useState(false);
  const [inviteSellerEmail, setInviteSellerEmail] = useState("");
  const [inviteSellerName, setInviteSellerName] = useState("");
  const [faqDialogOpen, setFaqDialogOpen] = useState(false);
  const [faqQuestion, setFaqQuestion] = useState("");
  const [faqAnswer, setFaqAnswer] = useState("");
  const [teaserDialogOpen, setTeaserDialogOpen] = useState(false);
  const [teaserData, setTeaserData] = useState<any>(null);
  const [blindDialogOpen, setBlindDialogOpen] = useState(false);
  const [blindData, setBlindData] = useState<any>(null);

  const uploadDocumentMutation = useMutation({
    mutationFn: async (data: { name: string; category: string }) => {
      const response = await apiRequest("POST", `/api/deals/${dealId}/documents`, {
        name: data.name,
        category: data.category,
        status: "pending",
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "documents"] });
      setUploadDialogOpen(false);
      setDocName("");
      setDocCategory("financials");
      toast({
        title: "Document Added",
        description: "The document has been added to the deal.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to add document.",
        variant: "destructive",
      });
    },
  });

  const deleteDocumentMutation = useMutation({
    mutationFn: async (docId: string) => {
      await apiRequest("DELETE", `/api/documents/${docId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "documents"] });
      toast({
        title: "Document Deleted",
        description: "The document has been removed.",
      });
    },
  });

  const handleUploadDocument = () => {
    if (!docName.trim()) return;
    uploadDocumentMutation.mutate({ name: docName, category: docCategory });
  };

  const topInviteSellerMutation = useMutation({
    mutationFn: async (data: { sellerEmail: string; sellerName: string }) => {
      const response = await apiRequest("POST", `/api/deals/${dealId}/invites`, data);
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      setInviteSellerDialogOpen(false);
      setInviteSellerEmail("");
      setInviteSellerName("");
      const inviteUrl = `${window.location.origin}/invite/${data.token}`;
      navigator.clipboard.writeText(inviteUrl);
      toast({ title: "Invite Created", description: "Seller invite link copied to clipboard." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create invite.", variant: "destructive" });
    },
  });

  const [addBuyerTopDialogOpen, setAddBuyerTopDialogOpen] = useState(false);
  const [topBuyerName, setTopBuyerName] = useState("");
  const [topBuyerEmail, setTopBuyerEmail] = useState("");

  const topAddBuyerMutation = useMutation({
    mutationFn: async (data: { buyerName: string; buyerEmail: string }) => {
      const response = await apiRequest("POST", `/api/deals/${dealId}/buyers`, {
        ...data,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "buyers"] });
      setAddBuyerTopDialogOpen(false);
      setTopBuyerName("");
      setTopBuyerEmail("");
      const viewUrl = `${window.location.origin}/view/${data.accessToken}`;
      navigator.clipboard.writeText(viewUrl);
      toast({ title: "Buyer Invited", description: "Buyer viewing link copied to clipboard." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to add buyer.", variant: "destructive" });
    },
  });

  const { data: faqs = [] } = useQuery<any[]>({
    queryKey: ["/api/deals", dealId, "faq"],
    enabled: !!dealId,
  });

  const addFaqMutation = useMutation({
    mutationFn: async (data: { question: string; answer: string }) => {
      const response = await apiRequest("POST", `/api/deals/${dealId}/faq`, data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "faq"] });
      setFaqDialogOpen(false);
      setFaqQuestion("");
      setFaqAnswer("");
      toast({ title: "FAQ Added", description: "FAQ item has been created." });
    },
  });

  const deleteFaqMutation = useMutation({
    mutationFn: async (faqId: string) => {
      await apiRequest("DELETE", `/api/faq/${faqId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "faq"] });
      toast({ title: "FAQ Deleted" });
    },
  });

  const flagMissingMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/deals/${dealId}/flag-missing`);
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "tasks"] });
      toast({
        title: "Missing Info Flagged",
        description: `${data.capturedCount}/${data.totalFields} data points captured. ${data.missingCount} items flagged.`,
      });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to flag missing info.", variant: "destructive" });
    },
  });

  const generateTeaserMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/deals/${dealId}/generate-teaser`);
      return response.json();
    },
    onSuccess: (data) => {
      setTeaserData(data);
      setTeaserDialogOpen(true);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to generate teaser.", variant: "destructive" });
    },
  });

  const generateBlindMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/deals/${dealId}/generate-blind`);
      return response.json();
    },
    onSuccess: (data) => {
      setBlindData(data);
      setBlindDialogOpen(true);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to generate blind CIM.", variant: "destructive" });
    },
  });

  const handleExportCIM = () => {
    const cimContent = deal?.cimContent as Record<string, string> | null;
    if (!cimContent || !deal) return;

    const sectionTitles: Record<string, string> = {
      executiveSummary: "Executive Summary",
      businessDescription: "Business Description",
      marketAnalysis: "Market Analysis",
      financialOverview: "Financial Overview",
      operations: "Operations",
      growthOpportunities: "Growth Opportunities",
    };

    const sectionsHtml = Object.entries(cimContent)
      .map(([key, content]) => `
        <div class="section">
          <h2>${sectionTitles[key] || key}</h2>
          <p>${(content || '').replace(/\n/g, '<br/>')}</p>
        </div>
      `).join('');

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${deal.businessName} - Confidential Information Memorandum</title>
<style>
body { font-family: 'Georgia', serif; max-width: 800px; margin: 0 auto; padding: 40px; color: #333; line-height: 1.6; }
h1 { color: #1a1a2e; border-bottom: 3px solid #1a1a2e; padding-bottom: 12px; font-size: 28px; }
h2 { color: #16213e; margin-top: 32px; font-size: 20px; border-bottom: 1px solid #ddd; padding-bottom: 8px; }
.header { text-align: center; margin-bottom: 40px; }
.header p { color: #666; font-style: italic; }
.section { margin-bottom: 24px; }
.section p { text-align: justify; }
.confidential { text-align: center; color: #999; font-size: 12px; margin-top: 40px; border-top: 1px solid #ddd; padding-top: 12px; }
@media print { body { padding: 20px; } }
</style></head><body>
<div class="header">
<h1>${deal.businessName}</h1>
<p>Confidential Information Memorandum</p>
<p>${deal.industry}</p>
</div>
${sectionsHtml}
<div class="confidential">
<p>CONFIDENTIAL - This document contains proprietary information intended solely for qualified potential buyers.</p>
<p>Unauthorized distribution is strictly prohibited.</p>
</div>
</body></html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${deal.businessName.replace(/[^a-zA-Z0-9]/g, '_')}_CIM.html`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "CIM Exported", description: "The CIM document has been downloaded." });
  };

  const publishLiveMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("PATCH", `/api/deals/${dealId}`, { isLive: true });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: "CIM Published", description: "The CIM is now live and available to invited buyers." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to publish CIM.", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center">
        <div className="text-muted-foreground">Loading deal...</div>
      </div>
    );
  }

  if (!deal) {
    return (
      <div className="p-6 flex flex-col items-center justify-center gap-4">
        <AlertCircle className="h-12 w-12 text-muted-foreground" />
        <div className="text-muted-foreground">Deal not found</div>
        <Button variant="outline" onClick={() => setLocation("/")}>
          Back to Dashboard
        </Button>
      </div>
    );
  }

  const currentPhaseIndex = PHASES.findIndex(p => p.key === deal.phase);
  const progress = getPhaseProgress(deal);
  const pendingTasks = tasks.filter(t => t.status === "pending");

  const handleStartInterview = () => {
    setLocation(`/deal/${dealId}/interview`);
  };

  const getNextPhase = () => {
    const currentIndex = PHASES.findIndex(p => p.key === deal.phase);
    if (currentIndex < PHASES.length - 1) {
      return PHASES[currentIndex + 1].key;
    }
    return null;
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setLocation("/")}
          data-testid="button-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{deal.businessName}</h1>
            <Badge variant={deal.isLive ? "default" : "secondary"}>
              {deal.isLive ? "Live" : PHASES[currentPhaseIndex]?.description || deal.phase}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">{deal.industry}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setInviteSellerDialogOpen(true)} data-testid="button-invite-seller">
            <Send className="h-4 w-4 mr-2" />
            Invite Seller
          </Button>
          <Button variant="outline" onClick={() => setAddBuyerTopDialogOpen(true)} data-testid="button-invite-buyer">
            <Users className="h-4 w-4 mr-2" />
            Invite Buyer
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Deal Progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Progress value={progress} className="flex-1" />
            <span className="text-sm font-medium w-12 text-right">{progress}%</span>
          </div>
          
          <div className="flex items-center justify-between">
            {PHASES.map((phase, index) => {
              const isActive = deal.phase === phase.key;
              const isCompleted = currentPhaseIndex > index;
              const Icon = phase.icon;
              
              return (
                <div key={phase.key} className="flex items-center gap-2">
                  <div 
                    className={`flex flex-col items-center gap-1 p-3 rounded-lg transition-colors ${
                      isActive ? "bg-primary/10" : isCompleted ? "bg-muted" : ""
                    }`}
                  >
                    <div className={`p-2 rounded-full ${
                      isActive ? "bg-primary text-primary-foreground" : 
                      isCompleted ? "bg-green-500 text-white" : "bg-muted"
                    }`}>
                      {isCompleted ? (
                        <CheckCircle className="h-4 w-4" />
                      ) : (
                        <Icon className="h-4 w-4" />
                      )}
                    </div>
                    <span className={`text-xs font-medium ${isActive ? "text-primary" : ""}`}>
                      {phase.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {phase.description}
                    </span>
                  </div>
                  {index < PHASES.length - 1 && (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="phase1">Phase 1</TabsTrigger>
          <TabsTrigger value="documents">Documents ({documents.length})</TabsTrigger>
          <TabsTrigger value="tasks">Tasks ({pendingTasks.length})</TabsTrigger>
          <TabsTrigger value="interview">AI Interview</TabsTrigger>
          <TabsTrigger value="content">CIM Content</TabsTrigger>
          <TabsTrigger value="buyers">Buyers</TabsTrigger>
          <TabsTrigger value="faq">FAQ ({faqs.length})</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Phase 1: Info Collection</CardTitle>
                <CardDescription>Initial data gathering from seller</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">NDA Signed</span>
                  {deal.ndaSigned ? (
                    <Badge variant="default"><CheckCircle className="h-3 w-3 mr-1" /> Complete</Badge>
                  ) : (
                    <Badge variant="outline"><Clock className="h-3 w-3 mr-1" /> Pending</Badge>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Seller Questionnaire</span>
                  {deal.sqCompleted ? (
                    <Badge variant="default"><CheckCircle className="h-3 w-3 mr-1" /> Complete</Badge>
                  ) : (
                    <Badge variant="outline"><Clock className="h-3 w-3 mr-1" /> Pending</Badge>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Valuation</span>
                  {deal.valuationCompleted ? (
                    <Badge variant="default"><CheckCircle className="h-3 w-3 mr-1" /> Complete</Badge>
                  ) : (
                    <Badge variant="outline"><Clock className="h-3 w-3 mr-1" /> Pending</Badge>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Phase 2: Platform Intake</CardTitle>
                <CardDescription>AI interview and document collection</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">Operational Info</span>
                  {deal.questionnaireData ? (
                    <Badge variant="default"><CheckCircle className="h-3 w-3 mr-1" /> Complete</Badge>
                  ) : (
                    <Badge variant="outline"><Clock className="h-3 w-3 mr-1" /> Pending</Badge>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">AI Interview</span>
                  {deal.interviewCompleted ? (
                    <Badge variant="default"><CheckCircle className="h-3 w-3 mr-1" /> Complete</Badge>
                  ) : (
                    <Badge variant="outline"><Clock className="h-3 w-3 mr-1" /> Pending</Badge>
                  )}
                </div>
                {deal.phase === "phase2_platform_intake" && !deal.interviewCompleted && (
                  <Button 
                    size="sm" 
                    className="w-full mt-2"
                    onClick={handleStartInterview}
                    data-testid="button-start-interview"
                  >
                    <MessageSquare className="h-4 w-4 mr-2" />
                    Start AI Interview
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Phase 3: Content Creation</CardTitle>
                <CardDescription>AI writes CIM copy for review</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">AI Draft</span>
                  {deal.cimContent ? (
                    <Badge variant="default"><CheckCircle className="h-3 w-3 mr-1" /> Complete</Badge>
                  ) : (
                    <Badge variant="outline"><Clock className="h-3 w-3 mr-1" /> Pending</Badge>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Broker Approval</span>
                  {deal.contentApprovedByBroker ? (
                    <Badge variant="default"><CheckCircle className="h-3 w-3 mr-1" /> Approved</Badge>
                  ) : (
                    <Badge variant="outline"><Clock className="h-3 w-3 mr-1" /> Pending</Badge>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Seller Approval</span>
                  {deal.contentApprovedBySeller ? (
                    <Badge variant="default"><CheckCircle className="h-3 w-3 mr-1" /> Approved</Badge>
                  ) : (
                    <Badge variant="outline"><Clock className="h-3 w-3 mr-1" /> Pending</Badge>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Phase 4: Design & Finalization</CardTitle>
                <CardDescription>AI designs CIM for final approval</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">CIM Design</span>
                  {deal.cimDesignData ? (
                    <Badge variant="default"><CheckCircle className="h-3 w-3 mr-1" /> Complete</Badge>
                  ) : (
                    <Badge variant="outline"><Clock className="h-3 w-3 mr-1" /> Pending</Badge>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Broker Approval</span>
                  {deal.designApprovedByBroker ? (
                    <Badge variant="default"><CheckCircle className="h-3 w-3 mr-1" /> Approved</Badge>
                  ) : (
                    <Badge variant="outline"><Clock className="h-3 w-3 mr-1" /> Pending</Badge>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Seller Approval</span>
                  {deal.designApprovedBySeller ? (
                    <Badge variant="default"><CheckCircle className="h-3 w-3 mr-1" /> Approved</Badge>
                  ) : (
                    <Badge variant="outline"><Clock className="h-3 w-3 mr-1" /> Pending</Badge>
                  )}
                </div>
                <Button 
                  className="w-full mt-2" 
                  variant="outline"
                  onClick={() => setLocation(`/deal/${dealId}/design`)}
                  data-testid="button-design-cim"
                >
                  <Palette className="h-4 w-4 mr-2" />
                  Open CIM Designer
                </Button>
              </CardContent>
            </Card>
          </div>

          {getNextPhase() && (
            <div className="mt-6 flex justify-end">
              <Button
                onClick={() => {
                  const nextPhase = getNextPhase();
                  if (nextPhase) advancePhaseMutation.mutate(nextPhase);
                }}
                disabled={advancePhaseMutation.isPending}
                data-testid="button-advance-phase"
              >
                Advance to Next Phase
                <ChevronRight className="h-4 w-4 ml-2" />
              </Button>
            </div>
          )}
        </TabsContent>

        <TabsContent value="phase1" className="mt-6">
          <Phase1Tab deal={deal} dealId={dealId!} toast={toast} />
        </TabsContent>

        <TabsContent value="documents" className="mt-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
              <div>
                <CardTitle className="text-base">Documents</CardTitle>
                <CardDescription>Uploaded files and financial documents</CardDescription>
              </div>
              <Button 
                variant="outline" 
                onClick={() => setUploadDialogOpen(true)}
                data-testid="button-upload-document"
              >
                <Upload className="h-4 w-4 mr-2" />
                Add Document
              </Button>
            </CardHeader>
            <CardContent>
              {documents.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <FolderOpen className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p>No documents uploaded yet</p>
                  <p className="text-xs mt-1">Add documents to track financials, legal, and operations files</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {DOCUMENT_CATEGORIES.map(cat => {
                    const categoryDocs = documents.filter(d => d.category === cat.value);
                    if (categoryDocs.length === 0) return null;
                    const IconComponent = cat.icon;
                    return (
                      <div key={cat.value} className="mb-4">
                        <div className="flex items-center gap-2 mb-2">
                          <IconComponent className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm font-medium">{cat.label}</span>
                          <Badge variant="secondary" className="ml-auto">{categoryDocs.length}</Badge>
                        </div>
                        <div className="space-y-1 ml-6">
                          {categoryDocs.map((doc) => (
                            <div key={doc.id} className="flex items-center justify-between p-2 border rounded-md">
                              <div className="flex items-center gap-2">
                                <FileText className="h-4 w-4 text-muted-foreground" />
                                <span className="text-sm">{doc.name}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <Badge variant={doc.status === "processed" ? "default" : "outline"} className="text-xs">
                                  {doc.status}
                                </Badge>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => deleteDocumentMutation.mutate(doc.id)}
                                  disabled={deleteDocumentMutation.isPending}
                                  data-testid={`button-delete-document-${doc.id}`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Document</DialogTitle>
                <DialogDescription>Add a document record to this deal</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label htmlFor="doc-name">Document Name</Label>
                  <Input
                    id="doc-name"
                    placeholder="e.g., 2024 P&L Statement"
                    value={docName}
                    onChange={(e) => setDocName(e.target.value)}
                    data-testid="input-doc-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="doc-category">Category</Label>
                  <Select value={docCategory} onValueChange={setDocCategory}>
                    <SelectTrigger data-testid="select-doc-category">
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      {DOCUMENT_CATEGORIES.map(cat => (
                        <SelectItem key={cat.value} value={cat.value}>
                          <div className="flex items-center gap-2">
                            <cat.icon className="h-4 w-4" />
                            <span>{cat.label}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {DOCUMENT_CATEGORIES.find(c => c.value === docCategory)?.description}
                  </p>
                </div>
                <div className="flex justify-end gap-2 pt-4">
                  <Button variant="outline" onClick={() => setUploadDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={handleUploadDocument}
                    disabled={!docName.trim() || uploadDocumentMutation.isPending}
                    data-testid="button-confirm-upload"
                  >
                    {uploadDocumentMutation.isPending ? "Adding..." : "Add Document"}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </TabsContent>

        <TabsContent value="tasks" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Outstanding Tasks</CardTitle>
              <CardDescription>Items requiring attention</CardDescription>
            </CardHeader>
            <CardContent>
              {tasks.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No outstanding tasks
                </div>
              ) : (
                <div className="space-y-2">
                  {tasks.map((task) => (
                    <div key={task.id} className="flex items-center justify-between p-3 border rounded-lg">
                      <div className="flex items-center gap-3">
                        <AlertCircle className="h-5 w-5 text-amber-500" />
                        <div>
                          <div className="font-medium">{task.title}</div>
                          <div className="text-xs text-muted-foreground">{task.type}</div>
                        </div>
                      </div>
                      <Badge variant={task.status === "completed" ? "default" : "outline"}>
                        {task.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="interview" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">AI Interview</CardTitle>
              <CardDescription>Intelligent interview to extract business information</CardDescription>
            </CardHeader>
            <CardContent>
              {deal.interviewCompleted ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-green-600">
                    <CheckCircle className="h-5 w-5" />
                    <span className="font-medium">Interview completed</span>
                  </div>
                  <div className="p-4 bg-muted rounded-lg">
                    <h4 className="font-medium mb-2">Extracted Information</h4>
                    <pre className="text-xs overflow-auto">
                      {JSON.stringify(deal.extractedInfo, null, 2)}
                    </pre>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8">
                  <MessageSquare className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                  <p className="text-muted-foreground mb-4">
                    The AI interview will guide the seller through questions about their business
                  </p>
                  <Button onClick={handleStartInterview} data-testid="button-start-interview-tab">
                    <MessageSquare className="h-4 w-4 mr-2" />
                    Start Interview
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="content" className="mt-6">
          <ContentTab deal={deal} dealId={dealId!} toast={toast} />
        </TabsContent>

        <TabsContent value="buyers" className="mt-6">
          <BuyersTab deal={deal} dealId={dealId!} toast={toast} />
        </TabsContent>

        <TabsContent value="faq" className="mt-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
              <div>
                <CardTitle className="text-base">FAQ Items</CardTitle>
                <CardDescription>Questions and answers visible to buyers</CardDescription>
              </div>
              <Button variant="outline" onClick={() => setFaqDialogOpen(true)} data-testid="button-add-faq">
                <ClipboardList className="h-4 w-4 mr-2" />
                Add FAQ
              </Button>
            </CardHeader>
            <CardContent>
              {faqs.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <ClipboardList className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p>No FAQ items yet</p>
                  <p className="text-xs mt-1">Add common questions buyers might ask about this business</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {faqs.map((faq: any) => (
                    <div key={faq.id} className="p-4 border rounded-lg space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-medium text-sm">{faq.question}</div>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => deleteFaqMutation.mutate(faq.id)}
                          data-testid={`button-delete-faq-${faq.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <p className="text-sm text-muted-foreground">{faq.answer}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Dialog open={faqDialogOpen} onOpenChange={setFaqDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add FAQ Item</DialogTitle>
                <DialogDescription>Add a question and answer for buyers to see</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label htmlFor="faq-q">Question</Label>
                  <Input
                    id="faq-q"
                    placeholder="e.g., What is included in the sale?"
                    value={faqQuestion}
                    onChange={(e) => setFaqQuestion(e.target.value)}
                    data-testid="input-faq-question"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="faq-a">Answer</Label>
                  <Textarea
                    id="faq-a"
                    placeholder="Provide a detailed answer..."
                    value={faqAnswer}
                    onChange={(e) => setFaqAnswer(e.target.value)}
                    rows={4}
                    data-testid="input-faq-answer"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-4">
                  <Button variant="outline" onClick={() => setFaqDialogOpen(false)}>Cancel</Button>
                  <Button
                    onClick={() => addFaqMutation.mutate({ question: faqQuestion, answer: faqAnswer })}
                    disabled={!faqQuestion.trim() || !faqAnswer.trim() || addFaqMutation.isPending}
                    data-testid="button-confirm-faq"
                  >
                    {addFaqMutation.isPending ? "Adding..." : "Add FAQ"}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </TabsContent>

        <TabsContent value="tools" className="mt-6">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Review Tools</CardTitle>
                <CardDescription>Analyze and validate deal information</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => flagMissingMutation.mutate()}
                  disabled={flagMissingMutation.isPending}
                  data-testid="button-flag-missing"
                >
                  <AlertCircle className="h-4 w-4 mr-2" />
                  {flagMissingMutation.isPending ? "Checking..." : "Flag Missing Information"}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Generate Documents</CardTitle>
                <CardDescription>Create marketing materials from CIM data</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => generateTeaserMutation.mutate()}
                  disabled={generateTeaserMutation.isPending || !deal.extractedInfo}
                  data-testid="button-generate-teaser"
                >
                  <FileSignature className="h-4 w-4 mr-2" />
                  {generateTeaserMutation.isPending ? "Generating..." : "Generate Teaser"}
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => generateBlindMutation.mutate()}
                  disabled={generateBlindMutation.isPending || !deal.cimContent}
                  data-testid="button-generate-blind"
                >
                  <Eye className="h-4 w-4 mr-2" />
                  {generateBlindMutation.isPending ? "Generating..." : "Generate Blind CIM"}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Export</CardTitle>
                <CardDescription>Download CIM as a formatted document</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => handleExportCIM()}
                  disabled={!deal.cimContent}
                  data-testid="button-export-cim"
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Export CIM (HTML)
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Publish</CardTitle>
                <CardDescription>Make the CIM available to buyers</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {deal.isLive ? (
                  <Badge variant="default" className="w-full flex items-center justify-center gap-2 py-2">
                    <CheckCircle className="h-4 w-4" />
                    CIM is Live
                  </Badge>
                ) : (
                  <Button
                    className="w-full"
                    onClick={() => publishLiveMutation.mutate()}
                    disabled={publishLiveMutation.isPending || !deal.cimContent}
                    data-testid="button-publish-live"
                  >
                    {publishLiveMutation.isPending ? "Publishing..." : "Publish CIM Live"}
                  </Button>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={inviteSellerDialogOpen} onOpenChange={setInviteSellerDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite Seller</DialogTitle>
            <DialogDescription>Send an invite link to the business seller for AI interview</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="seller-name">Seller Name</Label>
              <Input
                id="seller-name"
                placeholder="Jane Doe"
                value={inviteSellerName}
                onChange={(e) => setInviteSellerName(e.target.value)}
                data-testid="input-seller-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="seller-email">Seller Email</Label>
              <Input
                id="seller-email"
                type="email"
                placeholder="jane@business.com"
                value={inviteSellerEmail}
                onChange={(e) => setInviteSellerEmail(e.target.value)}
                data-testid="input-seller-email"
              />
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => setInviteSellerDialogOpen(false)}>Cancel</Button>
              <Button
                onClick={() => topInviteSellerMutation.mutate({ sellerName: inviteSellerName, sellerEmail: inviteSellerEmail })}
                disabled={!inviteSellerName.trim() || !inviteSellerEmail.trim() || topInviteSellerMutation.isPending}
                data-testid="button-confirm-invite-seller"
              >
                {topInviteSellerMutation.isPending ? "Creating..." : "Create Invite"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={addBuyerTopDialogOpen} onOpenChange={setAddBuyerTopDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite Buyer</DialogTitle>
            <DialogDescription>Generate a secure CIM viewing link for a potential buyer</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="top-buyer-name">Buyer Name</Label>
              <Input
                id="top-buyer-name"
                placeholder="John Smith"
                value={topBuyerName}
                onChange={(e) => setTopBuyerName(e.target.value)}
                data-testid="input-top-buyer-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="top-buyer-email">Buyer Email</Label>
              <Input
                id="top-buyer-email"
                type="email"
                placeholder="john@example.com"
                value={topBuyerEmail}
                onChange={(e) => setTopBuyerEmail(e.target.value)}
                data-testid="input-top-buyer-email"
              />
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => setAddBuyerTopDialogOpen(false)}>Cancel</Button>
              <Button
                onClick={() => topAddBuyerMutation.mutate({ buyerName: topBuyerName, buyerEmail: topBuyerEmail })}
                disabled={!topBuyerName.trim() || !topBuyerEmail.trim() || topAddBuyerMutation.isPending}
                data-testid="button-confirm-top-buyer"
              >
                {topAddBuyerMutation.isPending ? "Adding..." : "Invite Buyer"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={teaserDialogOpen} onOpenChange={setTeaserDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Business Teaser</DialogTitle>
            <DialogDescription>One-page summary for prospective buyers</DialogDescription>
          </DialogHeader>
          {teaserData && (
            <div className="space-y-4 mt-4">
              <h3 className="font-semibold text-lg">{teaserData.headline}</h3>
              <p className="text-sm text-muted-foreground">{teaserData.summary}</p>
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Key Highlights</h4>
                <ul className="space-y-1">
                  {teaserData.highlights?.map((h: string, i: number) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <CheckCircle className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex items-center justify-between text-sm border-t pt-3">
                <span className="text-muted-foreground">Industry: {teaserData.industry}</span>
                <span className="text-muted-foreground">Location: {teaserData.location}</span>
              </div>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  const text = `${teaserData.headline}\n\n${teaserData.summary}\n\nHighlights:\n${teaserData.highlights?.map((h: string) => `- ${h}`).join('\n')}\n\nIndustry: ${teaserData.industry}\nLocation: ${teaserData.location}`;
                  navigator.clipboard.writeText(text);
                  toast({ title: "Copied", description: "Teaser text copied to clipboard." });
                }}
                data-testid="button-copy-teaser"
              >
                <Copy className="h-4 w-4 mr-2" />
                Copy to Clipboard
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={blindDialogOpen} onOpenChange={setBlindDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Blind CIM</DialogTitle>
            <DialogDescription>Sanitized version with identifying information removed</DialogDescription>
          </DialogHeader>
          {blindData && (
            <div className="space-y-4 mt-4">
              <Badge variant="outline">{blindData.blindBusinessName}</Badge>
              {Object.entries(blindData.blindContent || {}).map(([key, content]) => (
                <div key={key} className="space-y-1">
                  <h4 className="text-sm font-medium capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}</h4>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{content as string}</p>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
