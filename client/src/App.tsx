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
      <Route path="/deals/:id" component={DealDetail} />
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <SidebarProvider>
            <div className="flex w-full">
              <AppSidebar />
              <div className="flex-1 flex flex-col">
                <Routes />
              </div>
            </div>
            <Toaster />
          </SidebarProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
