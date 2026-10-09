/**
 * The gl contract (dd spec §11.2, gl spec §8.1.5, INTEGRATION §2.7 rule 6):
 * an earnings-bridge row that is a general-ledger add-back line carries gl's
 * "Found in the books" mark (`<GlMark lineId variant="row" />`), and its
 * popover links to gl's "Where each add-back is in the books" page.
 *
 *   bridge lines   the CIM's bridge add-backs with gl's `addbackId`
 *                  (`CimBridgeLine.addbackId`, added by gl in cim-financials.ts)
 *   line ids       gl's `glLineIdsForDeal(dealId)`: add-back id → lineId
 *
 * Wired at the dd merge: `glLineIdsFor` is gl's `glLineIdsForDeal`, and
 * `client/src/components/cim/figures/GlMarkSlot.tsx` renders gl's `GlMark`
 * (shown only when gl's published payload has that line's mark on). The layer
 * never emits marks in the Blind CIM. dd never writes add-back notes (that is
 * gl's `why`).
 */
import type { GlBridgeLine } from "@shared/figure-anchors";

/** A bridge add-back as the figure inputs keep it (gl adds `addbackId`). */
export interface BridgeAddback {
  label: string;
  amounts: Record<string, number>;
  addbackId?: string | null;
}

let lineIdsSeam: ((dealId: string) => Promise<Map<string, string>>) | null = null;
export function _setGlLineIdsForTests(fn: ((dealId: string) => Promise<Map<string, string>>) | null): void {
  lineIdsSeam = fn;
}

/** gl's add-back id → ledger line id for this deal (gl's glLineIdsForDeal). */
export async function glLineIdsFor(dealId: string): Promise<Map<string, string>> {
  if (lineIdsSeam) return lineIdsSeam(dealId);
  const { glLineIdsForDeal } = await import("../../gl/evidence");
  return glLineIdsForDeal(dealId);
}

/** The bridge's add-backs with a ledger line (pure). */
export function glLinesFrom(bridge: BridgeAddback[] | null | undefined, ids: Map<string, string>): GlBridgeLine[] {
  if (!bridge || ids.size === 0) return [];
  const out: GlBridgeLine[] = [];
  for (const b of bridge) {
    const id = b.addbackId ? ids.get(b.addbackId) : undefined;
    if (!id) continue;
    out.push({ lineId: id, label: b.label, amounts: { ...b.amounts } });
  }
  return out;
}

/** The figure inputs with the gl lines attached (unchanged when there are none). */
export async function withGlLines<T extends { glLines?: GlBridgeLine[] }>(inputs: T | null, dealId: string, bridge: BridgeAddback[] | null | undefined): Promise<T | null> {
  if (!inputs || !bridge || bridge.length === 0) return inputs;
  try {
    const lines = glLinesFrom(bridge, await glLineIdsFor(dealId));
    return lines.length > 0 ? { ...inputs, glLines: lines } : inputs;
  } catch (err) {
    console.warn("[figures] gl lines:", (err as Error)?.message);
    return inputs;
  }
}
