import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Search, Plus, UserPlus, FileEdit, ChevronRight } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Deal } from "@shared/schema";
import { 
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { 
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

const PHASE_LABELS: Record<string, string> = {
  phase1_info_collection: "Phase 1: Info Collection",
  phase2_platform_intake: "Phase 2: Platform Intake",
  phase3_content_creation: "Phase 3: Content Creation",
  phase4_design_finalization: "Phase 4: Design & Final",
};

function getPhaseProgress(deal: Deal): number {
  switch (deal.phase) {
    case "phase1_info_collection": return 15;
    case "phase2_platform_intake": return 40;
    case "phase3_content_creation": return 70;
    case "phase4_design_finalization": return 90;
    default: return 0;
  }
}

function getPhaseBadgeVariant(phase: string): "default" | "secondary" | "outline" {
  switch (phase) {
    case "phase1_info_collection": return "secondary";
    case "phase2_platform_intake": return "default";
    case "phase3_content_creation": return "default";
    case "phase4_design_finalization": return "default";
    default: return "outline";
  }
}

export default function ActiveCIMs() {
  const [searchQuery, setSearchQuery] = useState("");
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: allDeals = [], isLoading } = useQuery<Deal[]>({
    queryKey: ["/api/deals"],
  });

  const filteredDeals = allDeals.filter((deal) =>
    deal.businessName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    deal.industry.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleCreateDeal = () => {
    setLocation("/new-deal");
  };

  const handleGenerateInvite = () => {
    const token = Math.random().toString(36).substring(2, 15);
    const inviteUrl = `${window.location.origin}/invite/${token}`;
    
    navigator.clipboard.writeText(inviteUrl);
    
    toast({
      title: "Invite Link Generated",
      description: "The link has been copied to your clipboard",
    });
    
    setInviteDialogOpen(false);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Deals</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage all your CIM deals
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button data-testid="button-create-deal">
              <Plus className="h-4 w-4 mr-2" />
              New Deal
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onClick={handleCreateDeal} data-testid="menu-complete-myself">
              <FileEdit className="h-4 w-4 mr-2" />
              Complete It Myself
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setInviteDialogOpen(true)} data-testid="menu-invite-seller">
              <UserPlus className="h-4 w-4 mr-2" />
              Invite Seller
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search deals..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
          data-testid="input-search"
        />
      </div>

      {isLoading ? (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
          <p className="text-sm text-muted-foreground mt-2">Loading deals...</p>
        </div>
      ) : filteredDeals.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            {searchQuery ? "No deals found matching your search." : "No deals yet. Create your first one to get started!"}
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {filteredDeals.map((deal) => {
            const progress = deal.isLive ? 100 : getPhaseProgress(deal);
            return (
              <Link key={deal.id} href={`/deal/${deal.id}`}>
                <Card 
                  className="hover-elevate cursor-pointer transition-colors"
                  data-testid={`deal-card-${deal.id}`}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-2">
                          <h3 className="font-semibold truncate">{deal.businessName}</h3>
                          <Badge variant={deal.isLive ? "default" : getPhaseBadgeVariant(deal.phase)}>
                            {deal.isLive ? "Live" : PHASE_LABELS[deal.phase] || deal.phase}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground mb-3">{deal.industry}</p>
                        <div className="flex items-center gap-3">
                          <Progress value={progress} className="flex-1 h-2" />
                          <span className="text-xs text-muted-foreground w-12">{progress}%</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">
                          Updated {format(new Date(deal.updatedAt), "MMM d, yyyy")}
                        </p>
                      </div>
                      <ChevronRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      <Dialog open={inviteDialogOpen} onOpenChange={setInviteDialogOpen}>
        <DialogContent data-testid="dialog-invite-seller">
          <DialogHeader>
            <DialogTitle>Invite Seller</DialogTitle>
            <DialogDescription>
              Generate a secure link to send to the seller. They'll be guided through the CIM intake process by AI.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="seller-email">Seller Email (optional)</Label>
              <Input
                id="seller-email"
                placeholder="seller@example.com"
                type="email"
                data-testid="input-seller-email"
              />
              <p className="text-xs text-muted-foreground">
                We'll send them the invite link automatically
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleGenerateInvite} data-testid="button-generate-invite">
              Generate Invite Link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
