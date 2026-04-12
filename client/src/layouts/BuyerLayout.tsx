/**
 * BuyerLayout — Layout wrapper for all buyer-facing pages.
 *
 * Sets the layout role to "buyer" for RoleContext and routes
 * to the correct buyer page. Three visual modes (handled by
 * the individual page components, not by this layout):
 *
 *  1. AUTH — centered card for /buyer/login, /signup, /set-password
 *     Pages use BuyerAuthCard from shared.tsx.
 *
 *  2. NAV — top navigation bar for /buyer/dashboard, /buyer/profile
 *     Pages use BuyerNav from shared.tsx.
 *
 *  3. IMMERSIVE — no layout chrome for /view/:token, /review/:token
 *     Pages (BuyerViewRoom, BuyerApprovalReviewPage) handle their
 *     own fullscreen layout with watermarks, NDA gates, etc.
 *
 * All buyer routes render inside this layout, including /view/:token
 * and /review/:token (which use different token tables but are
 * buyer-facing experiences).
 */
import { Switch, Route } from "wouter";
import { useSetLayoutRole } from "@/contexts/RoleContext";
import BuyerLogin from "@/pages/buyer/BuyerLogin";
import BuyerSignup from "@/pages/buyer/BuyerSignup";
import BuyerSetPassword from "@/pages/buyer/BuyerSetPassword";
import BuyerDashboard from "@/pages/buyer/BuyerDashboard";
import BuyerProfile from "@/pages/buyer/BuyerProfile";
import BuyerViewRoom from "@/pages/buyer/BuyerViewRoom";
import BuyerApprovalReviewPage from "@/pages/buyer/BuyerApprovalReviewPage";
import NotFound from "@/pages/not-found";

export default function BuyerLayout() {
  useSetLayoutRole("buyer");

  return (
    <div className="h-screen w-full overflow-auto bg-background">
      <Switch>
        {/* Auth pages (centered card mode) */}
        <Route path="/buyer/login" component={BuyerLogin} />
        <Route path="/buyer/signup" component={BuyerSignup} />
        <Route path="/buyer/set-password/:token" component={BuyerSetPassword} />
        {/* Nav pages (top bar mode) */}
        <Route path="/buyer/dashboard" component={BuyerDashboard} />
        <Route path="/buyer/profile" component={BuyerProfile} />
        {/* Immersive pages (no chrome — pages handle their own layout) */}
        <Route path="/view/:token" component={BuyerViewRoom} />
        <Route path="/review/:token" component={BuyerApprovalReviewPage} />
        <Route component={NotFound} />
      </Switch>
    </div>
  );
}
