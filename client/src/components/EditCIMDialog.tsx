import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Cim } from "@shared/schema";

interface EditCIMDialogProps {
  cim: Cim;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditCIMDialog({ cim, open, onOpenChange }: EditCIMDialogProps) {
  const [businessName, setBusinessName] = useState(cim.businessName);
  const [industry, setIndustry] = useState(cim.industry);
  const [description, setDescription] = useState(cim.description || "");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Reset form state when dialog opens or CIM data changes
  useEffect(() => {
    if (open) {
      setBusinessName(cim.businessName);
      setIndustry(cim.industry);
      setDescription(cim.description || "");
    }
  }, [open, cim.businessName, cim.industry, cim.description]);

  const updateMutation = useMutation({
    mutationFn: async (data: { businessName: string; industry: string; description: string }) => {
      return apiRequest("PATCH", `/api/cims/${cim.id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cims", cim.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/cims"] });
      toast({
        title: "CIM Updated",
        description: "Your changes have been saved successfully.",
      });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update CIM. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSave = () => {
    if (!businessName.trim() || !industry.trim()) {
      toast({
        title: "Validation Error",
        description: "Business name and industry are required.",
        variant: "destructive",
      });
      return;
    }

    updateMutation.mutate({
      businessName: businessName.trim(),
      industry: industry.trim(),
      description: description.trim(),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Edit CIM Details</DialogTitle>
          <DialogDescription>
            Update the basic information for this CIM.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="business-name">Business Name</Label>
            <Input
              id="business-name"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="Enter business name"
              data-testid="input-business-name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="industry">Industry</Label>
            <Input
              id="industry"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              placeholder="e.g., Restaurant, SaaS, Manufacturing"
              data-testid="input-industry"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of the business"
              rows={4}
              data-testid="input-description"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="button-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={updateMutation.isPending}
            data-testid="button-save"
          >
            {updateMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
