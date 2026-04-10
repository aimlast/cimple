import { Switch, Route, useLocation, Router as WouterRouter } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider } from "@/components/ThemeProvider";
import NotFound from "@/pages/not-found";
import BrokerDashboard from "@/pages/BrokerDashboard";
import ActiveCIMs from "@/pages/ActiveCIMs";
import Analytics from "@/pages/Analytics";
import Templates from "@/pages/Templates";
import Settings from "@/pages/Settings";
import Support from "@/pages/Support";
import NewCIM from "@/pages/NewCIM";
import NewDeal from "@/pages/NewDeal";
import DealDetail from "@/pages/DealDetail";
import CIMQuestionnaire from "@/pages/CIMQuestionnaire";
import CIMDocuments from "@/pages/CIMDocuments";
import CIMInterview from "@/pages/CIMInterview";
import BrokerReview from "@/pages/BrokerReview";
import CIMPreview from "@/pages/CIMPreview";
import SellerProgress from "@/pages/SellerProgress";
import SellerChat from "@/pages/SellerChat";
import SellerDocuments from "@/pages/SellerDocuments";
import SellerInviteIntake from "@/pages/SellerInviteIntake";
import CIMDesigner from "@/pages/CIMDesigner";
import BuyerViewRoom from "@/pages/BuyerViewRoom";
import SellerApprovalPage from "@/pages/SellerApprovalPage";
import BuyerApprovalReviewPage from "@/pages/BuyerApprovalReviewPage";
import BuyerLogin from "@/pages/buyer/BuyerLogin";
import BuyerSignup from "@/pages/buyer/BuyerSignup";
import BuyerSetPassword from "@/pages/buyer/BuyerSetPassword";
import BuyerDashboard from "@/pages/buyer/BuyerDashboard";
import BuyerProfile from "@/pages/buyer/BuyerProfile";
import Integrations from "@/pages/Integrations";
import Buyers from "@/pages/Buyers";

function Routes() {
  return (
    <Switch>
      {/* / → deals board (dashboard is the deals board) */}
      <Route path="/" component={ActiveCIMs} />
      <Route path="/deals" component={ActiveCIMs} />
      <Route path="/cims" component={ActiveCIMs} />
      <Route path="/analytics" component={Analytics} />
      <Route path="/buyers" component={Buyers} />
      <Route path="/integrations" component={Integrations} />
      <Route path="/templates" component={Templates} />
      <Route path="/settings" component={Settings} />
      <Route path="/support" component={Support} />
      <Route path="/new-cim" component={NewCIM} />
      <Route path="/new-deal" component={NewDeal} />
      <Route path="/deal/:id" component={DealDetail} />
      <Route path="/cim/new-questionnaire" component={CIMQuestionnaire} />
      <Route path="/cim/new-documents" component={CIMDocuments} />
      <Route path="/cim/new-interview" component={CIMInterview} />
      <Route path="/cim/:id/interview" component={CIMInterview} />
      <Route path="/cim/:id" component={BrokerReview} />
      <Route path="/cim/:id/preview" component={CIMPreview} />
      <Route path="/cim/:dealId/design" component={CIMDesigner} />
      <Route path="/deal/:dealId/design" component={CIMDesigner} />
      <Route component={NotFound} />
    </Switch>
  );
}

// Full-screen routes that bypass the broker layout entirely
const FULLSCREEN_ROUTES = ["/invite/", "/seller/", "/view/", "/deal/", "/cim/"];

function isFullscreen(path: string) {
  // Interview pages are fullscreen — no sidebar chrome
  if (path.includes("/interview")) return true;
  // External-facing pages
  if (path.startsWith("/invite/")) return true;
  if (path.startsWith("/seller/")) return true;
  if (path.startsWith("/view/")) return true;
  if (path.startsWith("/approve/")) return true;
  if (path.startsWith("/buyer-approval/")) return true;
  if (path.startsWith("/buyer/")) return true;
  return false;
}

function BrokerLayout() {
  return (
    <SidebarProvider style={{ "--sidebar-width": "14rem", "--sidebar-width-icon": "3rem" } as React.CSSProperties}>
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
  return (
    <div className="h-screen w-full overflow-auto bg-background">
      <Switch>
        <Route path="/deal/:id/interview" component={CIMInterview} />
        <Route path="/invite/:token" component={SellerInviteIntake} />
        <Route path="/seller/progress" component={SellerProgress} />
        <Route path="/seller/chat" component={SellerChat} />
        <Route path="/seller/documents" component={SellerDocuments} />
        <Route path="/view/:token" component={BuyerViewRoom} />
        <Route path="/approve/:token" component={SellerApprovalPage} />
        <Route path="/buyer-approval/:token" component={BuyerApprovalReviewPage} />
        <Route path="/buyer/login" component={BuyerLogin} />
        <Route path="/buyer/signup" component={BuyerSignup} />
        <Route path="/buyer/set-password/:token" component={BuyerSetPassword} />
        <Route path="/buyer/dashboard" component={BuyerDashboard} />
        <Route path="/buyer/profile" component={BuyerProfile} />
        <Route component={NotFound} />
      </Switch>
    </div>
  );
}

function AppContent() {
  const [location] = useLocation();
  return isFullscreen(location) ? <FullscreenLayout /> : <BrokerLayout />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider forcedTheme="light" enableSystem={false}>
        <TooltipProvider>
          <WouterRouter>
            <AppContent />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
