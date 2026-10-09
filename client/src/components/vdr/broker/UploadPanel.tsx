/**
 * Uploading into the data room (vdr spec §5.6): the Upload button, files or
 * whole folders dropped on a folder, 3 uploads at a time, a progress panel
 * at the bottom right, plain reasons for refused files, and — when more than
 * 10 files arrive at once — the question whether to read them for the CIM's
 * facts or just store them. Every upload is also a normal deal document.
 */
import { useCallback, useRef, useState } from "react";
import { CheckCircle2, Loader2, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { VDR_LIMITS, extensionOf } from "@shared/vdr";
import type { RoomFolderRow } from "@shared/vdr-api";
import { invalidateRoom, roomBase, vdrFetch } from "@/hooks/useDataRoom";

export type UploadEntry = { file: File; dirs: string[] };
type Job = { id: number; name: string; status: "queued" | "uploading" | "done" | "failed"; reason?: string };

export const UPLOAD_ACCEPT = VDR_LIMITS.uploadExtensions.join(",");

/** Plain words for a file the room won't take (the server says the same). */
export function refusalFor(file: File): string | null {
  const ext = extensionOf(file.name);
  if (ext === ".heic" || ext === ".heif") return ".heic (iPhone photo): share it as a JPEG, or set the camera to 'Most compatible'.";
  if (ext === ".zip") return ".zip: unzip it first and drop the folder.";
  if (!VDR_LIMITS.uploadExtensions.includes(ext)) return `${ext || "These"} files can't go in the data room.`;
  if (file.size > VDR_LIMITS.uploadBytes) return "Too large (over 20 MB). Save a smaller copy or split it.";
  return null;
}

/** Files (and whole folders) from a drop, with each file's sub-folder path. */
export async function droppedEntries(dt: DataTransfer): Promise<UploadEntry[]> {
  const out: UploadEntry[] = [];
  const items = Array.from(dt.items ?? []);
  const entries = items.map((i) => (typeof (i as any).webkitGetAsEntry === "function" ? (i as any).webkitGetAsEntry() : null)).filter(Boolean);
  if (entries.length === 0) return Array.from(dt.files ?? []).map((file) => ({ file, dirs: [] }));
  const walk = async (entry: any, dirs: string[]): Promise<void> => {
    if (out.length > 500) return;
    if (entry.isFile) {
      const file: File = await new Promise((res, rej) => entry.file(res, rej));
      if (!file.name.startsWith(".")) out.push({ file, dirs });
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const children: any[] = [];
      for (;;) {
        const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        children.push(...batch);
      }
      for (const c of children) await walk(c, [...dirs, entry.name]);
    }
  };
  for (const e of entries) await walk(e, []);
  // A dropped folder's own name is the first part of every path: files land in it.
  return out;
}

export function useRoomUploads(dealId: string) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [question, setQuestion] = useState<{ count: number; go: (read: "yes" | "store_only" | null) => void } | null>(null);
  const seq = useRef(0);
  const patch = (id: number, p: Partial<Job>) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...p } : j)));

  const start = useCallback(async (entries: UploadEntry[], folderId: string, folders: RoomFolderRow[]) => {
    const fresh: Array<Job & { entry: UploadEntry }> = entries.map((entry) => ({ id: ++seq.current, name: [...entry.dirs, entry.file.name].join("/"), status: "queued", entry }));
    const refused = fresh.filter((j) => refusalFor(j.entry.file)).map((j) => ({ ...j, status: "failed" as const, reason: refusalFor(j.entry.file)! }));
    const ok = fresh.filter((j) => !refusalFor(j.entry.file));
    setJobs((js) => [...js, ...refused.map(({ entry: _e, ...j }) => j), ...ok.map(({ entry: _e, ...j }) => j)]);
    if (ok.length === 0) return;
    const read: "yes" | "store_only" | null = ok.length > 10 ? await new Promise((resolve) => setQuestion({ count: ok.length, go: resolve })) : "yes";
    setQuestion(null);
    if (!read) {
      for (const j of ok) patch(j.id, { status: "failed", reason: "Not uploaded." });
      return;
    }
    // Recreate dropped sub-folders (up to three levels deep in all; deeper files land in the deepest allowed).
    const base = folders.find((f) => f.id === folderId);
    const baseDepth = base?.depth ?? 1;
    const made = new Map<string, string>();
    let known = folders.slice();
    const folderFor = async (dirs: string[]): Promise<string> => {
      let parent = folderId;
      let depth = baseDepth;
      for (let i = 0; i < dirs.length && depth < VDR_LIMITS.folderDepth; i++) {
        const key = `${parent}/${dirs[i]}`;
        const existing = made.get(key) ?? known.find((f) => f.parentId === parent && f.name.toLowerCase() === dirs[i].toLowerCase())?.id;
        if (existing) { parent = existing; depth++; continue; }
        const f = await vdrFetch<{ id: string }>("POST", `${roomBase(dealId)}/folders`, { name: dirs[i].slice(0, VDR_LIMITS.folderName), parentId: parent });
        made.set(key, f.id);
        known = [...known, { id: f.id, parentId: parent, name: dirs[i], position: 0, presetKey: null, number: "", depth: depth + 1, count: 0, shareHint: null }];
        parent = f.id;
        depth++;
      }
      return parent;
    };
    // Folders first, one at a time (two files of one new folder must not create it twice).
    const targets = new Map<number, string>();
    for (const j of ok) {
      try { targets.set(j.id, await folderFor(j.entry.dirs)); } catch (e: any) { targets.set(j.id, folderId); }
    }
    const queue = ok.slice();
    const worker = async () => {
      for (;;) {
        const j = queue.shift();
        if (!j) return;
        patch(j.id, { status: "uploading" });
        try {
          const target = targets.get(j.id) ?? folderId;
          const fd = new FormData();
          fd.append("folderId", target);
          fd.append("read", read);
          fd.append("file", j.entry.file);
          const res = await fetch(`${roomBase(dealId)}/upload`, { method: "POST", body: fd, credentials: "include" });
          const json = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(typeof json?.error === "string" ? json.error : "Upload failed.");
          patch(j.id, { status: "done" });
        } catch (e: any) {
          patch(j.id, { status: "failed", reason: e?.message || "Upload failed." });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    invalidateRoom(dealId);
  }, [dealId]);

  return { jobs, start, clear: () => setJobs([]), question };
}

export function UploadPanel({ jobs, onClose, question }: { jobs: ReturnType<typeof useRoomUploads>["jobs"]; onClose: () => void; question: ReturnType<typeof useRoomUploads>["question"] }) {
  const done = jobs.filter((j) => j.status === "done").length;
  const busy = jobs.some((j) => j.status === "queued" || j.status === "uploading");
  return (
    <>
      {jobs.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 w-[min(380px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-card shadow-xl" data-testid="upload-panel">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <p className="text-sm font-medium">{busy ? `Uploading ${jobs.length} ${jobs.length === 1 ? "file" : "files"}… ${done} done` : `${done} of ${jobs.length} uploaded`}</p>
            {!busy && <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>}
          </div>
          <ul className="max-h-60 overflow-y-auto px-3 py-2 text-xs">
            {jobs.map((j) => (
              <li key={j.id} className="flex items-start gap-2 py-1">
                {j.status === "done" ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> : j.status === "failed" ? <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" /> : <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{j.name}</span>
                  {j.reason && <span className="block text-muted-foreground">{j.reason}</span>}
                </span>
              </li>
            ))}
          </ul>
          <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">Uploaded files are also read for the CIM's facts, like any document. To share an email, save it as a PDF and upload it.</p>
        </div>
      )}
      <AlertDialog open={!!question} onOpenChange={(o) => { if (!o) question?.go(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Read these {question?.count} files for the CIM's facts?</AlertDialogTitle>
            <AlertDialogDescription>Cimple reads each one like any document you upload. You can also just store them in the data room and read any of them later.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => question?.go("store_only")}>Just store them in the data room</AlertDialogCancel>
            <AlertDialogAction onClick={() => question?.go("yes")}>Read them (recommended)</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
