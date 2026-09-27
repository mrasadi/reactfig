import type { ComponentEvidence, ComponentSourceEvidence, RenderCapture } from "./evidence/types.js";

export interface BuildComponentEvidenceOptions {
  componentName: string;
  source: ComponentSourceEvidence;
  captures: RenderCapture[];
  analyzerVersion: string;
}

/**
 * Combines deterministic AST evidence with one or more render captures
 * into the ComponentEvidence document that AI reasoning (Phase 4) will
 * consume. This function does no inference of its own — it only merges
 * and annotates known, intentional gaps so they're visible rather than
 * silently absent.
 */
export function buildComponentEvidence(options: BuildComponentEvidenceOptions): ComponentEvidence {
  const limitations: string[] = [
    "componentPath/isComponentRoot identify which component owns each DOM node (best-effort, via the React fiber _debugOwner chain — only available in development builds) but do not map to the specific JSX expression within that component's render — e.g. two sibling elements written in the same JSX block are distinguished by tree position, not individually labeled.",
    "Text nodes with mixed inline styling in the rendered DOM are captured as a single ElementEvidence per DOM element; splitting into multiple Design IR Text nodes (per ADR 0005) happens in a later phase, not here.",
    "Shadows (style.boxShadow) are preserved as a single raw CSS string per element; not parsed into structured, potentially multi-layer shadow evidence in v1.",
  ];

  if (options.captures.some((c) => containsGrid(c))) {
    limitations.push(
      "CSS Grid detected in at least one capture. Raw grid-template/grid-column/grid-row evidence is preserved in style.grid / style.gridChildPlacement, but design-ir/v1 has no semantic Grid node — IR generation will fall back to layout.mode='none' with absolute bounds (ADR 0002)."
    );
  }

  if (options.captures.some((c) => containsBackgroundImageAsset(c))) {
    limitations.push(
      "Background-image assets are captured as a URL only (style.backgroundImageUrl), without natural width/height — unlike <img> elements, determining that would require an async image load during synchronous DOM collection."
    );
  }

  return {
    componentName: options.componentName,
    source: options.source,
    captures: options.captures,
    meta: {
      analyzerVersion: options.analyzerVersion,
      limitations,
    },
  };
}

function containsGrid(capture: RenderCapture): boolean {
  function walk(node: RenderCapture["dom"]): boolean {
    if (node.style.layoutMode === "grid") return true;
    return node.children.some(walk);
  }
  return walk(capture.dom);
}

function containsBackgroundImageAsset(capture: RenderCapture): boolean {
  function walk(node: RenderCapture["dom"]): boolean {
    if (node.style.backgroundImageUrl) return true;
    return node.children.some(walk);
  }
  return walk(capture.dom);
}
