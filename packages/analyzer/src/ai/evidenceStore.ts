import type { ComponentEvidence, ElementEvidence, RenderCapture, ScreenshotEvidence } from "../evidence/types.js";

export interface NestedComponentSummaryEntry {
  captureLabel: string;
  path: number[];
  tag: string;
  bounds: ElementEvidence["bounds"];
  componentPath: string[] | null;
}

export interface AssetMetadataEntry {
  src: string;
  naturalWidth: number | null;
  naturalHeight: number | null;
  alt: string | null;
  source: "img" | "backgroundImage";
}

export interface CaptureSummary {
  label: string;
  viewportLabel?: string;
  propValues?: Record<string, unknown>;
  rootLayoutMode: string;
}

/**
 * Read-only query engine over one ComponentEvidence document. This is the
 * single source of truth both the get_evidence tool (interpret.ts) and the
 * initial evidence bundle (evidenceBundle.ts) query against — neither
 * re-implements traversal logic independently.
 */
export class EvidenceStore {
  constructor(private readonly evidence: ComponentEvidence) {}

  getSource() {
    return this.evidence.source;
  }

  listCaptures(): CaptureSummary[] {
    return this.evidence.captures.map((c) => ({
      label: c.label,
      viewportLabel: c.viewportLabel,
      propValues: c.propValues,
      rootLayoutMode: c.dom.style.layoutMode,
    }));
  }

  getCapture(label: string): RenderCapture | null {
    return this.evidence.captures.find((c) => c.label === label) ?? null;
  }

  getElementAtPath(captureLabel: string, path: number[]): ElementEvidence | null {
    const capture = this.getCapture(captureLabel);
    if (!capture) return null;
    let node: ElementEvidence = capture.dom;
    for (const index of path) {
      const next = node.children[index];
      if (!next) return null;
      node = next;
    }
    return node;
  }

  getScreenshotRef(captureLabel: string, kind: "primary" | "context" = "primary"): ScreenshotEvidence | null {
    const capture = this.getCapture(captureLabel);
    if (!capture) return null;
    return kind === "primary" ? capture.screenshot : capture.contextScreenshot;
  }

  /**
   * Summarizes every DOM node whose nearest owning component is
   * `componentName`, across all captures, without dumping their full
   * recursive subtrees — this is what makes "nested component summary" a
   * summary rather than a second full evidence dump.
   */
  getNestedComponentSummary(componentName: string): NestedComponentSummaryEntry[] {
    const results: NestedComponentSummaryEntry[] = [];
    for (const capture of this.evidence.captures) {
      walk(capture.dom, [], (node, path) => {
        const owner = node.componentPath && node.componentPath.length > 0 ? node.componentPath[node.componentPath.length - 1] : null;
        if (owner === componentName && node.isComponentRoot) {
          results.push({ captureLabel: capture.label, path, tag: node.tag, bounds: node.bounds, componentPath: node.componentPath });
        }
      });
    }
    return results;
  }

  /** Searches all captures for an <img> or CSS background-image asset matching `srcOrUrl`. */
  getAssetMetadata(srcOrUrl: string): AssetMetadataEntry | null {
    for (const capture of this.evidence.captures) {
      let found: AssetMetadataEntry | null = null;
      walk(capture.dom, [], (node) => {
        if (found) return;
        if (node.image && node.image.src === srcOrUrl) {
          found = { src: node.image.src, naturalWidth: node.image.naturalWidth, naturalHeight: node.image.naturalHeight, alt: node.image.alt, source: "img" };
        } else if (node.style.backgroundImageUrl === srcOrUrl) {
          found = { src: srcOrUrl, naturalWidth: null, naturalHeight: null, alt: null, source: "backgroundImage" };
        }
      });
      if (found) return found;
    }
    return null;
  }

  /** All unique asset references across every capture — used to build the initial bundle's asset list. */
  listAssets(): AssetMetadataEntry[] {
    const seen = new Map<string, AssetMetadataEntry>();
    for (const capture of this.evidence.captures) {
      walk(capture.dom, [], (node) => {
        if (node.image && !seen.has(node.image.src)) {
          seen.set(node.image.src, { src: node.image.src, naturalWidth: node.image.naturalWidth, naturalHeight: node.image.naturalHeight, alt: node.image.alt, source: "img" });
        }
        if (node.style.backgroundImageUrl && !seen.has(node.style.backgroundImageUrl)) {
          seen.set(node.style.backgroundImageUrl, { src: node.style.backgroundImageUrl, naturalWidth: null, naturalHeight: null, alt: null, source: "backgroundImage" });
        }
      });
    }
    return [...seen.values()];
  }
}

function walk(node: ElementEvidence, path: number[], visit: (node: ElementEvidence, path: number[]) => void): void {
  visit(node, path);
  node.children.forEach((child, i) => walk(child, [...path, i], visit));
}
