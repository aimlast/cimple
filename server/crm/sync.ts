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

export type SyncResult =
  | { status: "synced"; provider: string; action: string }
  | { status: "failed"; provider: string; error: string }
  | { status: "not_configured" };

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
  if (!pipedriveDealId) {
    return {
      status: "failed",
      provider: "pipedrive",
      error: `No Pipedrive deal mapped for Cimple deal ${deal.id}. Link the deal in Settings → Integrations.`,
    };
  }

  let stageId: number | string | undefined;
  let newStatus: "open" | "lost" | "won" | undefined;
  let lostReason: string | undefined;

  switch (action) {
    case "interested":
      stageId = mapping.stageInterested;
      newStatus = "open";
      break;
    case "not_interested":
      stageId = mapping.stageNotInterested;
      newStatus = "lost";
      lostReason = "Buyer reviewed CIM and declined";
      break;
  }

  if (!stageId && !newStatus) {
    return {
      status: "failed",
      provider: "pipedrive",
      error: "No stage mapping configured for this action. Configure stages in Settings → Integrations.",
    };
  }

  try {
    const body: Record<string, any> = {};
    if (stageId) body.stage_id = stageId;
    if (newStatus) body.status = newStatus;
    if (lostReason) body.lost_reason = lostReason;

    const res = await fetch(
      `https://api.pipedrive.com/v1/deals/${pipedriveDealId}?api_token=${token}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const errText = await res.text();
      return { status: "failed", provider: "pipedrive", error: `Pipedrive API error: ${errText.slice(0, 200)}` };
    }

    return {
      status: "synced",
      provider: "pipedrive",
      action: action === "interested" ? "moved to buyer-meeting stage" : "marked as lost",
    };
  } catch (err: any) {
    return { status: "failed", provider: "pipedrive", error: err?.message || "Unknown error" };
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
  return { status: "failed", provider: "hubspot", error: "HubSpot CRM sync not yet implemented. Needs HUBSPOT_CLIENT_ID/SECRET." };
}

// ── Salesforce adapter (stub) ───────────────────────────────────────────

async function syncSalesforce(
  integration: Integration,
  _deal: Deal,
  _action: BuyerAction,
): Promise<SyncResult> {
  // TODO: Salesforce Opportunity.StageName update via REST API
  console.log(`[crm:salesforce] stub — integration ${integration.id} action ${_action}`);
  return { status: "failed", provider: "salesforce", error: "Salesforce CRM sync not yet implemented. Needs SF_CLIENT_ID/SECRET." };
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
