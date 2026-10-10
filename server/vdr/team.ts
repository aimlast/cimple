/**
 * A buyer's team in the data room (vdr spec §6.8, V18; §4.10).
 *
 * A buyer with the room may have up to 5 people (accountant, lawyer, lender,
 * adviser, colleague). Each gets their OWN link (only its hash is stored),
 * their own watermark and their own "I'll keep this confidential" step — no
 * buyer-profile form — and sees exactly the buyer's room (the principal's
 * best live link, re-read on every request). They never see the
 * memorandum, can't decide, can't add people, and lose access the moment
 * the buyer does. The broker adds them (or approves the buyer's ask); the
 * link goes out only on the broker's click ("Send the link") or is copied.
 * Because only a hash is kept, "Copy a new link" / "Send the link again"
 * make a NEW link and the old one stops working.
 */
import { randomBytes } from "crypto";
import type { BuyerAccess, VdrTeamMember } from "@shared/schema";
import { buyerKey } from "@shared/vdr";
import { tokenHash } from "./access";

export const TEAM_MAX = 5;
export const TEAM_ROLES = ["accountant", "lawyer", "lender", "adviser", "colleague"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const TEAM_ROLE_LABEL: Record<TeamRole, string> = { accountant: "Accountant", lawyer: "Lawyer", lender: "Lender", adviser: "Adviser", colleague: "Colleague" };

const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[A-Za-z]{2,}$/;

export type TeamInput = { name: string; email: string; role: TeamRole };

/** `{ name, email, role }` → clean input, or the plain reason it can't be used. */
export function parseTeamInput(body: unknown): TeamInput | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim() : "";
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  const role = typeof b.role === "string" ? b.role.trim().toLowerCase() : "";
  if (!name) return { error: "Type their name." };
  if (name.length > 120) return { error: "Keep the name under 120 characters." };
  if (!EMAIL.test(email) || email.length > 200) return { error: "Type a valid email address." };
  if (!(TEAM_ROLES as readonly string[]).includes(role)) return { error: "Choose their role: accountant, lawyer, lender, adviser or colleague." };
  return { name, email, role: role as TeamRole };
}

/** People who count toward the 5 (asked for or active). */
export function teamCount(members: ReadonlyArray<Pick<VdrTeamMember, "principalEmail" | "status">>, principalEmail: string): number {
  const key = buyerKey(principalEmail);
  return members.filter((m) => m.principalEmail === key && (m.status === "active" || m.status === "requested")).length;
}

/** Why this person can't be added (null when they can). */
export function teamAddProblem(
  members: ReadonlyArray<Pick<VdrTeamMember, "principalEmail" | "email" | "status">>,
  principal: Pick<BuyerAccess, "buyerEmail">,
  input: Pick<TeamInput, "email">,
): string | null {
  const key = buyerKey(principal.buyerEmail);
  if (buyerKey(input.email) === key) return "That's the buyer's own address. They already have the room.";
  const same = members.find((m) => m.principalEmail === key && m.email === buyerKey(input.email));
  if (same && (same.status === "active" || same.status === "requested")) return same.status === "active" ? "They're already on this buyer's team." : "This buyer already asked to add them. Approve it in To do.";
  if (teamCount(members, key) >= TEAM_MAX) return `A buyer can have up to ${TEAM_MAX} people on their team. Remove someone first.`;
  return null;
}

/** A new link token and the hash that is stored (the token itself never is). */
export function newTeamToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: tokenHash(token) };
}

export function teamLinkUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}/view/${encodeURIComponent(token)}/data-room`;
}

/** The link email's words (§6.8): who invited them, never the business's name. */
export function teamLinkEmail(principalCompany: string): { subject: string; message: string } {
  return {
    subject: `${principalCompany} invited you to review documents`,
    message: `${principalCompany} has invited you to review documents for a business they're considering.\n\nThe documents are confidential. You'll be asked to confirm that before the data room opens.`,
  };
}

/** "Priya Shah · accountant" */
export function memberLabel(m: Pick<VdrTeamMember, "name" | "role">): string {
  const role = (TEAM_ROLES as readonly string[]).includes(m.role) ? m.role : "adviser";
  return `${m.name} · ${role}`;
}

/** The principal's display name for team screens. */
export function principalCompanyOf(link: Pick<BuyerAccess, "buyerCompany" | "buyerName" | "buyerEmail">): string {
  return (link.buyerCompany || link.buyerName || link.buyerEmail || "The buyer").trim();
}
