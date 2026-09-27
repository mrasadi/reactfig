import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockModelProvider } from "@reactfig/model";
import { registerTools } from "../../src/server.js";
import type { ProjectRootState } from "../../src/projectRoot.js";
import type { DesignDocument } from "@reactfig/core";

export function loadFixture(name: string): DesignDocument {
  const path = fileURLToPath(new URL(`../../../artifact/test/fixtures/design-ir/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8"));
}

/**
 * Builds a real McpServer (via the production registerTools()) wired to a
 * real Client over InMemoryTransport, so calls go through actual JSON-RPC
 * argument handling and the real registered tool handlers — including
 * their `z.unknown()` document-shaped input schemas — instead of invoking
 * tool functions in-process. This is the boundary the unit-level
 * pipeline.test.ts does NOT exercise: it hands live JS objects straight to
 * tool functions, skipping the MCP dispatch layer (and any serialization a
 * real client might introduce) entirely.
 */
export async function connectedClient(): Promise<Client> {
  const state: ProjectRootState = { explicit: undefined };
  // None of these tools touch the model provider, but registerTools()
  // wires every tool at once — give it an inert mock.
  const provider = new MockModelProvider({
    onGenerateWithTools: () => ({ text: "unused", toolCalls: [] }),
    onGenerateStructured: () => ({ componentDisplayName: "Unused", variantAxes: [], nodeAnnotations: [] }),
  });

  const server = new McpServer({ name: "reactfig-test", version: "0.0.0" });
  registerTools(server, { provider, state });

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return client;
}

export function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const block = content.find((c) => c.type === "text");
  if (!block?.text) throw new Error("expected a text content block");
  return block.text;
}