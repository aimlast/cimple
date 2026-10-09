/**
 * SaveTeaserTemplateDialog — "Save as my teaser template": the blocks, their
 * order and titles, and the broker's own wording — never this deal's
 * information. "Use it for new teasers" makes it the default.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { TeaserApi } from "./useTeaser";

export function SaveTeaserTemplateDialog({ api, open, onOpenChange }: { api: TeaserApi; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState("");
  const [makeDefault, setMakeDefault] = useState(true);
  useEffect(() => {
    if (open) {
      setName("");
      setMakeDefault(true);
    }
  }, [open]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    api.saveTemplate.mutate({ name: name.trim(), makeDefault }, { onSuccess: () => onOpenChange(false) });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Save as my teaser template</DialogTitle>
            <DialogDescription>Saves the blocks, their order and titles, and your own wording — not this deal's information.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="teaser-template-name" className="text-xs">Name</Label>
            <Input id="teaser-template-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Brassline house style" maxLength={80} autoFocus data-testid="input-teaser-template-name" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={makeDefault} onCheckedChange={(v) => setMakeDefault(v === true)} />
            Use it for new teasers
          </label>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" className="bg-teal text-teal-foreground hover:bg-teal/90" disabled={!name.trim() || api.saveTemplate.isPending} data-testid="button-save-teaser-template">
              {api.saveTemplate.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Save template
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
