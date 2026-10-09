/**
 * The Zoom / Meet / Teams notetaker's state on the board (specs/together.md
 * §4.5): the server asks Recall every 5 s while the bot isn't recording
 * (every 30 s while it is) and pushes a `listen` event when the state
 * changes; webhook participant events and transcript lines update it too.
 * "The notetaker hasn't sent anything for a minute." when a recording bot
 * has been quiet for 60 s.
 *
 * Only ever for a sitting whose bot this is; stops when the sitting ends or
 * the bot leaves. No Recall call happens in tests (`_setRecallForTests`).
 */
import { notetakerState, SILENCE_WATCHDOG_MS, type ListenState } from "@shared/together";
import * as hub from "./hub";
import { togetherStore } from "./store";

interface RecallSeam {
  getBot(botId: string): Promise<{ status_changes?: Array<{ code: string; sub_code?: string | null }> }>;
}

const defaultRecall: RecallSeam = {
  async getBot(botId) {
    const { getBot } = await import("../calls/recall");
    return getBot(botId);
  },
};
let recall: RecallSeam = defaultRecall;

export function _setRecallForTests(r: RecallSeam | null): void {
  recall = r ?? defaultRecall;
}

interface Watch {
  botId: string;
  timer: ReturnType<typeof setInterval> | null;
  state: ListenState;
  polledAt: number;
  busy: boolean;
}

const watches = new Map<string, Watch>();
const TERMINAL = new Set<ListenState>(["notetaker_ended", "notetaker_removed", "notetaker_failed"]);
export const NOTETAKER_POLL_MS = 5_000;
export const NOTETAKER_POLL_RECORDING_MS = 30_000;

/** The notetaker's last known state on this sitting (null when none was sent). */
export function notetakerStateOf(sittingId: string): ListenState | null {
  return watches.get(sittingId)?.state ?? null;
}

function setState(sittingId: string, w: Watch, state: ListenState) {
  if (w.state === state) return;
  w.state = state;
  hub.publish(sittingId, { type: "listen", state });
  if (TERMINAL.has(state)) stopNotetakerWatch(sittingId);
}

/** One look at the bot (and the silence watchdog). Exported for tests. */
export async function pollNotetaker(sittingId: string, now = Date.now()): Promise<ListenState | null> {
  const w = watches.get(sittingId);
  if (!w || w.busy) return w?.state ?? null;
  const s = await togetherStore().getSitting(sittingId);
  if (!s || s.status === "ended" || s.botId !== w.botId) {
    stopNotetakerWatch(sittingId);
    return null;
  }
  const recording = w.state === "notetaker_live" || w.state === "notetaker_silent";
  if (now - w.polledAt >= (recording ? NOTETAKER_POLL_RECORDING_MS : NOTETAKER_POLL_MS) - 50) {
    w.busy = true;
    try {
      const bot = await recall.getBot(w.botId);
      const last = bot.status_changes?.[bot.status_changes.length - 1];
      w.polledAt = now;
      if (last?.code) setState(sittingId, w, notetakerState(last.code, last.sub_code ?? null));
    } catch {
      // Keep the last known state; the next tick tries again.
    } finally {
      w.busy = false;
    }
  }
  // (A final state ended the watch — report it.)
  if (!watches.has(sittingId)) return w.state;
  const lastLine = s.lastLineAt ? new Date(s.lastLineAt).getTime() : 0;
  if (w.state === "notetaker_live" && lastLine > 0 && now - lastLine >= SILENCE_WATCHDOG_MS) setState(sittingId, w, "notetaker_silent");
  return w.state;
}

/** Starts watching the sitting's bot (the notetaker was sent). */
export function watchNotetaker(sittingId: string, botId: string, initial: ListenState = "notetaker_joining"): void {
  stopNotetakerWatch(sittingId);
  const w: Watch = { botId, timer: null, state: initial, polledAt: Date.now(), busy: false };
  watches.set(sittingId, w);
  hub.publish(sittingId, { type: "listen", state: initial });
  if (process.env.NODE_ENV === "test") return;
  w.timer = setInterval(() => { void pollNotetaker(sittingId); }, NOTETAKER_POLL_MS);
  (w.timer as { unref?: () => void }).unref?.();
}

export function stopNotetakerWatch(sittingId: string): void {
  const w = watches.get(sittingId);
  if (w?.timer) clearInterval(w.timer);
  watches.delete(sittingId);
}

/** A transcript line or a participant event from the bot: it's in the call. */
export function notetakerHeard(sittingId: string, botId: string): void {
  let w = watches.get(sittingId);
  if (!w) {
    watchNotetaker(sittingId, botId, "notetaker_live");
    return;
  }
  if (w.botId !== botId) return;
  setState(sittingId, w, "notetaker_live");
}

export function _resetNotetakerForTests(): void {
  watches.forEach((_, id) => stopNotetakerWatch(id));
}
