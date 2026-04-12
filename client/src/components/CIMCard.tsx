import { FileText, MoreVertical, Download, Eye, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Link } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";

interface CIMCardProps {
  id: string;
  businessName: string;
  industry: string;
  status: "draft" | "in_progress" | "review" | "completed";
  progress: number;
  lastUpdated: string;
}

const statusConfig = {
  draft: { label: "Draft", variant: "secondary" as const },
  in_progress: { label: "In Progress", variant: "default" as const },
  review: { label: "Review", variant: "outline" as const },
  completed: { label: "Completed", variant: "default" as const },
};

export function CIMCard({
  id,
  businessName,
  industry,
  status,
  progress,
  lastUpdated,
}: CIMCardProps) {
  const { toast } = useToast();
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    if (!confirm(`Are you sure you want to delete "${businessName}"? This action cannot be undone.`)) {
      return;
    }

    setIsDeleting(true);
    try {
      await apiRequest("DELETE", `/api/cims/${id}`);
      
      // Invalidate cache to refresh the list
      await queryClient.invalidateQueries({ queryKey: ["/api/cims"] });
      
      // Clear CIM-specific localStorage
      localStorage.removeItem(`cim_${id}_data`);
      localStorage.removeItem(`cim_${id}_questionnaireAnswers`);
      localStorage.removeItem(`cim_${id}_questionnaireStep`);
      
      // Clear currentCimId if this was the active CIM
      const currentCimId = localStorage.getItem("currentCimId");
      if (currentCimId === id) {
        localStorage.removeItem("currentCimId");
      }

      toast({
        title: "CIM Deleted",
        description: `"${businessName}" has been deleted successfully.`,
      });
    } catch (error: any) {
      console.error("Failed to delete CIM:", error);
      toast({
        title: "Error",
        description: "Failed to delete CIM. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Card className="hover-elevate">
      <CardContent className="p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex gap-3 flex-1 min-w-0">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
              <FileText className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-base truncate">{businessName}</h3>
              <p className="text-sm text-muted-foreground">{industry}</p>
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" disabled={isDeleting} data-testid="button-cim-menu">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem data-testid="menu-view">
                <Eye className="h-4 w-4 mr-2" />
                View Details
              </DropdownMenuItem>
              <DropdownMenuItem data-testid="menu-download">
                <Download className="h-4 w-4 mr-2" />
                Download
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem 
                onClick={handleDelete} 
                disabled={isDeleting}
                className="text-destructive focus:text-destructive"
                data-testid="menu-delete"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {isDeleting ? "Deleting..." : "Delete"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <Badge variant={statusConfig[status].variant}>
              {statusConfig[status].label}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {progress}% Complete
            </span>
          </div>

          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>

          <div className="flex items-center justify-between gap-4 flex-wrap">
            <p className="text-xs text-muted-foreground">
              Updated {lastUpdated}
            </p>
            <Link href={`/broker/cim/${id}`}>
              <Button variant="ghost" size="sm" data-testid="button-continue">
                Continue
              </Button>
            </Link>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
