/**
 * FALLBACK ADAPTER, NOT CORE ARCHITECTURE (docs/adr/0027, section 19).
 *
 * The core Agent Continuation mechanism is `continuation.ts`'s persisted
 * ContinuationSignal + in-process ContinuationBridge: the developer's
 * Done/Continue click writes a durable marker and (when this server
 * process is still the one that started the session) emits an in-process
 * event. That is preferred, and is what `collectionBrowser.ts` actually
 * wires up.
 *
 * This file exists ONLY to document — honestly, per docs section 19's
 * "if an external limitation exists, document it clearly" — the one
 * scenario the mechanism above cannot solve on its own: getting an
 * OpenCode/Claude Code AGENT TURN itself to resume, when the agent's own
 * MCP client has no server-initiated-notification transport and is not
 * already blocked inside a tool call waiting on this collection. In that
 * specific situation, the only way to make the agent take its next turn
 * at all is to simulate outside-the-protocol input the surrounding
 * environment happens to already listen for (e.g. a synthetic keypress
 * into a terminal-attached agent). That is inherently environment-
 * specific, outside anything this repository can implement or verify
 * (this sandbox has no OpenCode/Claude Code process to target), and is
 * NOT invoked by any code path in this package.
 *
 * `emulateContinuationKeystroke` is therefore a documented extension
 * point, not a working implementation: it throws unless the caller
 * supplies their own environment-specific `send` function. A real
 * integration (outside this repo) would pass one in; this repo does not,
 * and nothing here calls this function.
 */
export interface ContinuationKeystrokeAdapterOptions {
  /** Caller-supplied, environment-specific: however THIS agent surface actually expects to be nudged (e.g. writing a keypress event to a specific terminal/pty, or hitting an environment-specific local endpoint). No default exists — see this file's own doc comment for why. */
  send: () => Promise<void> | void;
}

export async function emulateContinuationKeystroke(options: ContinuationKeystrokeAdapterOptions): Promise<void> {
  if (!options?.send) {
    throw new Error(
      "emulateContinuationKeystroke: no `send` implementation supplied. This is a documented fallback adapter, not a working default (docs/adr/0027 section 19) — prefer continuation.ts's ContinuationSignal/ContinuationBridge; only reach for this when your agent surface has no other way to resume, and supply your own environment-specific `send`."
    );
  }
  await options.send();
}
