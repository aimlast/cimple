/**
 * UploadDropzone — drag & drop (or browse) photos/videos into the deal's
 * media library, with a progress bar per file. Each finished upload is
 * handed to `onUploaded` (e.g. the gallery editor adds it to the section).
 */
import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Upload, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { errorText } from "../api";
import { IMAGE_ACCEPT, VIDEO_ACCEPT, formatBytes, precheckFile, uploadMediaFile, type MediaItem } from "./api";

interface Job {
  id: number;
  name: string;
  size: number;
  progress: number;
  status: "uploading" | "done" | "failed";
  error?: string;
  abort?: () => void;
}

interface Props {
  dealId: string;
  kind?: "image" | "video";
  multiple?: boolean;
  compact?: boolean;
  onUploaded: (item: MediaItem) => void;
  disabled?: boolean;
}

let nextJob = 1;

export function UploadDropzone({ dealId, kind, multiple = true, compact, onUploaded, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const update = (id: number, patch: Partial<Job>) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...patch } : j)));

  const start = (files: File[]) => {
    const list = multiple ? files : files.slice(0, 1);
    for (const file of list) {
      const id = nextJob++;
      const problem = precheckFile(file, kind);
      if (problem) {
        setJobs((js) => [...js, { id, name: file.name, size: file.size, progress: 0, status: "failed", error: problem }]);
        continue;
      }
      const { promise, abort } = uploadMediaFile(dealId, file, (p) => update(id, { progress: p }));
      setJobs((js) => [...js, { id, name: file.name, size: file.size, progress: 0, status: "uploading", abort }]);
      promise
        .then((item) => {
          update(id, { status: "done", progress: 1, abort: undefined });
          onUploaded(item);
          // Finished rows fade out of the list after a moment.
          setTimeout(() => setJobs((js) => js.filter((j) => j.id !== id)), 2500);
        })
        .catch((err) => update(id, { status: "failed", error: errorText(err), abort: undefined }));
    }
  };

  const accept = kind === "image" ? IMAGE_ACCEPT : kind === "video" ? VIDEO_ACCEPT : `${IMAGE_ACCEPT},${VIDEO_ACCEPT}`;
  const what = kind === "image" ? "photos" : kind === "video" ? "a video" : "photos or videos";
  const limits = kind === "image" ? "JPG, PNG, WebP or GIF · up to 15 MB" : kind === "video" ? "MP4, MOV or WebM · up to 150 MB" : "Photos up to 15 MB · videos up to 150 MB";

  return (
    <div className="space-y-2">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => { if (!disabled && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); inputRef.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled) start(Array.from(e.dataTransfer.files || []));
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-center transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-teal",
          compact ? "px-3 py-3" : "px-4 py-6",
          over ? "border-teal bg-teal/10" : "border-border hover:border-teal/50 hover:bg-muted/30",
          disabled && "opacity-50 cursor-not-allowed",
        )}
        data-testid={`dropzone-${kind ?? "media"}`}
      >
        <Upload className={cn("text-muted-foreground", compact ? "h-4 w-4" : "h-5 w-5")} />
        <p className="text-xs font-medium">
          Drop {what} here or <span className="text-teal underline-offset-2 hover:underline">browse</span>
        </p>
        {!compact && <p className="text-[10px] text-muted-foreground">{limits}</p>}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          className="hidden"
          onChange={(e) => {
            start(Array.from(e.target.files || []));
            e.target.value = "";
          }}
        />
      </div>
      {jobs.length > 0 && (
        <ul className="space-y-1.5">
          {jobs.map((j) => (
            <li key={j.id} className="rounded-md border border-border px-2.5 py-1.5 text-[11px]">
              <div className="flex items-center gap-2">
                {j.status === "uploading" ? (
                  <Loader2 className="h-3 w-3 animate-spin text-teal shrink-0" />
                ) : j.status === "done" ? (
                  <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                ) : (
                  <AlertTriangle className="h-3 w-3 text-red-400 shrink-0" />
                )}
                <span className="truncate flex-1 min-w-0">{j.name}</span>
                <span className="text-muted-foreground tabular-nums shrink-0">
                  {j.status === "uploading" ? `${Math.round(j.progress * 100)}%` : formatBytes(j.size)}
                </span>
                {(j.status === "failed" || j.status === "uploading") && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={j.status === "uploading" ? "Cancel upload" : "Dismiss"}
                    onClick={() => { j.abort?.(); setJobs((js) => js.filter((x) => x.id !== j.id)); }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              {j.status === "uploading" && (
                <div className="mt-1 h-1 rounded-full bg-muted overflow-hidden">
                  <div className="h-full bg-teal transition-[width] duration-200" style={{ width: `${Math.max(3, j.progress * 100)}%` }} />
                </div>
              )}
              {j.status === "failed" && j.error && <p className="mt-0.5 text-red-400 leading-snug">{j.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
