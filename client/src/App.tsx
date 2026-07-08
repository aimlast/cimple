import { useEffect, useState } from "react";
import { Switch, Route, useLocation, Router as WouterRouter } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider } from "@/components/ThemeProvider";
import { RoleProvider, useSetLayoutRole } from "@/contexts/RoleContext";
import { RoleSwitcher } from "@/components/dev/RoleSwitcher";
import NotFound from "@/pages/not-found";
import BrokerDashboard from "@/pages/BrokerDashboard";
import ActiveCIMs from "@/pages/ActiveCIMs";
import Analytics from "@/pages/Analytics";
import Settings from "@/pages/Settings";
import Support from "@/pages/Support";
import NewDeal from "@/pages/NewDeal";
import DealShell from "@/pages/broker/deal/DealShell";
import CIMInterview from "@/pages/CIMInterview";
import CIMDesigner from "@/pages/CIMDesigner";
import SellerApprovalPage from "@/pages/SellerApprovalPage";
import Integrations from "@/pages/Integrations";
import Buyers from "@/pages/Buyers";
import SellerLayout from "@/layouts/SellerLayout";
import SellerInterview from "@/pages/seller/SellerInterview";
import BuyerLayout from "@/layouts/BuyerLayout";
import BrokerLogin from "@/pages/broker/BrokerLogin";

/** Redirect helper — replaces current URL in history (for legacy bookmarks) */
function Redirect({ to }: { to: string }) {
  const [, nav] = useLocation();
  useEffect(() => { nav(to, { replace: true }); }, [to, nav]);
  return null;
}

function Routes() {
  return (
    <Switch>
      {/* ── Root (broker landing — dashboard) ── */}
      <Route path="/" component={BrokerDashboard} />

      {/* ── Canonical broker routes ── */}
      <Route path="/broker" component={BrokerDashboard} />
      <Route path="/broker/deals" component={ActiveCIMs} />
      <Route path="/broker/analytics" component={Analytics} />
      <Route path="/broker/buyers" component={Buyers} />
      <Route path="/broker/integrations" component={Integrations} />
      <Route path="/broker/settings" component={Settings} />
      <Route path="/broker/support" component={Support} />
      <Route path="/broker/new-deal" component={NewDeal} />
      {/* The legacy "New CIM" flow (separate cims table, dead-end interview,
          upload zone that discarded files) was removed — deal creation is
          the single flow. Old links land on the working equivalents. */}
      <Route path="/broker/templates">{() => <Redirect to="/broker/deals" />}</Route>
      <Route path="/broker/new-cim">{() => <Redirect to="/broker/new-deal" />}</Route>
      <Route path="/broker/cim/new-questionnaire">{() => <Redirect to="/broker/new-deal" />}</Route>
      <Route path="/broker/cim/new-documents">{() => <Redirect to="/broker/new-deal" />}</Route>
      <Route path="/broker/cim/new-interview">{() => <Redirect to="/broker/new-deal" />}</Route>
      <Route path="/broker/cim/:dealId/design" component={CIMDesigner} />
      <Route path="/broker/cim/:id/preview">{(params: { id: string }) => <Redirect to={`/deal/${params.id}`} />}</Route>
      <Route path="/broker/cim/:id">{(params: { id: string }) => <Redirect to={`/deal/${params.id}`} />}</Route>

      {/* Deal routes (already namespaced — no move needed) */}
      <Route path="/deal/:dealId/design" component={CIMDesigner} />
      <Route path="/deal/:id/:tab" component={DealShell} />
      <Route path="/deal/:id" component={DealShell} />

      {/* ── Legacy redirects (external links / bookmarks only) ── */}
      <Route path="/deals">{() => <Redirect to="/broker/deals" />}</Route>
      <Route path="/cims">{() => <Redirect to="/broker/deals" />}</Route>
      <Route path="/analytics">{() => <Redirect to="/broker/analytics" />}</Route>
      <Route path="/buyers">{() => <Redirect to="/broker/buyers" />}</Route>
      <Route path="/integrations">{() => <Redirect to="/broker/integrations" />}</Route>
      <Route path="/settings">{() => <Redirect to="/broker/settings" />}</Route>
      <Route path="/templates">{() => <Redirect to="/broker/deals" />}</Route>
      <Route path="/support">{() => <Redirect to="/broker/support" />}</Route>
      <Route path="/new-deal">{() => <Redirect to="/broker/new-deal" />}</Route>
      <Route path="/new-cim">{() => <Redirect to="/broker/new-deal" />}</Route>
      <Route path="/cim/new-questionnaire">{() => <Redirect to="/broker/new-deal" />}</Route>
      <Route path="/cim/new-documents">{() => <Redirect to="/broker/new-deal" />}</Route>
      <Route path="/cim/new-interview">{() => <Redirect to="/broker/new-deal" />}</Route>
      <Route path="/cim/:id/preview">{(params: { id: string }) => <Redirect to={`/broker/cim/${params.id}/preview`} />}</Route>
      <Route path="/cim/:dealId/design">{(params: { dealId: string }) => <Redirect to={`/broker/cim/${params.dealId}/design`} />}</Route>
      <Route path="/cim/:id">{(params: { id: string }) => <Redirect to={`/broker/cim/${params.id}`} />}</Route>

      <Route component={NotFound} />
    </Switch>
  );
}

