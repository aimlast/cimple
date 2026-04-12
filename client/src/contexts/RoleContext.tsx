/**
 * RoleContext — Holds the current user role only.
 *
 * Role is set by layout components on mount:
 *   BrokerLayout → 'broker'
 *   SellerLayout → 'seller'  (future PR 2)
 *   BuyerLayout  → 'buyer'   (future PR 3)
 *
 * The dev role switcher can override this for testing.
 *
 * Deal IDs and tokens are NOT stored here — they come from
 * useParams() at the route level. This context holds role only.
 */
import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";

export type Role = "broker" | "seller" | "buyer";

interface RoleContextValue {
  /** Current effective role (devOverride ?? layoutRole) */
  role: Role;
  /** Called by layout components to declare their role on mount */
  setLayoutRole: (role: Role) => void;
  /** Set by dev switcher to override the layout role. Pass null to clear. */
  setDevOverride: (role: Role | null) => void;
  /** Current dev override (null when not overridden) */
  devOverride: Role | null;
}

const RoleContext = createContext<RoleContextValue | null>(null);

export function useRole(): RoleContextValue {
  const ctx = useContext(RoleContext);
  if (!ctx) {
    throw new Error("useRole() must be used within a <RoleProvider>");
  }
  return ctx;
}

export function RoleProvider({ children }: { children: ReactNode }) {
  const [layoutRole, setLayoutRole] = useState<Role>("broker");
  const [devOverride, setDevOverride] = useState<Role | null>(null);

  return (
    <RoleContext.Provider
      value={{
        role: devOverride ?? layoutRole,
        setLayoutRole,
        setDevOverride,
        devOverride,
      }}
    >
      {children}
    </RoleContext.Provider>
  );
}

/**
 * Hook for layout components to declare their role on mount.
 * Does not override the dev switcher.
 */
export function useSetLayoutRole(role: Role) {
  const { setLayoutRole } = useRole();
  useEffect(() => {
    setLayoutRole(role);
  }, [role, setLayoutRole]);
}
