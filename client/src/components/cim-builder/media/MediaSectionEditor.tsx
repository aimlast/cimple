/** The inspector's content editor for photo gallery, video and map sections. */
import { GalleryEditor } from "./GalleryEditor";
import { VideoEditor } from "./VideoEditor";
import { MapEditor } from "./MapEditor";
import { useMediaLibrary, type MediaDraftChange } from "./api";

interface Props {
  dealId: string;
  layoutType: string;
  value: Record<string, any>;
  onChange: MediaDraftChange;
  disabled?: boolean;
}

export function MediaSectionEditor({ dealId, layoutType, value, onChange, disabled }: Props) {
  const library = useMediaLibrary(dealId);
  if (layoutType === "image_gallery") return <GalleryEditor dealId={dealId} value={value} onChange={onChange} library={library} disabled={disabled} />;
  if (layoutType === "video") return <VideoEditor dealId={dealId} value={value} onChange={onChange} library={library} disabled={disabled} />;
  if (layoutType === "location_map") return <MapEditor value={value} onChange={onChange} disabled={disabled} />;
  return null;
}