/**
 * Fullscreen detection — routes that render without any role-specific layout.
 *
 * Only interviews and standalone token pages (seller approval, legacy
 * invite redirect) render here. All other external-facing pages have
 * their own layout (SellerLayout, BuyerLayout).
 */
function isFullscreen(path: string) {
  // Interview pages are fullscreen — but NOT /interview-review (that's a tab)
  if (path.endsWith("/interview")) return true;
  // Legacy seller invite redirect
  if (path.startsWith("/invite/")) return true;
  // Seller Q&A approval (standalone page, own token table)
  if (path.startsWith("/approve/")) return true;
  return false;
}

/**
 * BrokerAuthGate — broker pages require a broker session.
 *
 * Order of attempts: (1) existing session via /api/broker-auth/me,
 * (2) one dev auto-login attempt (available in local dev and when
 * ENABLE_DEV_SWITCHER=true on the deploy — keeps the demo flow
 * zero-login), (3) the sign-in screen, rendered in place so the deep
 * link survives login.
 */
function BrokerAuthGate({ children }: { children: React.ReactNode }) {
  const { data: me, isLoading, refetch } = useQuery<{ user: unknown } | null>({
    queryKey: ["/api/broker-auth/me"],
    queryFn: async () => {
      const res = await fetch("/api/broker-auth/me", { credentials: "include" });
      if (res.status === 401) return null;
      if (!res.ok) throw new Error("Auth check failed");
      return res.json();
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const [devAttempt, setDevAttempt] = useState<"idle" | "pending" | "done">("idle");

  useEffect(() => {
    if (!isLoading && me === null && devAttempt === "idle") {
      setDevAttempt("pending");
      fetch("/api/dev/login-as-broker", { method: "POST", credentials: "include" })
        .then((r) => (r.ok ? refetch() : undefined))
        .catch(() => {})
        .finally(() => setDevAttempt("done"));
    }
  }, [isLoading, me, devAttempt, refetch]);

  if (isLoading || devAttempt === "pending") {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-background">
        <div className="flex gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce" />
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "0.15s" }} />
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "0.3s" }} />
        </div>
      </div>
    );
  }
  if (me === null) return <BrokerLogin />;
  return <>{children}</>;
}

function BrokerLayout() {
  useSetLayoutRole("broker");
  return (
    <BrokerAuthGate>
      <SidebarProvider defaultOpen={false} style={{ "--sidebar-width": "14rem", "--sidebar-width-icon": "3rem" } as React.CSSProperties}>
        <div className="flex h-screen w-full overflow-hidden bg-background">
          <AppSidebar />
          <main className="flex-1 min-w-0 overflow-auto scrollbar-thin">
            <Routes />
          </main>
        </div>
      </SidebarProvider>
    </BrokerAuthGate>
  );
}

function FullscreenLayout() {
  const [loc] = useLocation();
  // Derive role from URL pattern
  const fsRole =
    loc.startsWith("/seller/") || loc.startsWith("/invite/") || loc.startsWith("/approve/")
      ? "seller" as const
      : "broker" as const; // /deal/:id/interview is broker
  useSetLayoutRole(fsRole);

  return (
    <div className="h-screen w-full overflow-auto bg-background">
      <Switch>
        {/* Broker interview */}
        <Route path="/deal/:id/interview" component={CIMInterview} />
        {/* Seller interview (fullscreen) */}
        <Route path="/seller/:token/interview" component={SellerInterview} />
        {/* Legacy seller invite redirect → /seller/:token */}
        <Route path="/invite/:token">{(params: { token: string }) => <Redirect to={`/seller/${params.token}`} />}</Route>
        {/* Seller Q&A approval (standalone) */}
        <Route path="/approve/:token" component={SellerApprovalPage} />
        <Route component={NotFound} />
      </Switch>
    </div>
  );
}

/**
 * AppContent — Four-layout architecture.
 *
 * Detection order (first match wins):
 * 1. isFullscreen() → FullscreenLayout (interviews, seller approval, legacy redirects)
 * 2. /seller/* → SellerLayout (seller intake, progress, documents)
 * 3. /buyer/* | /view/* | /review/* → BuyerLayout (auth, dashboard, view room)
 * 4. Everything else → BrokerLayout (sidebar + main content)
 */
function AppContent() {
  const [location] = useLocation();
  if (isFullscreen(location)) return <FullscreenLayout />;
  if (location.startsWith("/seller/")) return <SellerLayout />;
  if (location.startsWith("/buyer/") || location.startsWith("/view/") || location.startsWith("/review/")) return <BuyerLayout />;
  return <BrokerLayout />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider forcedTheme="light" enableSystem={false}>
        <TooltipProvider>
          <RoleProvider>
            <WouterRouter>
              <AppContent />
              <RoleSwitcher />
            </WouterRouter>
          </RoleProvider>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
