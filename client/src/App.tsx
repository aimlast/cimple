import { useEffect, useState } from "react";
import { Switch, Route, useLocation, Router as WouterRouter } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { AppSidebar, BrokerMobileHeader, BROKER_LOGGED_OUT_KEY } from "@/components/app-sidebar";
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
import SellerNdaPage from "@/pages/SellerNdaPage";
import Integrations from "@/pages/Integrations";
import Buyers from "@/pages/Buyers";
import SellerLayout from "@/layouts/SellerLayout";
import SellerInterview from "@/pages/seller/SellerInterview";
import BuyerLayout from "@/layouts/BuyerLayout";
import BrokerLogin from "@/pages/broker/BrokerLogin";
import BrokerResetPassword from "@/pages/broker/BrokerResetPassword";

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
 * Only interviews and standalone token pages (seller approval, NDA e-sign,
 * legacy invite redirect) render here. All other external-facing pages have
 * their own layout (SellerLayout, BuyerLayout).
 */
function isFullscreen(path: string) {
  // Interview pages are fullscreen — but NOT /interview-review (that's a tab)
  if (path.endsWith("/interview")) return true;
  // Legacy seller invite redirect
  if (path.startsWith("/invite/")) return true;
  // Seller Q&A approval (standalone page, own token table)
  if (path.startsWith("/approve/")) return true;
  // Seller NDA e-sign (standalone token page)
  if (path.startsWith("/sign-nda/")) return true;
  return false;
}

/* ═══════════════════════════════════════════
   BROKER SESSION
═══════════════════════════════════════════ */

interface BrokerMe {
  user: { id: string; username: string; [key: string]: unknown };
}

/**
 * Shared /api/broker-auth/me query. Resolves to `null` on 401 (no session),
 * throws on any other failure so the gate can show a retry panel instead of
 * rendering the app without a session.
 */
const BROKER_ME_QUERY = {
  queryKey: ["/api/broker-auth/me"] as const,
  queryFn: async (): Promise<BrokerMe | null> => {
    const res = await fetch("/api/broker-auth/me", { credentials: "include" });
    if (res.status === 401) return null;
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error || `Couldn't verify your session (${res.status})`);
    }
    return res.json();
  },
  retry: false,
  staleTime: 5 * 60 * 1000,
};

function AuthPending() {
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

function AuthError({ message, onRetry, retrying }: { message: string; onRetry: () => void; retrying: boolean }) {
  return (
    <div className="h-screen w-full flex items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm rounded-xl border border-card-border bg-card p-6 text-center" data-testid="panel-auth-error">
        <AlertCircle className="h-8 w-8 text-amber-500/70 mx-auto mb-3" />
        <p className="text-sm font-medium text-foreground">Couldn't verify your session</p>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{message}</p>
        <Button
          size="sm"
          className="mt-4 bg-teal text-teal-foreground hover:bg-teal/90"
          onClick={onRetry}
          disabled={retrying}
          data-testid="button-auth-retry"
        >
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      </div>
    </div>
  );
}

/**
 * BrokerAuthGate — broker pages require a broker session.
 *
 * Order of attempts: (1) existing session via /api/broker-auth/me,
 * (2) LOCAL DEV ONLY: one `/api/dev/login-as-broker` attempt so the dev loop
 * stays zero-login — never in a production build, and never right after an
 * explicit logout, (3) the sign-in screen, rendered in place so the deep
 * link survives login.
 *
 * Any non-401 failure of /me (500, network) shows a retry panel — the app
 * is never rendered without a verified session.
 */
export function BrokerAuthGate({ children }: { children: React.ReactNode }) {
  const { data: me, isLoading, isError, error, refetch, isFetching } = useQuery(BROKER_ME_QUERY);
  const [devAttempt, setDevAttempt] = useState<"idle" | "pending" | "done">("idle");

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (isLoading || isError || me !== null || devAttempt !== "idle") return;
    // Respect an explicit logout — the developer asked for the sign-in screen.
    if (sessionStorage.getItem(BROKER_LOGGED_OUT_KEY)) {
      setDevAttempt("done");
      return;
    }
    setDevAttempt("pending");
    fetch("/api/dev/login-as-broker", { method: "POST", credentials: "include" })
      .then((r) => (r.ok ? refetch() : undefined))
      .catch(() => {})
      .finally(() => setDevAttempt("done"));
  }, [isLoading, isError, me, devAttempt, refetch]);

  // A verified session clears the logout marker so the next dev reload can
  // auto-login again.
  useEffect(() => {
    if (me?.user) sessionStorage.removeItem(BROKER_LOGGED_OUT_KEY);
  }, [me]);

  if (isLoading || devAttempt === "pending") return <AuthPending />;
  if (isError) {
    return (
      <AuthError
        message={(error as Error)?.message || "The server could not be reached."}
        onRetry={() => refetch()}
        retrying={isFetching}
      />
    );
  }
  if (!me?.user) return <BrokerLogin />;
  return <>{children}</>;
}

