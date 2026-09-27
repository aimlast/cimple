/**
 * Where a buyer's reply to broker outreach goes. Outreach emails end "just
 * reply and I'll set up secure access", so replies must reach the broker's
 * own inbox (Reply-To), never Cimple's unmonitored sender address. Null when
 * the broker has no usable email on file — the send is then refused.
 */
export function outreachReplyTo(user: { email?: string | null } | null | undefined): string | null {
  const email = user?.email?.trim();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * The broker's name as buyers and sellers see it: the display name on their
 * account, or null. Never the login username — it is half of the broker's
 * credentials (observed: "broker_demo via Cimple" on the From line of
 * outreach from an account with no display name).
 */
export function brokerDisplayName(user: { name?: string | null } | null | undefined): string | null {
  const name = user?.name?.trim();
  return name ? name : null;
}

/**
 * The From-line display name for email sent on the broker's behalf
 * ("Jane Smith via Cimple"). Without a display name, the brokerage's name
 * from their branding; with neither, null (the default "Cimple" sender).
 */
export function outreachFromName(
  user: { name?: string | null } | null | undefined,
  companyName?: string | null,
): string | null {
  const who = brokerDisplayName(user) || companyName?.trim() || null;
  return who ? `${who} via Cimple` : null;
}
