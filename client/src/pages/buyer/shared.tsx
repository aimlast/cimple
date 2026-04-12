/**
 * Shared buyer-side UI primitives — auth card layout, buyer nav bar.
 */
import { Link, useLocation } from "wouter";
import { LayoutDashboard, UserCircle, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export function BuyerAuthCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <div className="text-2xl font-semibold tracking-tight">Cimple</div>
          <div className="text-xs text-muted-foreground mt-1">
            Matched opportunities for private business acquirers
          </div>
        </div>
        <div className="border border-border rounded-lg bg-card p-6 space-y-4">
          {children}
        </div>
      </div>
    </div>
  );
}

export function BuyerNav() {
  const [location] = useLocation();
  const qc = useQueryClient();

  const logout = useMutation({
    mutationFn: async () => {
      await fetch("/api/buyer-auth/logout", { method: "POST", credentials: "include" });
    },
    onSuccess: () => {
      qc.clear();
      window.location.href = "/buyer/login";
    },
  });

  const NavLink = ({ href, icon: Icon, label }: { href: string; icon: any; label: string }) => {
    const active = location.startsWith(href);
    return (
      <Link href={href} className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm ${
          active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
        }`}>
        <Icon className="h-4 w-4" />
        {label}
      </Link>
    );
  };

  return (
    <nav className="border-b border-border bg-card">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href="/buyer/dashboard" className="font-semibold">Cimple</Link>
          <div className="flex items-center gap-1">
            <NavLink href="/buyer/dashboard" icon={LayoutDashboard} label="Dashboard" />
            <NavLink href="/buyer/profile" icon={UserCircle} label="Profile" />
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => logout.mutate()}>
          <LogOut className="h-4 w-4 mr-1.5" />
          Sign out
        </Button>
      </div>
    </nav>
  );
}

export async function fetchBuyerMe() {
  const res = await fetch("/api/buyer-auth/me", { credentials: "include" });
  if (!res.ok) throw new Error("Not authenticated");
  return res.json();
}