/**
 * /broker/login — explicit sign-in page reachable logged-out (Log out lands
 * here). Already-authenticated brokers are sent to the dashboard.
 *
 * Unlike BrokerAuthGate, a non-401 failure of the /me probe (500, network)
 * does NOT block this page: nothing session-scoped renders here, so the
 * broker still gets the sign-in form, with a small notice that the existing
 * session couldn't be checked. A successful login invalidates /me, which
 * re-runs the probe and redirects when it comes back clean.
 */
function BrokerLoginPage() {
  useSetLayoutRole("broker");
  const { data: me, isLoading, isError } = useQuery(BROKER_ME_QUERY);
  if (isLoading) return <AuthPending />;
  if (me?.user) return <Redirect to="/broker" />;
  return (
    <BrokerLogin
      notice={isError ? "We couldn't verify an existing session — sign in below." : undefined}
    />
  );
}

function BrokerLayout() {
  useSetLayoutRole("broker");
  return (
    <BrokerAuthGate>
      <SidebarProvider defaultOpen={false} style={{ "--sidebar-width": "14rem", "--sidebar-width-icon": "3rem" } as React.CSSProperties}>
        <div className="flex h-screen w-full overflow-hidden bg-background">
          <AppSidebar />
          <main className="flex-1 min-w-0 overflow-auto scrollbar-thin">
            {/* Below md the sidebar is an off-canvas sheet — this bar is the
                only way to open it (nav, theme toggle, log out). */}
            <BrokerMobileHeader />
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
    loc.startsWith("/seller/") || loc.startsWith("/invite/") || loc.startsWith("/approve/") || loc.startsWith("/sign-nda/")
      ? "seller" as const
      : "broker" as const; // /deal/:id/interview is broker
  useSetLayoutRole(fsRole);

  return (
    <div className="h-screen w-full overflow-auto bg-background">
      <Switch>
        {/* Broker interview — broker-only, so it sits behind the auth gate
            (expired sessions see the sign-in screen, not a 401 toast). */}
        <Route path="/deal/:id/interview">
          {() => (
            <BrokerAuthGate>
              <CIMInterview />
            </BrokerAuthGate>
          )}
        </Route>
        {/* Seller interview (fullscreen) */}
        <Route path="/seller/:token/interview" component={SellerInterview} />
        {/* Legacy seller invite redirect → /seller/:token */}
        <Route path="/invite/:token">{(params: { token: string }) => <Redirect to={`/seller/${params.token}`} />}</Route>
        {/* Seller Q&A approval (standalone) */}
        <Route path="/approve/:token" component={SellerApprovalPage} />
        {/* Seller NDA e-sign (standalone) */}
        <Route path="/sign-nda/:token" component={SellerNdaPage} />
        <Route component={NotFound} />
      </Switch>
    </div>
  );
}

/**
 * AppContent — Four-layout architecture.
 *
 * Detection order (first match wins):
 * 1. isFullscreen() → FullscreenLayout (interviews, seller approval/NDA, legacy redirects)
 * 2. /seller/* → SellerLayout (seller intake, progress, documents)
 * 3. /buyer/* | /view/* | /review/* → BuyerLayout (auth, dashboard, view room)
 * 4. /broker/login, /broker/reset-password/:token → logged-out broker pages (outside the gate)
 * 5. Everything else → BrokerLayout (sidebar + main content, behind BrokerAuthGate)
 */
function AppContent() {
  const [location] = useLocation();
  if (isFullscreen(location)) return <FullscreenLayout />;
  if (location.startsWith("/seller/")) return <SellerLayout />;
  if (location.startsWith("/buyer/") || location.startsWith("/view/") || location.startsWith("/review/")) return <BuyerLayout />;
  // Sign-in and password reset must be reachable logged-out — they render
  // outside the BrokerAuthGate that wraps everything else broker-side.
  if (location === "/broker/login" || location.startsWith("/broker/reset-password/")) {
    return (
      <Switch>
        <Route path="/broker/login" component={BrokerLoginPage} />
        <Route path="/broker/reset-password/:token" component={BrokerResetPassword} />
      </Switch>
    );
  }
  return <BrokerLayout />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <RoleProvider>
            <WouterRouter>
              <AppContent />
              {/* Dev-only — returns null (and tree-shakes) in production builds */}
              {import.meta.env.DEV && <RoleSwitcher />}
            </WouterRouter>
          </RoleProvider>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
