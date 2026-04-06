/**
 * TeamPanel — Manage deal teams (broker, seller, buyer).
 *
 * Firmex-style team management: add members by email, assign roles,
 * each role has specific permissions. Members get automatic notifications.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { TEAM_ROLES } from "@shared/schema";
import type { DealMember } from "@shared/schema";
import {
  Users, UserPlus, Mail, Phone, Shield, ChevronDown,
  ChevronRight, Trash2, Copy, Bell, BellOff, Loader2,
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

export function TeamPanel({ dealId }: TeamPanelProps) {
  const { toast } = useToast();
  const [expandedTeam, setExpandedTeam] = useState<TeamType | null>("broker");
  const [addingTo, setAddingTo] = useState<TeamType | null>(null);
  const [newMember, setNewMember] = useState({ email: "", name: "", phone: "", role: "" });

  const { data: members = [], isLoading } = useQuery<DealMember[]>({
    queryKey: ["/api/deals", dealId, "members"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/members`);
      if (!r.ok) return [];
      return r.json();
    },
  });

  const addMember = useMutation({
    mutationFn: async (data: { email: string; name: string; phone: string; teamType: string; role: string }) => {
      const r = await apiRequest("POST", `/api/deals/${dealId}/members`, data);
      if (!r.ok) {
        const err = await r.json();
        throw new Error(err.error || "Failed to add");
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "members"] });
      toast({ title: "Member added", description: "Invite notification sent." });
      setAddingTo(null);
      setNewMember({ email: "", name: "", phone: "", role: "" });
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const removeMember = useMutation({
    mutationFn: async (id: string) => {
      const r = await apiRequest("DELETE", `/api/members/${id}`);
      if (!r.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "members"] });
      toast({ title: "Member removed" });
    },
  });

  const toggleNotification = useMutation({
    mutationFn: async ({ id, field, value }: { id: string; field: string; value: boolean }) => {
      const r = await apiRequest("PATCH", `/api/members/${id}`, { [field]: value });
      if (!r.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "members"] });
    },
  });

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

  const renderTeam = (teamType: TeamType) => {
    const config = TEAM_CONFIG[teamType];
    const teamMembers = teams[teamType];
    const isExpanded = expandedTeam === teamType;
    const roles = TEAM_ROLES[teamType];
    const Icon = config.icon;

    return (
      <div key={teamType}>
        {/* Team header */}
        <button
          className="w-full flex items-center justify-between py-2 px-1 hover:bg-muted/30 rounded transition-colors"
          onClick={() => setExpandedTeam(isExpanded ? null : teamType)}
        >
          <div className="flex items-center gap-2">
            {isExpanded ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
              : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
            <Icon className={`h-3.5 w-3.5 ${config.color}`} />
            <span className="text-xs font-semibold">{config.label}</span>
            <Badge variant="outline" className="text-[9px] h-4 px-1.5">{teamMembers.length}</Badge>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px] gap-1 px-1.5"
            onClick={(e) => { e.stopPropagation(); setAddingTo(teamType); setExpandedTeam(teamType); }}
          >
            <UserPlus className="h-2.5 w-2.5" /> Add
          </Button>
        </button>

        {isExpanded && (
          <div className="pl-5 space-y-1.5 pb-2">
            {/* Add member form */}
            {addingTo === teamType && (
              <Card className="bg-muted/30 border-border/50">
                <CardContent className="p-2.5 space-y-2">
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input
                      placeholder="Email *"
                      className="h-7 text-xs"
                      value={newMember.email}
                      onChange={(e) => setNewMember({ ...newMember, email: e.target.value })}
                    />
                    <Input
                      placeholder="Name"
                      className="h-7 text-xs"
                      value={newMember.name}
                      onChange={(e) => setNewMember({ ...newMember, name: e.target.value })}
                    />
                  </div>
                  <Input
                    placeholder="Phone (for SMS notifications)"
                    className="h-7 text-xs"
                    value={newMember.phone}
                    onChange={(e) => setNewMember({ ...newMember, phone: e.target.value })}
                  />
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(roles).map(([key, val]) => (
                      <button
                        key={key}
                        className={`text-[10px] px-2 py-1 rounded-md border transition-colors ${
                          newMember.role === key
                            ? "bg-teal/10 border-teal text-teal"
                            : "border-border text-muted-foreground hover:border-foreground/30"
                        }`}
                        onClick={() => setNewMember({ ...newMember, role: key })}
                      >
                        {val.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      className="h-7 text-xs flex-1 bg-teal text-teal-foreground hover:bg-teal/90"
                      disabled={!newMember.email.trim() || !newMember.role || addMember.isPending}
                      onClick={() => addMember.mutate({
                        email: newMember.email,
                        name: newMember.name,
                        phone: newMember.phone,
                        teamType,
                        role: newMember.role,
                      })}
                    >
                      {addMember.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add & notify"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => setAddingTo(null)}
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
              return (
                <div
                  key={member.id}
                  className="flex items-center gap-2 p-2 rounded-md bg-card border border-border group"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs font-medium truncate">{member.name || member.email}</p>
                      <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0">
                        {roleConfig?.label || member.role}
                      </Badge>
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

                  {/* Notification toggles */}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      className={`h-5 w-5 rounded flex items-center justify-center ${
                        member.emailNotifications ? "text-teal" : "text-muted-foreground/40"
                      }`}
                      title={member.emailNotifications ? "Email notifications on" : "Email notifications off"}
                      onClick={() => toggleNotification.mutate({
                        id: member.id, field: "emailNotifications", value: !member.emailNotifications,
                      })}
                    >
                      <Mail className="h-2.5 w-2.5" />
                    </button>
                    <button
                      className={`h-5 w-5 rounded flex items-center justify-center ${
                        member.smsNotifications ? "text-teal" : "text-muted-foreground/40"
                      }`}
                      title={member.smsNotifications ? "SMS notifications on" : "SMS notifications off"}
                      onClick={() => toggleNotification.mutate({
                        id: member.id, field: "smsNotifications", value: !member.smsNotifications,
                      })}
                    >
                      <Phone className="h-2.5 w-2.5" />
                    </button>
                    <button
                      className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground/40 hover:text-red-400"
                      onClick={() => removeMember.mutate(member.id)}
                    >
                      <Trash2 className="h-2.5 w-2.5" />
                    </button>
                  </div>

                  {/* Status indicator */}
                  <div className="shrink-0">
                    {member.inviteStatus === "accepted" ? (
                      <span className="h-2 w-2 rounded-full bg-emerald-400 block" title="Active" />
                    ) : member.inviteStatus === "sent" ? (
                      <span className="h-2 w-2 rounded-full bg-amber-400 block" title="Invite sent" />
                    ) : (
                      <span className="h-2 w-2 rounded-full bg-muted-foreground/30 block" title="Pending" />
                    )}
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
    </div>
  );
}
