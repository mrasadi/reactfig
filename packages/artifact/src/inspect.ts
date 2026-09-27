import type { Node as IRNode } from "@reactfig/core";
import type { UnpackResult } from "./unpack.js";

export interface InspectSummary {
  artifactVersion: string;
  designIrVersion: string;
  rootComponentName: string;
  rootComponentKind: "component" | "componentSet";
  componentCount: number;
  variantCount: number;
  nodeCount: number;
  assetCount: number;
  embeddedAssetCount: number;
}

/** Summarizes an already-unpacked artifact — see scripts/inspect-cli.ts for the developer-facing utility that prints this. */
export function inspect(unpacked: UnpackResult): InspectSummary {
  const { manifest, document, assets } = unpacked;
  const root = document.components.find((c) => c.id === manifest.root.componentId) ?? document.components[0];

  const variantCount = document.components.reduce((sum, c) => (c.kind === "componentSet" ? sum + c.variants.length : sum), 0);

  const nodeCount =
    document.components.reduce(
      (sum, c) => sum + (c.kind === "component" ? countNodes(c.root) : c.variants.reduce((s, v) => s + countNodes(v.root), 0)),
      0
    ) + document.pages.reduce((sum, p) => sum + p.children.reduce((s, n) => s + countNodes(n), 0), 0);

  return {
    artifactVersion: manifest.artifactVersion,
    designIrVersion: manifest.designIrVersion,
    rootComponentName: root?.name ?? "unknown",
    rootComponentKind: root?.kind ?? "component",
    componentCount: document.components.length,
    variantCount,
    nodeCount,
    assetCount: document.assets.length,
    embeddedAssetCount: Object.keys(assets).length,
  };
}

function countNodes(node: IRNode): number {
  if (node.type === "frame" || node.type === "group") {
    return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
  }
  return 1;
}
