import { useEffect } from "react";
import { Switch, Route, useLocation, Router as WouterRouter } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider } from "@/components/ThemeProvider";
import { RoleProvider, useSetLayoutRole } from "@/contexts/RoleContext";
import { RoleSwitcher } from "@/components/dev/RoleSwitcher";
import NotFound from "@/pages/not-found";
import ActiveCIMs from "@/pages/ActiveCIMs";
import Analytics from "@/pages/Analytics";
import Templates from "@/pages/Templates";
import Settings from "@/pages/Settings";
import Support from "@/pages/Support";
import NewCIM from "@/pages/NewCIM";
import NewDeal from "@/pages/NewDeal";
import DealShell from "@/pages/broker/deal/DealShell";
import CIMQuestionnaire from "@/pages/CIMQuestionnaire";
import CIMDocuments from "@/pages/CIMDocuments";
import CIMInterview from "@/pages/CIMInterview";
import BrokerReview from "@/pages/BrokerReview";
import CIMPreview from "@/pages/CIMPreview";
import CIMDesigner from "@/pages/CIMDesigner";
import SellerApprovalPage from "@/pages/SellerApprovalPage";
import Integrations from "@/pages/Integrations";
import Buyers from "@/pages/Buyers";
import SellerLayout from "@/layouts/SellerLayout";
import SellerInterview from "@/pages/seller/SellerInterview";
import BuyerLayout from "@/layouts/BuyerLayout";

/** Redirect helper — replaces current URL in history (for legacy bookmarks) */
function Redirect({ to }: { to: string }) {
  const [, nav] = useLocation();
  useEffect(() => { nav(to, { replace: true }); }, [to, nav]);
  return null;
}

function Routes() {
  return (
    <Switch>
      {/* ── Root (broker landing — no redirect flash) ── */}
      <Route path="/" component={ActiveCIMs} />

      {/* ── Canonical broker routes ── */}
      <Route path="/broker/deals" component={ActiveCIMs} />
      <Route path="/broker/analytics" component={Analytics} />
      <Route path="/broker/buyers" component={Buyers} />
      <Route path="/broker/integrations" component={Integrations} />
      <Route path="/broker/settings" component={Settings} />
      <Route path="/broker/templates" component={Templates} />
      <Route path="/broker/support" component={Support} />
      <Route path="/broker/new-deal" component={NewDeal} />
      <Route path="/broker/new-cim" component={NewCIM} />
      <Route path="/broker/cim/new-questionnaire" component={CIMQuestionnaire} />
      <Route path="/broker/cim/new-documents" component={CIMDocuments} />
      <Route path="/broker/cim/new-interview" component={CIMInterview} />
      <Route path="/broker/cim/:id/preview" component={CIMPreview} />
      <Route path="/broker/cim/:dealId/design" component={CIMDesigner} />
      <Route path="/broker/cim/:id" component={BrokerReview} />

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
      <Route path="/templates">{() => <Redirect to="/broker/templates" />}</Route>
      <Route path="/support">{() => <Redirect to="/broker/support" />}</Route>
      <Route path="/new-deal">{() => <Redirect to="/broker/new-deal" />}</Route>
      <Route path="/new-cim">{() => <Redirect to="/broker/new-cim" />}</Route>
      <Route path="/cim/new-questionnaire">{() => <Redirect to="/broker/cim/new-questionnaire" />}</Route>
      <Route path="/cim/new-documents">{() => <Redirect to="/broker/cim/new-documents" />}</Route>
      <Route path="/cim/new-interview">{() => <Redirect to="/broker/cim/new-interview" />}</Route>
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

function BrokerLayout() {
  useSetLayoutRole("broker");
  return (
    <SidebarProvider defaultOpen={false} style={{ "--sidebar-width": "14rem", "--sidebar-width-icon": "3rem" } as React.CSSProperties}>
      <div className="flex h-screen w-full overflow-hidden bg-background">
        <AppSidebar />
        <main className="flex-1 min-w-0 overflow-auto scrollbar-thin">
          <Routes />
        </main>
      </div>
    </SidebarProvider>
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
        <Route path="/broker/cim/:id/interview" component={CIMInterview} />
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
