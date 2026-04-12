/**
 * SellerLayout — Layout wrapper for seller-facing pages.
 *
 * Provides a minimal top bar (Cimple wordmark + deal name) and
 * sets the layout role to "seller" for RoleContext.
 *
 * All seller routes under /seller/:token/* render inside this layout,
 * EXCEPT /seller/:token/interview which is fullscreen (handled by
 * FullscreenLayout in App.tsx).
 */
import { Switch, Route, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useSetLayoutRole } from "@/contexts/RoleContext";
import SellerIntake from "@/pages/seller/SellerIntake";
import SellerProgress from "@/pages/seller/SellerProgress";
import SellerDocuments from "@/pages/seller/SellerDocuments";
import NotFound from "@/pages/not-found";

export default function SellerLayout() {
  useSetLayoutRole("seller");
  const [loc] = useLocation();

  // Extract token from /seller/:token or /seller/:token/sub-path
  const token = loc.match(/^\/seller\/([^/]+)/)?.[1] ?? null;

  const { data: inviteData } = useQuery<{ invite: any; deal: any }>({
    queryKey: ["/api/invites", token],
    enabled: !!token,
  });

  const businessName = inviteData?.deal?.businessName;

  return (
    <div className="h-screen w-full flex flex-col bg-background overflow-hidden">
      {/* Minimal top bar */}
      <div className="border-b border-border bg-card/50 px-4 py-2.5 flex items-center gap-3 shrink-0">
        <span className="text-sm font-semibold tracking-tight text-teal">
          cimple
        </span>
        {businessName && (
          <>
            <span className="text-muted-foreground/30">·</span>
            <span className="text-sm text-muted-foreground truncate">
              {businessName}
            </span>
          </>
        )}
      </div>
      {/* Content */}
      <div className="flex-1 overflow-auto">
        <Switch>
          <Route path="/seller/:token" component={SellerIntake} />
          <Route path="/seller/:token/progress" component={SellerProgress} />
          <Route
            path="/seller/:token/documents"
            component={SellerDocuments}
          />
          <Route component={NotFound} />
        </Switch>
      </div>
    </div>
  );
}
