import { FileText, Home, Settings, BarChart3, HelpCircle, Building2 } from "lucide-react";
import { Link, useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";

const brokerItems = [
  {
    title: "Dashboard",
    url: "/",
    icon: Home,
    description: "Overview & recent activity",
  },
  {
    title: "Deals",
    url: "/deals",
    icon: Building2,
    description: "Manage your business deals",
  },
  {
    title: "Analytics",
    url: "/analytics",
    icon: BarChart3,
    description: "Performance insights",
  },
  {
    title: "Settings",
    url: "/settings",
    icon: Settings,
    description: "Branding & account",
  },
  {
    title: "Support",
    url: "/support",
    icon: HelpCircle,
    description: "Help & documentation",
  },
];

const sellerItems = [
  {
    title: "My Progress",
    url: "/seller/progress",
    icon: Home,
    description: "Track your CBO status",
  },
  {
    title: "AI Interview",
    url: "/seller/chat",
    icon: FileText,
    description: "Business information intake",
  },
  {
    title: "Documents",
    url: "/seller/documents",
    icon: FileText,
    description: "Upload supporting files",
  },
];

export function AppSidebar({ userType = "broker" }: { userType?: "broker" | "seller" }) {
  const [location] = useLocation();
  const items = userType === "broker" ? brokerItems : sellerItems;

  return (
    <Sidebar>
      <SidebarHeader className="p-5 border-b border-sidebar-border">
        <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
          <div className="h-8 w-8 rounded-md bg-primary flex items-center justify-center">
            <span className="text-primary-foreground font-bold text-sm">C</span>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-widest font-medium">
              {userType === "broker" ? "Broker Portal" : "Seller Portal"}
            </p>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarContent className="pt-2">
        <SidebarGroup>
          <SidebarGroupLabel className="text-xs uppercase tracking-widest text-muted-foreground px-4 mb-1">
            Navigation
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => {
                const isActive = location === item.url || (item.url !== "/" && location.startsWith(item.url));
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      data-testid={`link-${item.title.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      <Link href={item.url} className="flex items-center gap-3 px-3 py-2.5">
                        <item.icon className="h-4 w-4 shrink-0" />
                        <span className="font-medium text-sm">{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-4 border-t border-sidebar-border">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded bg-muted-foreground/20 flex items-center justify-center">
            <span className="text-muted-foreground font-bold text-xs">C</span>
          </div>
          <p className="text-xs text-muted-foreground">cimple &copy; {new Date().getFullYear()}</p>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
