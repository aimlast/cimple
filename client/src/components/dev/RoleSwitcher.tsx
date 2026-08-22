/**
 * RoleSwitcher — Dev-only floating pill for switching between roles.
 *
 * Strictly local-dev: the exported component returns null unless
 * `import.meta.env.DEV`, and App.tsx only mounts it under the same flag,
 * so the pill and its /api/dev/* call sites are dead code in a production
 * build and get tree-shaken. There is deliberately no `?switcher` escape —
 * production demos use ENABLE_DEV_SWITCHER server-side plus a real sign-in.
 *
 * Fetches available tokens from /api/dev/role-tokens and navigates
 * to a real working page for each role.
 *
 * Visual: floating pill bottom-right, current role with colored dot,
 * click to expand. Collapsible.
 */
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useRole, type Role } from "@/contexts/RoleContext";

const ROLE_CONFIG: Record<
  Role,
  { label: string; color: string; dot: string; bg: string }
> = {
  broker: {
    label: "Broker",
    color: "text-teal",
    dot: "bg-teal",
    bg: "bg-teal-muted border-teal/30",
  },
  seller: {
    label: "Seller",
    color: "text-amber-500",
    dot: "bg-amber-500",
    bg: "bg-amber-500/10 border-amber-500/30",
  },
  buyer: {
    label: "Buyer",
    color: "text-blue-muted-foreground",
    dot: "bg-blue-500",
    bg: "bg-blue-muted border-blue-500/30",
  },
};

const ROLES: Role[] = ["broker", "seller", "buyer"];

interface TokenData {
  dealId: string | null;
  dealName: string | null;
  sellerToken: string | null;
  buyerToken: string | null;
}

function RoleSwitcherInner() {
  const { role, setDevOverride, devOverride } = useRole();
  const [, setLocation] = useLocation();
  const [expanded, setExpanded] = useState(false);
  const [tokens, setTokens] = useState<TokenData | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch tokens on first expand
  useEffect(() => {
    if (!expanded || tokens) return;
    setFetching(true);
    fetch("/api/dev/role-tokens", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error || `Dev endpoints unavailable (${r.status})`);
        }
        return r.json();
      })
      .then((data) => {
        setTokens(data);
        setFetching(false);
      })
      .catch((e: Error) => {
        setError(e.message || "Failed to fetch tokens");
        setFetching(false);
      });
  }, [expanded, tokens]);

  const currentConfig = ROLE_CONFIG[role];

  const switchTo = async (target: Role) => {
    if (target === role && devOverride) {
      // Clicking current role clears override
      setDevOverride(null);
      setExpanded(false);
      return;
    }

    setDevOverride(target);

    // Navigate to a real page for the target role
    switch (target) {
      case "broker":
        // Establish a broker session first — broker pages require auth
        try {
          await fetch("/api/dev/login-as-broker", { method: "POST", credentials: "include" });
        } catch { /* the auth gate will fall back to the login screen */ }
        setLocation("/broker/deals");
        break;
      case "seller":
        if (tokens?.sellerToken) {
          setLocation(`/seller/${tokens.sellerToken}`);
        } else {
          setError("No seller token — create a deal and invite a seller first");
          return;
        }
        break;
      case "buyer":
        // Auto-login as a dev buyer so the dashboard is reachable, then
        // land on /buyer/dashboard. Falls back to /view/<token> if dev
        // login isn't available for any reason.
        try {
          const r = await fetch("/api/dev/login-as-buyer", { method: "POST", credentials: "include" });
          if (r.ok) {
            setLocation("/buyer/dashboard");
            break;
          }
        } catch { /* fall through to fallback */ }
        if (tokens?.buyerToken) {
          setLocation(`/view/${tokens.buyerToken}`);
        } else {
          setLocation("/buyer/login");
        }
        break;
    }

    setExpanded(false);
  };

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex flex-col items-end gap-1">
      {/* Expanded panel */}
      {expanded && (
        <div className="bg-popover text-popover-foreground rounded-lg shadow-lg border border-border p-2 min-w-[180px] mb-1 animate-in fade-in slide-in-from-bottom-2 duration-150">
          <div className="px-2 py-1 mb-1">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Dev Role Switcher
            </p>
            {tokens?.dealName && (
              <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                {tokens.dealName}
              </p>
            )}
          </div>

          {ROLES.map((r) => {
            const cfg = ROLE_CONFIG[r];
            const isActive = role === r;
            const hasToken =
              r === "broker" ||
              (r === "seller" && !!tokens?.sellerToken) ||
              r === "buyer"; // buyer always has the login fallback
            const disabled = !hasToken && !fetching;

            return (
              <button
                key={r}
                onClick={() => switchTo(r)}
                disabled={disabled}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                  isActive
                    ? `${cfg.bg} ${cfg.color}`
                    : "text-foreground/80 hover:bg-accent"
                } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
              >
                <span
                  className={`h-2 w-2 rounded-full shrink-0 ${cfg.dot} ${isActive ? "" : "opacity-40"}`}
                />
                {cfg.label}
                {isActive && devOverride && (
                  <span className="ml-auto text-[9px] text-muted-foreground">
                    active
                  </span>
                )}
                {r === "seller" && !tokens?.sellerToken && !fetching && (
                  <span className="ml-auto text-[9px] text-muted-foreground">
                    no token
                  </span>
                )}
              </button>
            );
          })}

          {fetching && (
            <p className="text-[10px] text-muted-foreground px-2 py-1">
              Loading tokens...
            </p>
          )}

          {error && (
            <p className="text-[10px] text-destructive px-2 py-1">{error}</p>
          )}

          {devOverride && (
            <button
              onClick={() => {
                setDevOverride(null);
                setLocation("/broker/deals");
                setExpanded(false);
              }}
              className="w-full text-[10px] text-muted-foreground hover:text-foreground mt-1 pt-1 border-t border-border py-1"
            >
              Clear override
            </button>
          )}
        </div>
      )}

      {/* Floating pill */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full shadow-md border text-xs font-medium transition-all hover:shadow-lg ${currentConfig.bg} ${currentConfig.color}`}
        title="Dev Role Switcher"
      >
        <span className={`h-2 w-2 rounded-full ${currentConfig.dot}`} />
        {currentConfig.label}
        {devOverride && (
          <span className="text-[9px] opacity-60">(dev)</span>
        )}
      </button>
    </div>
  );
}

/**
 * Export: renders in local dev only. In production builds this is a constant
 * `null` and the inner component is tree-shaken.
 */
export function RoleSwitcher() {
  if (!import.meta.env.DEV) return null;
  return <RoleSwitcherInner />;
}
