import { useRef, useEffect } from "react";
import { BarChart3, Settings, Building2, Plus, Plug, Users, LayoutDashboard, LifeBuoy, Sun, Moon, LogOut } from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";
import { useToast } from "@/hooks/use-toast";
import { Link, useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";

/**
 * sessionStorage marker set on an explicit Log out. BrokerAuthGate reads it
 * so the local-dev auto-login never undoes a deliberate sign-out; it is
 * cleared again once a real session is verified.
 */
export const BROKER_LOGGED_OUT_KEY = "cimple:broker-logged-out";

const NAV = [
  { label: "Dashboard",    href: "/broker",              icon: LayoutDashboard },
  { label: "Deals",        href: "/broker/deals",        icon: Building2 },
  { label: "Buyers",       href: "/broker/buyers",       icon: Users },
  { label: "Analytics",    href: "/broker/analytics",    icon: BarChart3 },
  { label: "Integrations", href: "/broker/integrations", icon: Plug },
  { label: "Settings",     href: "/broker/settings",     icon: Settings },
  { label: "Support",      href: "/broker/support",      icon: LifeBuoy },
];

/**
 * Which sidebar item a path belongs to. Deal pages (/deal/:id/*), the CIM
 * designer and the new-deal flow all live under "Deals" even though they
 * are not prefixed /broker/deals.
 */
export function isNavActive(href: string, location: string): boolean {
  if (href === "/broker") {
    return location === "/" || location === "/broker";
  }
  if (href === "/broker/deals") {
    return (
      location.startsWith("/broker/deals") ||
      location.startsWith("/deal/") ||
      location.startsWith("/broker/cim/") ||
      location === "/broker/new-deal"
    );
  }
  return location === href || location.startsWith(`${href}/`);
}

export function AppSidebar() {
  const [location] = useLocation();
  const { setOpen, setOpenMobile } = useSidebar();
  const expandTimer = useRef<ReturnType<typeof setTimeout>>();
  const collapseTimer = useRef<ReturnType<typeof setTimeout>>();
  const cooldownRef = useRef(false);

  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;
  const setOpenMobileRef = useRef(setOpenMobile);
  setOpenMobileRef.current = setOpenMobile;

  // Auto-collapse on navigation (only when route changes, not when setOpen identity changes).
  // On mobile the sidebar is a sheet — close it too so the new page is visible.
  const locationRef = useRef(location);
  useEffect(() => {
    if (locationRef.current !== location) {
      locationRef.current = location;
      setOpenRef.current(false);
      setOpenMobileRef.current(false);
      cooldownRef.current = true;
      const t = setTimeout(() => { cooldownRef.current = false; }, 400);
      return () => clearTimeout(t);
    }
  }, [location]);

  // Start collapsed
  useEffect(() => { setOpenRef.current(false); }, []);

  // Attach native DOM hover listeners directly on the sidebar element.

  useEffect(() => {
    const el = document.querySelector('[data-slot="sidebar"]') as HTMLElement | null;
    if (!el) return;

    const onEnter = () => {
      if (cooldownRef.current) return;
      if (collapseTimer.current) clearTimeout(collapseTimer.current);
      expandTimer.current = setTimeout(() => setOpenRef.current(true), 150);
    };
    const onLeave = () => {
      if (expandTimer.current) clearTimeout(expandTimer.current);
      collapseTimer.current = setTimeout(() => setOpenRef.current(false), 200);
    };

    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el.removeEventListener("mouseenter", onEnter);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  const isActive = (href: string) => isNavActive(href, location);

  return (
    <Sidebar
      className="border-r border-sidebar-border bg-sidebar"
      collapsible="icon"
    >
      {/* ── Logo ── */}
      <SidebarHeader className="border-b border-sidebar-border px-3 py-3 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-3">
        <Link href="/broker" className="flex items-center gap-2 group-data-[collapsible=icon]:justify-center">
          <img
            src="/cimple-icon.png"
            alt="Cimple"
            className="h-7 w-auto shrink-0 select-none"
          />
          {/* Wordmark — hidden when collapsed */}
          <img
            src="/cimple-text.png"
            alt="cimple"
            className="h-4 w-auto select-none group-data-[collapsible=icon]:hidden"
          />
        </Link>
      </SidebarHeader>

      {/* ── Navigation ── */}
      <SidebarContent className="py-4 px-2">
        <SidebarMenu className="space-y-0.5">
          {NAV.map(({ label, href, icon: Icon }) => {
            const active = isActive(href);
            return (
              <SidebarMenuItem key={href}>
                <Link href={href}>
                  <div
                    className={`
                      flex items-center gap-3 px-3 py-2 rounded-md text-sm cursor-pointer
                      transition-colors duration-100 select-none
                      group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0
                      ${active
                        ? "bg-teal/15 text-teal font-medium"
                        : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                      }
                    `}
                    aria-current={active ? "page" : undefined}
                    data-testid={`link-${label.toLowerCase()}`}
                  >
                    <Icon className={`shrink-0 ${active ? "text-teal" : ""}`} style={{ width: '1.125rem', height: '1.125rem' }} />
                    <span className="group-data-[collapsible=icon]:hidden">{label}</span>
                    {active && (
                      <span className="ml-auto h-1.5 w-1.5 rounded-full bg-teal shrink-0 group-data-[collapsible=icon]:hidden" />
                    )}
                  </div>
                </Link>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>

        {/* ── New deal shortcut ── */}
        <div className="mt-4 px-1 group-data-[collapsible=icon]:px-0">
          <Link href="/broker/new-deal">
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-md text-xs text-teal/70 hover:text-teal hover:bg-teal/8 cursor-pointer transition-colors border border-dashed border-teal/20 hover:border-teal/40 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2 group-data-[collapsible=icon]:border-0"
              data-testid="link-new-deal"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              <span className="group-data-[collapsible=icon]:hidden">New Deal</span>
            </div>
          </Link>
        </div>
      </SidebarContent>

      {/* ── Footer ── */}
      <SidebarFooter className="px-4 py-3 border-t border-sidebar-border group-data-[collapsible=icon]:px-2 group-data-[collapsible=icon]:py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xs text-sidebar-foreground/30 tracking-wide group-data-[collapsible=icon]:hidden">
            &copy; {new Date().getFullYear()} Cimple
          </span>
          <div className="flex items-center gap-0.5">
            <ThemeFooterToggle />
            <LogoutButton />
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * BrokerMobileHeader — top bar shown below the md breakpoint, where the
 * shadcn Sidebar renders as a closed off-canvas sheet. Without this there
 * is no way on a phone to reach navigation, the theme toggle, or Log out.
 * Sticky inside the scrolling <main>; hidden on desktop.
 */
export function BrokerMobileHeader() {
  return (
    <header
      className="md:hidden sticky top-0 z-30 flex items-center gap-2 border-b border-sidebar-border bg-sidebar/95 backdrop-blur px-2 py-1.5"
      data-testid="header-mobile"
    >
      <SidebarTrigger
        className="h-8 w-8 text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent"
        aria-label="Open navigation"
        data-testid="button-mobile-menu"
      />
      <Link href="/broker" className="flex items-center gap-2">
        <img src="/cimple-icon.png" alt="Cimple" className="h-6 w-auto shrink-0 select-none" />
        <img src="/cimple-text.png" alt="cimple" className="h-3.5 w-auto select-none" />
      </Link>
    </header>
  );
}

function ThemeFooterToggle() {
  const { theme, setTheme } = useTheme();
  const isLight = theme === "light";
  return (
    <button
      onClick={() => setTheme(isLight ? "dark" : "light")}
      className="p-1.5 rounded-md text-sidebar-foreground/40 hover:text-sidebar-accent-foreground hover:bg-sidebar-accent transition-colors shrink-0"
      title={isLight ? "Switch to dark mode" : "Switch to light mode"}
      data-testid="button-theme-toggle-sidebar"
    >
      {isLight ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
    </button>
  );
}

function LogoutButton() {
  const { toast } = useToast();
  const handleLogout = async () => {
    try {
      const res = await fetch("/api/broker-auth/logout", { method: "POST", credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Log out failed (${res.status})`);
      }
    } catch (e) {
      toast({
        title: "Couldn't log out",
        description: (e as Error).message || "The server could not be reached.",
        variant: "destructive",
      });
      return;
    }
    // Tell the auth gate this was deliberate (blocks the local-dev auto-login),
    // then do a full reload so every cached query is dropped and the explicit
    // sign-in page is shown.
    try { sessionStorage.setItem(BROKER_LOGGED_OUT_KEY, "1"); } catch { /* private mode */ }
    window.location.href = "/broker/login";
  };
  return (
    <button
      onClick={handleLogout}
      className="p-1.5 rounded-md text-sidebar-foreground/40 hover:text-sidebar-accent-foreground hover:bg-sidebar-accent transition-colors shrink-0"
      title="Log out"
      data-testid="button-logout"
    >
      <LogOut className="h-3.5 w-3.5" />
    </button>
  );
}
