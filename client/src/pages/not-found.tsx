import { Link, useLocation } from "wouter";
import { ArrowLeft, Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRole } from "@/contexts/RoleContext";

/**
 * 404 — rendered inside whichever layout matched the URL, so it uses the
 * app's theme tokens (dark by default) and always offers a way back that
 * makes sense for the current role:
 *   broker → dashboard / deals
 *   seller → their progress page (token recovered from the URL)
 *   buyer  → dashboard (or sign-in)
 */
export default function NotFound() {
  const { role } = useRole();
  const [location] = useLocation();

  // Seller/buyer token pages: /seller/<token>/…, /view/<token>, /approve/<token>
  const sellerToken = location.match(/^\/(?:seller|invite)\/([^/]+)/)?.[1] ?? null;

  let primary: { href: string; label: string; testId: string };
  let secondary: { href: string; label: string; testId: string } | null = null;
  let hint: string;

  if (role === "seller") {
    primary = sellerToken
      ? { href: `/seller/${sellerToken}/progress`, label: "Back to your progress", testId: "button-back-progress" }
      : { href: "/", label: "Back to Cimple", testId: "button-back-home" };
    hint = sellerToken
      ? "The link may be out of date, or the page may have moved. Your progress is saved — head back to continue."
      : "This link may be incomplete. Please use the link your broker sent you, or ask them to resend it.";
  } else if (role === "buyer") {
    primary = { href: "/buyer/dashboard", label: "Back to your dashboard", testId: "button-back-dashboard" };
    secondary = { href: "/buyer/login", label: "Sign in", testId: "button-go-login" };
    hint = "The link may be out of date, or the page may have moved. If you were sent a viewing link, please use it exactly as it appeared in your email.";
  } else {
    primary = { href: "/broker", label: "Back to dashboard", testId: "button-back-dashboard" };
    secondary = { href: "/broker/deals", label: "View deals", testId: "button-go-deals" };
    hint = "The link may be out of date, or the page may have moved. Check the address, or head back to your dashboard.";
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background px-6">
      <div className="w-full max-w-md rounded-xl border border-card-border bg-card p-8 text-center" data-testid="page-not-found">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-teal-muted">
          <Compass className="h-6 w-6 text-teal" />
        </div>
        <p className="font-mono text-2xs uppercase tracking-[0.18em] text-muted-foreground/70 mb-2">
          404
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          We couldn't find that page
        </h1>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{hint}</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Link href={primary.href}>
            <Button className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5" data-testid={primary.testId}>
              <ArrowLeft className="h-4 w-4" />
              {primary.label}
            </Button>
          </Link>
          {secondary && (
            <Link href={secondary.href}>
              <Button variant="outline" data-testid={secondary.testId}>
                {secondary.label}
              </Button>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
