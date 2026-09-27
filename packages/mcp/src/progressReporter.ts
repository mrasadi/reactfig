import { debugLog, type ProgressReporter } from "@reactfig/analyzer";

export interface ProgressNotification {
  method: "notifications/progress";
  params: { progressToken: string | number; progress: number; message: string };
}

/**
 * Best-effort MCP progress reporting (see docs/adr/0013-generate-design-ir-
 * timeout.md). Only sends a notification when the client actually
 * requested one via `_meta.progressToken` on the original request — per
 * the MCP spec, a receiver is never obligated to send these, and sending
 * one without a token would be a malformed notification. `progress` is a
 * simple monotonic counter (there's no meaningful "percent complete" for
 * an AI-interpretation loop of unknown length), which is enough for
 * clients that use progress arrival, not its value, to reset a per-request
 * timeout clock (`resetTimeoutOnProgress`) — the mechanism that actually
 * prevents a long call from timing out client-side. This is necessary but
 * not sufficient on its own: it only helps if the *client* both sends a
 * token and opts into resetting its timeout on progress, which is not
 * something this server can control or detect. See docs/adr/0013 for
 * confirmed real-world OpenCode behavior here.
 */
export function makeProgressReporter(
  sendNotification: (notification: ProgressNotification) => Promise<void>,
  progressToken: string | number | undefined
): ProgressReporter | undefined {
  if (progressToken === undefined) return undefined;
  let progress = 0;
  return (stage: string) => {
    progress++;
    debugLog(stage, { progressToken, progress });
    void sendNotification({ method: "notifications/progress", params: { progressToken, progress, message: stage } }).catch(() => {
      // Best-effort — a client that requested progress but then vanished
      // (or a transport hiccup) must never fail the underlying tool call.
    });
  };
}
