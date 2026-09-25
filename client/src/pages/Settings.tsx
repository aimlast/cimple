import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { 
  Save, 
  User, 
  Bell, 
  Palette, 
  Settings2, 
  Link2, 
  Shield,
  Mail,
  Building,
  AlertCircle,
  RefreshCw,
  MessageSquare,
  Gavel,
  UserCheck,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import type { BrandingSettings } from "@shared/schema";
import { BrandSettingsCard } from "@/components/cim-design/BrandSettingsCard";
import { TemplateGallery } from "@/components/cim-design/TemplateGallery";

/**
 * Broker email preferences. Every switch here controls real events — the
 * `key` is what server/notifications/service.ts (BROKER_EVENT_PREFERENCE)
 * reads before emailing a broker-team member, and `events` lists the
 * NOTIFICATION_ROUTING event types it covers. Keep both files in sync.
 */
type NotificationPrefKey = "buyerQuestions" | "buyerDecisions" | "buyerApprovals";
const NOTIFICATION_PREFERENCES: Array<{
  key: NotificationPrefKey;
  title: string;
  description: string;
  icon: typeof Mail;
  events: string[];
}> = [
  {
    key: "buyerQuestions",
    title: "Buyer questions",
    description: "A buyer asks something in the view room that the Q&A assistant couldn't answer and needs your reply.",
    icon: MessageSquare,
    events: ["buyer_question"],
  },
  {
    key: "buyerDecisions",
    title: "Buyer decisions",
    description: "A buyer marks themselves interested or not interested, or their decision lapses after the reminder sequence.",
    icon: Gavel,
    events: ["buyer_decision_interested", "buyer_decision_not_interested", "buyer_decision_lapsed"],
  },
  {
    key: "buyerApprovals",
    title: "Buyer approval workflow",
    description: "A buyer is submitted for review, the seller approves them, or a submission is rejected.",
    icon: UserCheck,
    events: ["buyer_approval_requested", "buyer_approval_seller_approved", "buyer_approval_rejected"],
  },
];
const DEFAULT_NOTIFICATION_PREFS: Record<NotificationPrefKey, boolean> = {
  buyerQuestions: true,
  buyerDecisions: true,
  buyerApprovals: true,
};

/** Pull the server's `error` message out of a failed response. */
async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (body?.error) return String(body.error);
    if (body?.message) return String(body.message);
  } catch {
    // non-JSON body
  }
  return `${fallback} (${res.status})`;
}

const SETTINGS_TABS = ["account", "notifications", "brand", "defaults", "integrations"];

