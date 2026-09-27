import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { Project, ModuleResolutionKind, ts } from "ts-morph";
import { inspectComponentSourceFromFile } from "../src/ast/inspectComponentSource.js";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/react-tree/${name}`, import.meta.url));
}

function loadSourceFile(path: string) {
  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { moduleResolution: ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext },
  });
  return project.addSourceFileAtPath(path);
}

describe("usesPortal (inspectComponentSourceFromFile + detectPortalUsage)", () => {
  it("detects a bare `createPortal(...)` call (import { createPortal } from 'react-dom')", () => {
    const evidence = inspectComponentSourceFromFile(loadSourceFile(fixture("ModalWithPortal.tsx")));
    expect(evidence.usesPortal).toBe(true);
  });

  it("detects `ReactDOM.createPortal(...)` via a namespace import too", () => {
    const evidence = inspectComponentSourceFromFile(loadSourceFile(fixture("ModalViaAliasedNamespace.tsx")));
    expect(evidence.usesPortal).toBe(true);
  });

  it("is false for an ordinary component with no portal call at all", () => {
    const evidence = inspectComponentSourceFromFile(loadSourceFile(fixture("StatCard.tsx")));
    expect(evidence.usesPortal).toBe(false);
  });

  it("is false for a component that merely mentions 'portal' in an unrelated identifier — name-based detection matches the exact call shape, not any substring", () => {
    // Regression guard for the heuristic's precision: a prop or variable
    // named similarly to createPortal must not false-positive.
    const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { moduleResolution: ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext } });
    const sourceFile = project.createSourceFile(
      "NotAPortal.tsx",
      `
      import React from "react";
      export function NotAPortal(props: { createPortalLabel: string }) {
        return <div>{props.createPortalLabel}</div>;
      }
      `
    );
    const evidence = inspectComponentSourceFromFile(sourceFile);
    expect(evidence.usesPortal).toBe(false);
  });
});
