/**
 * TeamPanel — Manage deal teams (broker, seller, buyer).
 *
 * Firmex-style team management: add members by email, assign roles,
 * each role has specific permissions. Members get automatic notifications.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { PanelError } from "@/components/deal/PanelError";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { TEAM_ROLES } from "@shared/schema";
import type { DealMember } from "@shared/schema";
import {
  Users, UserPlus, Mail, Phone, ChevronDown,
  ChevronRight, Trash2, Loader2,
  Briefcase, Building, ShoppingCart,
} from "lucide-react";

interface TeamPanelProps {
  dealId: string;
}

const TEAM_CONFIG = {
  broker: { label: "Broker Team", icon: Briefcase, color: "text-teal" },
  seller: { label: "Seller Team", icon: Building, color: "text-amber-400" },
  buyer: { label: "Buyer Team", icon: ShoppingCart, color: "text-blue-400" },
} as const;

type TeamType = keyof typeof TEAM_CONFIG;

/**
 * Plain fetch wrapper that surfaces the server's `{ error }` message.
 * (apiRequest throws "409: {...json...}" before a caller can read the body,
 * which is how duplicate-member errors used to render as raw JSON.)
 */
async function requestJson<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  if (!res.ok) {
    let message = res.status === 401
      ? "Your session has expired — please sign in again."
      : `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = String(data.error);
    } catch {
      // non-JSON error body — keep the status-based message
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString();
}

export function TeamPanel({ dealId }: TeamPanelProps) {
  const { toast } = useToast();
  const [expandedTeam, setExpandedTeam] = useState<TeamType | null>("broker");
  const [addingTo, setAddingTo] = useState<TeamType | null>(null);
  const [newMember, setNewMember] = useState({ email: "", name: "", phone: "", role: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [memberToRemove, setMemberToRemove] = useState<DealMember | null>(null);

  const { data: members = [], isLoading, error: loadError, refetch } = useQuery<DealMember[]>({
    queryKey: ["/api/deals", dealId, "members"],
    queryFn: () => requestJson<DealMember[]>("GET", `/api/deals/${dealId}/members`),
  });

  const addMember = useMutation({
    mutationFn: (data: { email: string; name: string; phone: string; teamType: string; role: string }) =>
      requestJson<DealMember>("POST", `/api/deals/${dealId}/members`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "members"] });
      toast({ title: "Member added", description: "Invite notification sent." });
      setAddingTo(null);
      setNewMember({ email: "", name: "", phone: "", role: "" });
      setFormError(null);
    },
    onError: (e: Error) => toast({ title: "Couldn't add member", description: e.message, variant: "destructive" }),
  });

  const removeMember = useMutation({
    mutationFn: (id: string) => requestJson("DELETE", `/api/members/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "members"] });
      toast({ title: "Member removed" });
      setMemberToRemove(null);
    },
    onError: (e: Error) => toast({ title: "Couldn't remove member", description: e.message, variant: "destructive" }),
  });

  // Roles were fixed at invite time — the server validates the new role
  // against the member's team and carries its permissions across.
  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) =>
      requestJson<DealMember>("PATCH", `/api/members/${id}`, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "members"] });
      toast({ title: "Role updated" });
    },
    onError: (e: Error) => toast({ title: "Couldn't change role", description: e.message, variant: "destructive" }),
  });

  const toggleNotification = useMutation({
    mutationFn: ({ id, field, value }: { id: string; field: "emailNotifications" | "smsNotifications"; value: boolean }) =>
      requestJson<DealMember>("PATCH", `/api/members/${id}`, { [field]: value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "members"] });
    },
    onError: (e: Error) => toast({ title: "Couldn't update notifications", description: e.message, variant: "destructive" }),
  });

  const submitNewMember = (teamType: TeamType) => {
    if (!newMember.email.trim()) {
      setFormError("Enter an email address for this member.");
      return;
    }
    if (!newMember.role) {
      setFormError("Select a role for this member.");
      return;
    }
    setFormError(null);
    addMember.mutate({
      email: newMember.email,
      name: newMember.name,
      phone: newMember.phone,
      teamType,
      role: newMember.role,
    });
  };

  // Group members by team
  const teams: Record<TeamType, DealMember[]> = {
    broker: members.filter(m => m.teamType === "broker"),
    seller: members.filter(m => m.teamType === "seller"),
    buyer: members.filter(m => m.teamType === "buyer"),
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError) {
    return <PanelError what="team members" onRetry={() => refetch()} />;
  }

  const renderTeam = (teamType: TeamType) => {
    const config = TEAM_CONFIG[teamType];
    const teamMembers = teams[teamType];
    const isExpanded = expandedTeam === teamType;
    const roles = TEAM_ROLES[teamType];
    const Icon = config.icon;

    return (
      <div key={teamType}>
        {/* Team header — the expand toggle and the Add button are siblings
            (a <button> nested inside a <button> is invalid DOM and breaks
            keyboard / screen-reader semantics). */}
        <div className="flex items-center justify-between py-1 px-1 hover:bg-muted/30 rounded transition-colors">
          <button
            type="button"
            className="flex flex-1 items-center gap-2 py-1 text-left rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-expanded={isExpanded}
            onClick={() => setExpandedTeam(isExpanded ? null : teamType)}
          >
            {isExpanded ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
              : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
            <Icon className={`h-3.5 w-3.5 ${config.color}`} />
            <span className="text-xs font-semibold">{config.label}</span>
            <Badge variant="outline" className="text-[9px] h-4 px-1.5">{teamMembers.length}</Badge>
          </button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px] gap-1 px-1.5"
            onClick={() => { setAddingTo(teamType); setExpandedTeam(teamType); setFormError(null); }}
          >
            <UserPlus className="h-2.5 w-2.5" /> Add
          </Button>
        </div>

        {isExpanded && (
          <div className="pl-5 space-y-1.5 pb-2">
            {/* Add member form */}
            {addingTo === teamType && (
              <Card className="bg-muted/30 border-border/50">
                <CardContent className="p-2.5 space-y-2">
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      placeholder="Email *"
                      type="email"
                      aria-label="Email (required)"
                      className="h-7 text-xs"
                      value={newMember.email}
                      onChange={(e) => { setNewMember({ ...newMember, email: e.target.value }); setFormError(null); }}
                    />
                    <Input
                      placeholder="Name"
                      aria-label="Name"
                      className="h-7 text-xs"
                      value={newMember.name}
                      onChange={(e) => setNewMember({ ...newMember, name: e.target.value })}
                    />
                  </div>
                  <Input
                    placeholder="Phone (for SMS notifications)"
                    aria-label="Phone"
                    className="h-7 text-xs"
                    value={newMember.phone}
                    onChange={(e) => setNewMember({ ...newMember, phone: e.target.value })}
                  />
                  <div className="space-y-1">
                    <p className="text-[10px] font-medium text-muted-foreground">Role *</p>
                    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Role">
                      {Object.entries(roles).map(([key, val]) => (
                        <button
                          key={key}
                          type="button"
                          role="radio"
                          aria-checked={newMember.role === key}
                          className={`text-[10px] px-2 py-1 rounded-md border transition-colors ${
                            newMember.role === key
                              ? "bg-teal/10 border-teal text-teal"
                              : "border-border text-muted-foreground hover:border-foreground/30"
                          }`}
                          onClick={() => { setNewMember({ ...newMember, role: key }); setFormError(null); }}
                        >
                          {val.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {formError && (
                    <p className="text-[10px] text-destructive" role="alert">{formError}</p>
                  )}
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      className="h-7 text-xs flex-1 bg-teal text-teal-foreground hover:bg-teal/90"
                      disabled={addMember.isPending}
                      onClick={() => submitNewMember(teamType)}
                    >
                      {addMember.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add & notify"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => { setAddingTo(null); setFormError(null); }}
                    >
                      Cancel
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Member list */}
            {teamMembers.length === 0 && addingTo !== teamType && (
              <p className="text-[10px] text-muted-foreground/60 py-2">No members yet</p>
            )}

            {teamMembers.map((member) => {
              const roleConfig = (roles as any)[member.role] as { label: string; permissions: string[] } | undefined;
              const isToggling = toggleNotification.isPending && toggleNotification.variables?.id === member.id;
              const isChangingRole = changeRole.isPending && changeRole.variables?.id === member.id;
              return (
                <div
                  key={member.id}
                  className="flex items-center gap-2 p-2 rounded-md bg-card border border-border"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs font-medium truncate">{member.name || member.email}</p>
                      {/* Inline role editor — styled as the badge it replaces */}
                      <Select
                        value={member.role}
                        disabled={isChangingRole}
                        onValueChange={(role) => {
                          if (role !== member.role) changeRole.mutate({ id: member.id, role });
                        }}
                      >
                        <SelectTrigger
                          className="h-4 w-auto shrink-0 gap-0.5 rounded-md border-border px-1 py-0 text-[9px] font-semibold bg-transparent [&>svg]:h-2.5 [&>svg]:w-2.5"
                          aria-label={`Role for ${member.name || member.email}`}
                          title="Change role"
                        >
                          <SelectValue>{roleConfig?.label || member.role}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(roles).map(([key, val]) => (
                            <SelectItem key={key} value={key} className="text-xs">
                              {val.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-muted-foreground truncate flex items-center gap-0.5">
                        <Mail className="h-2 w-2" /> {member.email}
                      </span>
                      {member.phone && (
                        <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                          <Phone className="h-2 w-2" /> {member.phone}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Notification toggles — always visible so they work on touch devices */}
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      disabled={isToggling}
                      aria-pressed={!!member.emailNotifications}
                      aria-label={member.emailNotifications ? "Turn email notifications off" : "Turn email notifications on"}
                      className={`h-6 w-6 rounded flex items-center justify-center transition-colors hover:bg-muted disabled:opacity-50 ${
                        member.emailNotifications ? "text-teal" : "text-muted-foreground/40"
                      }`}
                      title={member.emailNotifications ? "Email notifications on" : "Email notifications off"}
                      onClick={() => toggleNotification.mutate({
                        id: member.id, field: "emailNotifications", value: !member.emailNotifications,
                      })}
                    >
                      <Mail className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      disabled={isToggling}
                      aria-pressed={!!member.smsNotifications}
                      aria-label={member.smsNotifications ? "Turn SMS notifications off" : "Turn SMS notifications on"}
                      className={`h-6 w-6 rounded flex items-center justify-center transition-colors hover:bg-muted disabled:opacity-50 ${
                        member.smsNotifications ? "text-teal" : "text-muted-foreground/40"
                      }`}
                      title={member.smsNotifications ? "SMS notifications on" : "SMS notifications off"}
                      onClick={() => toggleNotification.mutate({
                        id: member.id, field: "smsNotifications", value: !member.smsNotifications,
                      })}
                    >
                      <Phone className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${member.name || member.email} from the ${config.label.toLowerCase()}`}
                      className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground/40 hover:text-red-400 hover:bg-muted transition-colors"
                      title="Remove member"
                      onClick={() => setMemberToRemove(member)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>

                  {/* Invite status — only the state that can actually occur.
                      No accept flow sets dealMembers.acceptedAt yet, so an
                      "Active" state would never render; show the factual
                      invite date instead of a status that can't change. */}
                  <div className="shrink-0 text-[10px] text-muted-foreground/70 tabular-nums whitespace-nowrap">
                    {member.invitedAt
                      ? <span title={`Invite sent ${fmtDate(member.invitedAt)}`}>Invited {fmtDate(member.invitedAt)}</span>
                      : <span>Invited</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 mb-2">
        <Users className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-xs font-semibold">Deal Team</h3>
        <Badge variant="outline" className="text-[9px] h-4">{members.length} members</Badge>
      </div>

      {(["broker", "seller", "buyer"] as const).map(renderTeam)}

      {/* Confirm before a hard delete — the server removes the row permanently */}
      <AlertDialog
        open={!!memberToRemove}
        onOpenChange={(open) => { if (!open && !removeMember.isPending) setMemberToRemove(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {memberToRemove?.name || memberToRemove?.email} from the{" "}
              {memberToRemove ? TEAM_CONFIG[memberToRemove.teamType as TeamType]?.label.toLowerCase() ?? "deal team" : "deal team"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They will stop receiving notifications for this deal immediately. This cannot be undone —
              you would need to invite them again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeMember.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={removeMember.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (memberToRemove) removeMember.mutate(memberToRemove.id);
              }}
            >
              {removeMember.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
