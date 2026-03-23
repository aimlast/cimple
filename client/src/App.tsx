import { Switch, Route, useLocation, Router as WouterRouter } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider } from "@/components/ThemeProvider";
import { ThemeToggle } from "@/components/ThemeToggle";
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

function Routes() {
  return (
    <Switch>
      <Route path="/" component={BrokerDashboard} />
      <Route path="/deals" component={ActiveCIMs} />
      <Route path="/cims" component={ActiveCIMs} />
      <Route path="/analytics" component={Analytics} />
      <Route path="/templates" component={Templates} />
      <Route path="/settings" component={Settings} />
      <Route path="/support" component={Support} />
      <Route path="/new-cim" component={NewCIM} />
      <Route path="/new-deal" component={NewDeal} />
      <Route path="/deal/:id" component={DealDetail} />
      <Route path="/deal/:id/interview" component={CIMInterview} />
      <Route path="/cim/new-questionnaire" component={CIMQuestionnaire} />
      <Route path="/cim/new-documents" component={CIMDocuments} />
      <Route path="/cim/new-interview" component={CIMInterview} />
      <Route path="/cim/:id/interview" component={CIMInterview} />
      <Route path="/cim/:id" component={BrokerReview} />
      <Route path="/cim/:id/preview" component={CIMPreview} />
      <Route path="/cim/:dealId/design" component={CIMDesigner} />
      <Route path="/deal/:dealId/design" component={CIMDesigner} />
      <Route path="/view/:token" component={BuyerViewRoom} />
      <Route path="/invite/:token" component={SellerInviteIntake} />
      <Route path="/seller/progress" component={SellerProgress} />
      <Route path="/seller/chat" component={SellerChat} />
      <Route path="/seller/documents" component={SellerDocuments} />
      <Route component={NotFound} />
    </Switch>
  );
}

function BrokerLayout() {
  const style = {
    "--sidebar-width": "15rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar userType="broker" />
        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center gap-3 px-4 py-3 border-b bg-background/95 backdrop-blur-sm sticky top-0 z-50">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
            <div className="flex-1" />
            <ThemeToggle />
          </header>
          <main className="flex-1 overflow-auto">
            <Routes />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

function SellerInviteLayout() {
  return (
    <div className="h-screen w-full overflow-auto">
      <Routes />
    </div>
  );
}

function AppContent() {
  const [location] = useLocation();
  const isFullscreenRoute = location.startsWith("/invite/") || location.startsWith("/seller/") || location.startsWith("/view/");

  return isFullscreenRoute ? <SellerInviteLayout /> : <BrokerLayout />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="dark">
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
