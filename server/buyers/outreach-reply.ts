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
