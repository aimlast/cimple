/**
 * CRM Sync Service
 *
 * Moves a deal to a new pipeline stage in the broker's connected CRM
 * when a buyer submits their decision on a CIM.
 *
 * Supported providers:
 *   - pipedrive (primary, full implementation)
 *   - hubspot (stub — ready for API keys)
 *   - salesforce (stub — ready for API keys)
 *
 * CRM configuration is stored on integrations.config as CrmStageMapping.
 * The integration row is keyed by brokerId + provider.
 *
 * Graceful degradation: when no CRM is connected or credentials missing,
 * logs to console and returns { status: "not_configured" }.
 */
import { storage } from "../storage";
import type { Deal, Integration, CrmStageMapping } from "@shared/schema";
import { pd, PipedriveError } from "./pipedrive";

export type SyncResult =
  | { status: "synced"; provider: string; action: string }
  | { status: "failed"; provider: string; error: string }
  /** Nothing to do: no CRM connected, or the CRM is connected but this deal /
   *  this decision has no stage mapping. `reason` is the broker-facing line. */
  | { status: "not_configured"; provider?: string; reason?: string };

export type BuyerAction = "interested" | "not_interested";

const CRM_PROVIDERS = ["pipedrive", "hubspot", "salesforce"] as const;

// ── Provider labels for user-facing messages ────────────────────────────

export function crmProviderLabel(provider: string): string {
  switch (provider) {
    case "pipedrive": return "Pipedrive";
    case "hubspot": return "HubSpot";
    case "salesforce": return "Salesforce";
    default: return provider;
  }
}

/**
 * Human-readable description of what the sync does in each CRM for the
 * given buyer action. Used inside notification emails so the broker knows
 * exactly what happened automatically.
 */
export function describeCrmAction(provider: string | null | undefined, action: BuyerAction): string {
  const label = provider ? crmProviderLabel(provider) : "your CRM";
  if (!provider) {
    return "No CRM is connected, so no pipeline stage was updated automatically.";
  }
  switch (action) {
    case "interested":
      return `The deal has been moved to the "Buyer/Seller Meeting" stage in your ${label} pipeline.`;
    case "not_interested":
      return `The deal has been moved to the "Lost" stage in your ${label} pipeline.`;
  }
}

// ── Integration lookup ──────────────────────────────────────────────────

async function findConnectedCrm(brokerId: string): Promise<Integration | null> {
  const integrations = await storage.getIntegrationsByBroker(brokerId);
  for (const provider of CRM_PROVIDERS) {
    const match = integrations.find(
      (i) => i.provider === provider && i.status === "connected",
    );
    if (match) return match;
  }
  return null;
}

// ── Pipedrive adapter ───────────────────────────────────────────────────

async function syncPipedrive(
  integration: Integration,
  deal: Deal,
  action: BuyerAction,
): Promise<SyncResult> {
  const token = integration.accessToken;
  if (!token) {
    return { status: "failed", provider: "pipedrive", error: "Missing API token" };
  }

  const mapping = (integration.config || {}) as CrmStageMapping;
  const pipedriveDealId = mapping.dealFieldMapping?.[deal.id];
  // No stage mapping for this deal is a normal state (nothing to update), not
  // a failure — reporting "failed" emailed the broker an alarming "CRM
  // auto-update failed" on every buyer decision. Note: deals.crmLink (the
  // seller's CRM record, used for importing information) is deliberately NOT
  // used here — moving the seller's listing deal to "lost" because one buyer
  // declined would be wrong.
  if (!pipedriveDealId) {
    return {
      status: "not_configured",
      provider: "pipedrive",
      reason: "Pipedrive is connected, but this deal isn't set up for automatic pipeline updates, so nothing was changed in Pipedrive.",
    };
  }

  let stageId: number | string | undefined;
  let newStatus: "open" | "lost" | undefined;
  let lostReason: string | undefined;

  switch (action) {
    case "interested":
      stageId = mapping.stageInterested;
      break;
    case "not_interested":
      stageId = mapping.stageNotInterested;
      newStatus = "lost";
      lostReason = "Buyer reviewed CIM and declined";
      break;
  }

  // "Interested" without a stage has nothing meaningful to move (a PUT of
  // status "open" alone changed nothing but was reported as "moved to the
  // meeting stage"). "Not interested" still marks the deal lost.
  if (!stageId && !newStatus) {
    return {
      status: "not_configured",
      provider: "pipedrive",
      reason: "Pipedrive is connected, but no pipeline stage is set for this decision, so nothing was changed in Pipedrive.",
    };
  }

  try {
    const body: Record<string, any> = {};
    if (stageId) body.stage_id = stageId;
    if (newStatus) body.status = newStatus;
    if (lostReason) body.lost_reason = lostReason;

    await pd(token, `/v1/deals/${encodeURIComponent(String(pipedriveDealId))}`, {}, { method: "PUT", body });

    return {
      status: "synced",
      provider: "pipedrive",
      action: action === "interested" ? "moved to buyer-meeting stage" : "marked as lost",
    };
  } catch (err: any) {
    const message = err instanceof PipedriveError ? err.message : err?.message || "Unknown error";
    return { status: "failed", provider: "pipedrive", error: message };
  }
}

// ── HubSpot adapter (stub) ──────────────────────────────────────────────

async function syncHubspot(
  integration: Integration,
  _deal: Deal,
  _action: BuyerAction,
): Promise<SyncResult> {
  // TODO: implement HubSpot deal stage update via v3 CRM API
  // PATCH /crm/v3/objects/deals/{dealId} with { properties: { dealstage: stageId } }
  console.log(`[crm:hubspot] stub — integration ${integration.id} action ${_action}`);
  return { status: "not_configured", provider: "hubspot", reason: "Automatic HubSpot pipeline updates aren't available yet, so nothing was changed in HubSpot." };
}

// ── Salesforce adapter (stub) ───────────────────────────────────────────

async function syncSalesforce(
  integration: Integration,
  _deal: Deal,
  _action: BuyerAction,
): Promise<SyncResult> {
  // TODO: Salesforce Opportunity.StageName update via REST API
  console.log(`[crm:salesforce] stub — integration ${integration.id} action ${_action}`);
  return { status: "not_configured", provider: "salesforce", reason: "Automatic Salesforce pipeline updates aren't available yet, so nothing was changed in Salesforce." };
}

// ── Main entry point ────────────────────────────────────────────────────

export async function syncDealToCrm(deal: Deal, action: BuyerAction): Promise<SyncResult> {
  try {
    const integration = await findConnectedCrm(deal.brokerId);
    if (!integration) {
      console.log(`[crm:sync] No connected CRM for broker ${deal.brokerId}`);
      return { status: "not_configured" };
    }

    switch (integration.provider) {
      case "pipedrive": return await syncPipedrive(integration, deal, action);
      case "hubspot":   return await syncHubspot(integration, deal, action);
      case "salesforce":return await syncSalesforce(integration, deal, action);
      default:
        return { status: "failed", provider: integration.provider, error: "Unsupported CRM provider" };
    }
  } catch (err: any) {
    console.error("[crm:sync] Unexpected error:", err);
    return { status: "failed", provider: "unknown", error: err?.message || "Unknown error" };
  }
}

/** Get the connected CRM provider name for a broker (for UI display). */
export async function getConnectedCrmProvider(brokerId: string): Promise<string | null> {
  const integration = await findConnectedCrm(brokerId);
  return integration?.provider || null;
}
