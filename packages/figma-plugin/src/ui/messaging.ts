import type { CodeToUiMessage, UiToCodeMessage } from "../shared/messages.js";

/** Figma's documented UI-side send convention: post to `parent` with a `pluginMessage` envelope. */
export function sendToSandbox(message: UiToCodeMessage): void {
  parent.postMessage({ pluginMessage: message }, "*");
}

/** The sandbox's outgoing messages arrive on `window.onmessage` inside the same `pluginMessage` envelope. */
export function onSandboxMessage(handler: (message: CodeToUiMessage) => void): () => void {
  const listener = (event: MessageEvent) => {
    const message = event.data?.pluginMessage as CodeToUiMessage | undefined;
    if (message) handler(message);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