export default function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // ?tab=brand opens straight on a tab (the CIM builder links there).
  const [initialTab] = useState(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return t && SETTINGS_TABS.includes(t) ? t : "account";
  });

  const {
    data: brandingSettings,
    isLoading,
    error: brandingError,
    refetch: refetchBranding,
    isFetching: brandingFetching,
  } = useQuery<BrandingSettings | null>({
    queryKey: ["/api/branding"],
  });

  const [firmName, setFirmName] = useState("");
  const [firmEmail, setFirmEmail] = useState("");
  const [firmPhone, setFirmPhone] = useState("");

  const [notificationPrefs, setNotificationPrefs] =
    useState<Record<NotificationPrefKey, boolean>>(DEFAULT_NOTIFICATION_PREFS);

  const [defaultExpiration, setDefaultExpiration] = useState("30");

  // Broker workspace prefs (firm info, notifications, deal defaults) —
  // persisted on the user row via /api/broker-auth/settings.
  const {
    data: brokerSettings,
    error: settingsError,
    refetch: refetchSettings,
    isFetching: settingsFetching,
  } = useQuery<{ settings: Record<string, any> }>({
    queryKey: ["/api/broker-auth/settings"],
    queryFn: async () => {
      const r = await fetch("/api/broker-auth/settings", { credentials: "include" });
      if (!r.ok) throw new Error(await readErrorMessage(r, "Failed to load settings"));
      return r.json();
    },
  });

  // Notification emails go to the broker account's email (set when the
  // account was created). Shown read-only so the broker knows where they land.
  const { data: me } = useQuery<{ user: { email: string | null; username: string } }>({
    queryKey: ["/api/broker-auth/me"],
    queryFn: async () => {
      const r = await fetch("/api/broker-auth/me", { credentials: "include" });
      if (!r.ok) throw new Error(await readErrorMessage(r, "Failed to load account"));
      return r.json();
    },
  });
  const accountEmail = me?.user?.email ?? null;

  useEffect(() => {
    const s = brokerSettings?.settings;
    if (!s) return;
    if (s.firmName !== undefined) setFirmName(s.firmName);
    if (s.firmEmail !== undefined) setFirmEmail(s.firmEmail);
    if (s.firmPhone !== undefined) setFirmPhone(s.firmPhone);
    const n = (s.notifications ?? {}) as Partial<Record<NotificationPrefKey, boolean>>;
    setNotificationPrefs({
      buyerQuestions: n.buyerQuestions ?? DEFAULT_NOTIFICATION_PREFS.buyerQuestions,
      buyerDecisions: n.buyerDecisions ?? DEFAULT_NOTIFICATION_PREFS.buyerDecisions,
      buyerApprovals: n.buyerApprovals ?? DEFAULT_NOTIFICATION_PREFS.buyerApprovals,
    });
    const d = s.dealDefaults ?? {};
    if (d.expirationDays !== undefined) setDefaultExpiration(String(d.expirationDays));
  }, [brokerSettings]);

  const [pwDialogOpen, setPwDialogOpen] = useState(false);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");

  const changePassword = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/broker-auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ currentPassword: pwCurrent, newPassword: pwNew }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || "Failed to change password");
      }
      return r.json();
    },
    onSuccess: () => {
      setPwDialogOpen(false);
      setPwCurrent(""); setPwNew(""); setPwConfirm("");
      toast({ title: "Password changed", description: "Use your new password next time you sign in." });
    },
    onError: (e: Error) =>
      toast({ title: "Couldn't change password", description: e.message, variant: "destructive" }),
  });

  const saveSettings = useMutation({
    mutationFn: async (patch: Record<string, any>) => {
      const r = await fetch("/api/broker-auth/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(await readErrorMessage(r, "Failed to save settings"));
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/broker-auth/settings"] });
    },
    onError: (e: Error) =>
      toast({
        title: "Save failed",
        description: e.message || "Your settings could not be saved. Please try again.",
        variant: "destructive",
      }),
  });

  const handleSaveAccount = () => {
    saveSettings.mutate(
      { firmName, firmEmail, firmPhone },
      { onSuccess: () => toast({ title: "Account saved", description: "Your firm information has been updated." }) },
    );
  };

  const handleSaveNotifications = () => {
    saveSettings.mutate(
      { notifications: { ...notificationPrefs } },
      { onSuccess: () => toast({ title: "Notifications saved", description: "Your email preferences now apply to every deal you're on." }) },
    );
  };

  const handleSaveDefaults = () => {
    saveSettings.mutate(
      {
        dealDefaults: {
          expirationDays: parseInt(defaultExpiration, 10) || 30,
        },
      },
      { onSuccess: () => toast({ title: "Defaults saved", description: "New buyer links will use this expiration." }) },
    );
  };

  const loadError = brandingError || settingsError;
  const retryLoad = () => {
    if (brandingError) refetchBranding();
    if (settingsError) refetchSettings();
  };
  const retrying = brandingFetching || settingsFetching;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center space-y-2">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-teal mx-auto"></div>
          <p className="text-sm text-muted-foreground">Loading settings...</p>
        </div>
      </div>
    );
  }

  // A failed load must not look like a blank form — saving on top of
  // unknown state could create a duplicate branding row or wipe prefs.
  if (loadError) {
    return (
      <div className="px-6 pt-6 pb-12 max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage your account, preferences, and platform settings
          </p>
        </div>
        <div
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center"
          role="alert"
          data-testid="settings-error"
        >
          <AlertCircle className="h-6 w-6 text-destructive mx-auto mb-3" />
          <p className="text-sm font-medium text-foreground">Couldn't load your settings</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            {loadError instanceof Error && loadError.message
              ? loadError.message
              : "The server didn't respond. Check your connection and try again."}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={retryLoad}
            disabled={retrying}
            className="mt-5"
            data-testid="button-retry-settings"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${retrying ? "animate-spin" : ""}`} />
            {retrying ? "Retrying..." : "Retry"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 pt-6 pb-12 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Manage your account, preferences, and platform settings
        </p>
      </div>

      <Tabs defaultValue={initialTab} className="w-full">
        <TabsList className="flex w-full justify-start overflow-x-auto scrollbar-hide sm:grid sm:grid-cols-5">
          <TabsTrigger value="account" className="flex shrink-0 items-center gap-2">
            <User className="h-4 w-4" />
            Account
          </TabsTrigger>
          <TabsTrigger value="notifications" className="flex shrink-0 items-center gap-2">
            <Bell className="h-4 w-4" />
            Notifications
          </TabsTrigger>
          <TabsTrigger value="brand" className="flex shrink-0 items-center gap-2" data-testid="tab-brand">
            <Palette className="h-4 w-4" />
            <span className="hidden sm:inline">Brand &amp; templates</span>
            <span className="sm:hidden">Brand</span>
          </TabsTrigger>
          <TabsTrigger value="defaults" className="flex shrink-0 items-center gap-2">
            <Settings2 className="h-4 w-4" />
            Defaults
          </TabsTrigger>
          <TabsTrigger value="integrations" className="flex shrink-0 items-center gap-2">
            <Link2 className="h-4 w-4" />
            Integrations
          </TabsTrigger>
        </TabsList>

        <TabsContent value="account" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building className="h-5 w-5" />
                Firm Information
              </CardTitle>
              <CardDescription>Your brokerage or firm details</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="firm-name">Firm Name</Label>
                <Input
                  id="firm-name"
                  placeholder="ABC Business Brokers"
                  value={firmName}
                  onChange={(e) => setFirmName(e.target.value)}
                  data-testid="input-firm-name"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="firm-email">Contact Email</Label>
                  <Input
                    id="firm-email"
                    type="email"
                    placeholder="info@abcbrokers.com"
                    value={firmEmail}
                    onChange={(e) => setFirmEmail(e.target.value)}
                    data-testid="input-firm-email"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="firm-phone">Phone Number</Label>
                  <Input
                    id="firm-phone"
                    placeholder="(555) 123-4567"
                    value={firmPhone}
                    onChange={(e) => setFirmPhone(e.target.value)}
                    data-testid="input-firm-phone"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Security
              </CardTitle>
              <CardDescription>Account security settings</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Change Password</p>
                  <p className="text-sm text-muted-foreground">Update your account password</p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => setPwDialogOpen(true)}
                  data-testid="button-change-password"
                >
                  Change
                </Button>
              </div>
            </CardContent>
          </Card>

          <Dialog open={pwDialogOpen} onOpenChange={setPwDialogOpen}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Change password</DialogTitle>
                <DialogDescription>
                  Enter your current password, then choose a new one (at least 8 characters).
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 py-1">
                <div>
                  <Label htmlFor="pw-current" className="text-xs text-muted-foreground">Current password</Label>
                  <Input id="pw-current" type="password" autoComplete="current-password" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="pw-new" className="text-xs text-muted-foreground">New password</Label>
                  <Input id="pw-new" type="password" autoComplete="new-password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="pw-confirm" className="text-xs text-muted-foreground">Confirm new password</Label>
                  <Input id="pw-confirm" type="password" autoComplete="new-password" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} className="mt-1" />
                </div>
                {pwNew && pwConfirm && pwNew !== pwConfirm && (
                  <p className="text-xs text-destructive">Passwords don't match.</p>
                )}
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setPwDialogOpen(false)}>Cancel</Button>
                <Button
                  className="bg-teal text-teal-foreground hover:bg-teal/90"
                  disabled={changePassword.isPending || !pwCurrent || pwNew.length < 8 || pwNew !== pwConfirm}
                  onClick={() => changePassword.mutate()}
                  data-testid="button-confirm-change-password"
                >
                  {changePassword.isPending ? "Saving..." : "Change password"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <div className="flex justify-end">
            <Button
              onClick={handleSaveAccount}
              disabled={saveSettings.isPending}
              className="bg-teal text-teal-foreground hover:bg-teal/90"
              data-testid="button-save-account"
            >
              <Save className="h-4 w-4 mr-2" />
              {saveSettings.isPending ? "Saving..." : "Save Account Settings"}
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="notifications" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mail className="h-5 w-5" />
                Email Notifications
              </CardTitle>
              <CardDescription>
                Choose which deal events email you. These apply on every deal where you're on the
                broker team
                {accountEmail ? (
                  <> and go to <span className="font-medium text-foreground">{accountEmail}</span>.</>
                ) : (
                  <>. Your account has no email on file, so nothing can be delivered until one is added — contact support.</>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {NOTIFICATION_PREFERENCES.map((pref, i) => (
                <div key={pref.key}>
                  {i > 0 && <Separator className="mb-6" />}
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-start gap-3 min-w-0">
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-muted text-teal">
                        <pref.icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="font-medium">{pref.title}</p>
                        <p className="text-sm text-muted-foreground">{pref.description}</p>
                      </div>
                    </div>
                    <Switch
                      checked={notificationPrefs[pref.key]}
                      onCheckedChange={(v) => setNotificationPrefs((prev) => ({ ...prev, [pref.key]: v }))}
                      aria-label={pref.title}
                      data-testid={`switch-email-${pref.key}`}
                    />
                  </div>
                </div>
              ))}
              <Separator />
              <p className="text-xs text-muted-foreground">
                Team invites and seller- or buyer-facing emails aren't affected by these switches. Per-deal
                email and SMS toggles for each team member live on the deal's Team tab.
              </p>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button
              onClick={handleSaveNotifications}
              disabled={saveSettings.isPending}
              className="bg-teal text-teal-foreground hover:bg-teal/90"
              data-testid="button-save-notifications"
            >
              <Save className="h-4 w-4 mr-2" />
              {saveSettings.isPending ? "Saving..." : "Save Notification Settings"}
            </Button>
          </div>
        </TabsContent>

        {/* CIM look: the brokerage brand (every CIM, every template) and
            the templates themselves. The business-for-sale's branding is
            per deal (CIM builder → Design). */}
        <TabsContent value="brand" className="mt-6 space-y-6">
          <BrandSettingsCard
            branding={brandingSettings}
            account={{ firmName, firmEmail, firmPhone }}
            contactName={(me?.user as { name?: string | null } | undefined)?.name ?? null}
          />
          <TemplateGallery />
        </TabsContent>

        <TabsContent value="defaults" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings2 className="h-5 w-5" />
                Deal Defaults
              </CardTitle>
              <CardDescription>Default settings for new deals</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label>Default Buyer Link Expiration</Label>
                <Select value={defaultExpiration} onValueChange={setDefaultExpiration}>
                  <SelectTrigger data-testid="select-default-expiration">
                    <SelectValue />
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
                  Applies to every new buyer access link you create. Existing links keep their
                  current expiry — extend them from the deal's Buyers tab.
                </p>
              </div>
              <Separator />
              <div className="flex items-center justify-between gap-4 opacity-70">
                <div>
                  <p className="font-medium flex items-center gap-2">
                    Require NDA Before Phase 2
                    <Badge variant="outline" className="text-2xs font-normal">Coming soon</Badge>
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Will pre-set "NDA required" on every new deal. Today, set it per deal when you
                    create one.
                  </p>
                </div>
                <Switch checked={false} disabled aria-label="Require NDA before Phase 2 (coming soon)" data-testid="switch-require-nda" />
              </div>
              <Separator />
              <div className="flex items-center justify-between gap-4 opacity-70">
                <div>
                  <p className="font-medium flex items-center gap-2">
                    Auto-Advance Phases
                    <Badge variant="outline" className="text-2xs font-normal">Coming soon</Badge>
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Will move deals to the next phase automatically once requirements are met. Today,
                    you advance each phase from the deal's Overview.
                  </p>
                </div>
                <Switch checked={false} disabled aria-label="Auto-advance phases (coming soon)" data-testid="switch-auto-advance" />
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button
              onClick={handleSaveDefaults}
              disabled={saveSettings.isPending}
              className="bg-teal text-teal-foreground hover:bg-teal/90"
              data-testid="button-save-defaults"
            >
              <Save className="h-4 w-4 mr-2" />
              {saveSettings.isPending ? "Saving..." : "Save Default Settings"}
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="integrations" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Link2 className="h-5 w-5" />
                Integrations
              </CardTitle>
              <CardDescription>
                Email, CRM, and call-recording connections are managed on the
                Integrations page.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="outline"
                onClick={() => (window.location.href = "/broker/integrations")}
                data-testid="button-open-integrations"
              >
                Open Integrations
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
