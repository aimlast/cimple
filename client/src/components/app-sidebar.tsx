import { useRef, useEffect } from "react";
import { BarChart3, Settings, Building2, Plus, Plug, Users } from "lucide-react";
import { Link, useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";

const NAV = [
  { label: "Deals",        href: "/broker/deals",        icon: Building2 },
  { label: "Buyers",       href: "/broker/buyers",       icon: Users },
  { label: "Analytics",    href: "/broker/analytics",    icon: BarChart3 },
  { label: "Integrations", href: "/broker/integrations", icon: Plug },
  { label: "Settings",     href: "/broker/settings",     icon: Settings },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { setOpen } = useSidebar();
  const expandTimer = useRef<ReturnType<typeof setTimeout>>();
  const collapseTimer = useRef<ReturnType<typeof setTimeout>>();
  const cooldownRef = useRef(false);

  // Auto-collapse on navigation (only when route changes, not when setOpen identity changes)
  const locationRef = useRef(location);
  useEffect(() => {
    if (locationRef.current !== location) {
      locationRef.current = location;
      setOpenRef.current(false);
      cooldownRef.current = true;
      const t = setTimeout(() => { cooldownRef.current = false; }, 400);
      return () => clearTimeout(t);
    }
  }, [location]);

  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;

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

  const isActive = (href: string) =>
    href === "/broker/deals"
      ? location === "/" || location.startsWith("/broker/deals") || location === "/deals"
      : location.startsWith(href);

  return (
    <Sidebar
      className="border-r border-sidebar-border bg-sidebar"
      collapsible="icon"
    >
      {/* ── Logo ── */}
      <SidebarHeader className="border-b border-sidebar-border px-3 py-3 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-3">
        <Link href="/broker/deals" className="flex items-center gap-2 group-data-[collapsible=icon]:justify-center">
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
        <span className="text-2xs text-sidebar-foreground/30 tracking-wide group-data-[collapsible=icon]:hidden">
          &copy; {new Date().getFullYear()} Cimple
        </span>
      </SidebarFooter>
    </Sidebar>
  );
}
