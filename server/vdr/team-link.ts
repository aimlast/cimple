/**
 * A buyer's team member's link (vdr spec §6.1, V18): the view room answers
 * it with a redirect to the data room — a team member never sees the
 * memorandum. Only an ACTIVE member's token redirects; anything else is the
 * view room's ordinary "not found".
 */
import { dbVdrStore, type VdrStore } from "./store";
import { tokenHash } from "./access";

export async function teamLinkRedirect(token: string, store: VdrStore = dbVdrStore): Promise<string | null> {
  try {
    if (typeof token !== "string" || token.length < 8 || token.length > 200) return null;
    const member = await store.teamMemberByTokenHash(tokenHash(token));
    if (!member || member.status !== "active") return null;
    return `/view/${encodeURIComponent(token)}/data-room`;
  } catch {
    return null;
  }
}
