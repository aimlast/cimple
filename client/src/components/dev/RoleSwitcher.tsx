/**
 * RoleSwitcher — Dev-only floating pill for switching between roles.
 *
 * Gated by import.meta.env.DEV so it tree-shakes out of prod builds.
 * Fetches available tokens from /api/dev/role-tokens and navigates
 * to a real working page for each role.
 *
 * Visual: floating pill bottom-right, current role with colored dot,
 * click to expand. Collapsible.
 */
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useRole, type Role } from "@/contexts/RoleContext";

// Tree-shake: entire component is a no-op in production
if (!import.meta.env.DEV) {
  // This block ensures the bundler can detect the guard
}

const ROLE_CONFIG: Record<
  Role,
  { label: string; color: string; dot: string; bg: string }
> = {
  broker: {
    label: "Broker",
    color: "text-teal-600",
    dot: "bg-teal-500",
    bg: "bg-teal-50 border-teal-200",
  },
  seller: {
    label: "Seller",
    color: "text-amber-600",
    dot: "bg-amber-500",
    bg: "bg-amber-50 border-amber-200",
  },
  buyer: {
    label: "Buyer",
    color: "text-blue-600",
    dot: "bg-blue-500",
    bg: "bg-blue-50 border-blue-200",
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
    fetch("/api/dev/role-tokens")
      .then((r) => r.json())
      .then((data) => {
        setTokens(data);
        setFetching(false);
      })
      .catch(() => {
        setError("Failed to fetch tokens");
        setFetching(false);
      });
  }, [expanded, tokens]);

  const currentConfig = ROLE_CONFIG[role];

  const switchTo = (target: Role) => {
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
        if (tokens?.buyerToken) {
          setLocation(`/view/${tokens.buyerToken}`);
        } else {
          // Try buyer dashboard (session-auth based)
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
        <div className="bg-white rounded-lg shadow-lg border border-neutral-200 p-2 min-w-[180px] mb-1 animate-in fade-in slide-in-from-bottom-2 duration-150">
          <div className="px-2 py-1 mb-1">
            <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">
              Dev Role Switcher
            </p>
            {tokens?.dealName && (
              <p className="text-[10px] text-neutral-400 mt-0.5 truncate">
                {tokens.dealName}
              </p>
            )}
          </div>

          {ROLES.map((r) => {
            const cfg = ROLE_CONFIG[r];
            const isActive = role === r;
            const hasToken =
              r === "broker" ||
              (r === "seller" && tokens?.sellerToken) ||
              (r === "buyer" && (tokens?.buyerToken || true)); // buyer always has login fallback
            const disabled = !hasToken && !fetching;

            return (
              <button
                key={r}
                onClick={() => switchTo(r)}
                disabled={disabled as boolean}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                  isActive
                    ? `${cfg.bg} ${cfg.color}`
                    : "text-neutral-600 hover:bg-neutral-50"
                } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
              >
                <span
                  className={`h-2 w-2 rounded-full shrink-0 ${cfg.dot} ${isActive ? "" : "opacity-40"}`}
                />
                {cfg.label}
                {isActive && devOverride && (
                  <span className="ml-auto text-[9px] text-neutral-400">
                    active
                  </span>
                )}
                {r === "seller" && !tokens?.sellerToken && !fetching && (
                  <span className="ml-auto text-[9px] text-neutral-400">
                    no token
                  </span>
                )}
              </button>
            );
          })}

          {fetching && (
            <p className="text-[10px] text-neutral-400 px-2 py-1">
              Loading tokens...
            </p>
          )}

          {error && (
            <p className="text-[10px] text-red-400 px-2 py-1">{error}</p>
          )}

          {devOverride && (
            <button
              onClick={() => {
                setDevOverride(null);
                setLocation("/broker/deals");
                setExpanded(false);
              }}
              className="w-full text-[10px] text-neutral-400 hover:text-neutral-600 mt-1 pt-1 border-t border-neutral-100 py-1"
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
 * Export: renders in dev mode, or in production when ?switcher=1 is in the URL.
 */
export function RoleSwitcher() {
  const show = import.meta.env.DEV || new URLSearchParams(window.location.search).has("switcher");
  if (!show) return null;
  return <RoleSwitcherInner />;
}
