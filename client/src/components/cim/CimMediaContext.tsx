/**
 * CimMediaContext — how CIM media renderers fetch the deal's uploads.
 *
 * Uploaded photos/videos are private: GET /api/media/:id answers the owning
 * broker's session, the deal's seller token, or a buyer view token whose
 * CIM shows the file. The view room provides its token here; broker pages
 * need nothing (the session cookie is enough). The builder also provides the
 * library so the editing view can mark which photos a blind buyer sees.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { mediaSrc } from "@shared/cim-media";

export interface CimMediaAssetInfo {
  kind: "image" | "video";
  blindSafe: boolean;
  width?: number | null;
  height?: number | null;
}

interface CimMediaValue {
  buyerToken?: string | null;
  sellerToken?: string | null;
  /** The deal's library (broker pages only). */
  assets?: ReadonlyMap<string, CimMediaAssetInfo>;
}

const Ctx = createContext<CimMediaValue>({});

export function CimMediaProvider({ value, children }: { value: CimMediaValue; children: ReactNode }) {
  const memo = useMemo(() => value, [value.buyerToken, value.sellerToken, value.assets]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Ctx.Provider value={memo}>{children}</Ctx.Provider>;
}

export function useCimMedia() {
  const ctx = useContext(Ctx);
  return {
    assets: ctx.assets,
    src: (id: string) => mediaSrc(id, { buyerToken: ctx.buyerToken, sellerToken: ctx.sellerToken }),
  };
}
