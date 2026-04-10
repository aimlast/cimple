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
  { label: "Deals",        href: "/",             icon: Building2 },
  { label: "Buyers",       href: "/buyers",       icon: Users },
  { label: "Analytics",    href: "/analytics",    icon: BarChart3 },
  { label: "Integrations", href: "/integrations", icon: Plug },
  { label: "Settings",     href: "/settings",     icon: Settings },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { setOpen } = useSidebar();
  const expandTimer = useRef<ReturnType<typeof setTimeout>>();
  const collapseTimer = useRef<ReturnType<typeof setTimeout>>();
  const cooldownRef = useRef(false);

  // Auto-collapse on navigation
  useEffect(() => {
    setOpen(false);
    cooldownRef.current = true;
    const t = setTimeout(() => { cooldownRef.current = false; }, 400);
    return () => clearTimeout(t);
  }, [location, setOpen]);

  const handleMouseEnter = () => {
    if (cooldownRef.current) return;
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    expandTimer.current = setTimeout(() => setOpen(true), 150);
  };

  const handleMouseLeave = () => {
    if (expandTimer.current) clearTimeout(expandTimer.current);
    collapseTimer.current = setTimeout(() => setOpen(false), 200);
  };

  const isActive = (href: string) =>
    href === "/"
      ? location === "/" || location === "/deals"
      : location.startsWith(href);

  return (
    <Sidebar
      className="border-r border-sidebar-border bg-sidebar"
      collapsible="icon"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* ── Logo ── */}
      <SidebarHeader className="border-b border-sidebar-border px-4 py-4 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-3">
        <Link href="/" className="flex items-center gap-2.5 group-data-[collapsible=icon]:justify-center">
          {/* Icon mark — vertical rectangle + triangle (matches cimple-logo.png) */}
          <div className="h-8 w-6 shrink-0 select-none">
            <svg viewBox="0 0 21 28" fill="none" className="h-full w-full" style={{ color: 'hsl(40 28% 88%)' }}>
              <rect x="1.5" y="1.5" width="18" height="25" stroke="currentColor" strokeWidth="1.75"/>
              <path d="M3 3 L3 25 L18 25 Z" fill="currentColor"/>
            </svg>
          </div>
          {/* Wordmark — hidden when collapsed */}
          <span className="text-sidebar-foreground font-bold text-base tracking-tight truncate group-data-[collapsible=icon]:hidden" style={{ color: 'hsl(40 28% 88%)' }}>
            cimple
          </span>
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
          <Link href="/new-deal">
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
