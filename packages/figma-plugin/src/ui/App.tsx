import React, { useCallback, useRef, useState } from "react";
import { checkArtifact, unpack, inspect, type InspectSummary, type UnpackResult } from "@reactfig/artifact";
import { bytesToBase64 } from "../shared/base64.js";
import type { EncodedAsset } from "../shared/messages.js";
import { sendToSandbox, onSandboxMessage } from "./messaging.js";

type Stage =
  | { kind: "idle" }
  | { kind: "invalid"; fileName: string; errors: string[] }
  | { kind: "ready"; fileName: string; unpacked: UnpackResult; summary: InspectSummary }
  | { kind: "importing"; fileName: string; message: string; current: number; total: number }
  | { kind: "success"; fileName: string; warnings: string[] }
  | { kind: "error"; fileName: string; message: string };

export function App(): React.JSX.Element {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listenerCleanup = useRef<(() => void) | null>(null);

  const handleFile = useCallback(async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());

    const check = await checkArtifact(bytes);
    if (!check.valid) {
      setStage({ kind: "invalid", fileName: file.name, errors: check.errors });
      return;
    }

    const unpacked = await unpack(bytes);
    const summary = inspect(unpacked);
    setStage({ kind: "ready", fileName: file.name, unpacked, summary });
  }, []);

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile]
  );

  const handleImport = useCallback(() => {
    if (stage.kind !== "ready") return;
    const { fileName, unpacked } = stage;

    listenerCleanup.current?.();
    listenerCleanup.current = onSandboxMessage((message) => {
      if (message.type === "progress") {
        setStage({ kind: "importing", fileName, message: message.message, current: message.current, total: message.total });
      } else if (message.type === "success") {
        setStage({ kind: "success", fileName, warnings: message.warnings });
        listenerCleanup.current?.();
      } else if (message.type === "error") {
        setStage({ kind: "error", fileName, message: message.message });
        listenerCleanup.current?.();
      }
    });

    const assets: Record<string, EncodedAsset> = {};
    for (const entry of unpacked.manifest.assets) {
      if (!entry.embedded) continue;
      const bytes = unpacked.assets[entry.id];
      if (!bytes) continue;
      assets[entry.id] = { base64: bytesToBase64(bytes), mimeType: entry.mimeType };
    }

    setStage({ kind: "importing", fileName, message: "Starting import…", current: 0, total: 1 });
    sendToSandbox({ type: "import", manifest: unpacked.manifest, document: unpacked.document, assets });
  }, [stage]);

  const handleReset = useCallback(() => {
    listenerCleanup.current?.();
    setStage({ kind: "idle" });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  return (
    <div className="rf-app">
      <h1 className="rf-title">ReactFig Importer</h1>

      <input ref={fileInputRef} className="rf-file-input" type="file" accept=".rfd" onChange={handleFileInputChange} />

      {stage.kind === "idle" && (
        <div className="rf-dropzone" onClick={() => fileInputRef.current?.click()}>
          Select an .rfd artifact
        </div>
      )}

      {stage.kind === "invalid" && (
        <>
          <div className="rf-dropzone" onClick={() => fileInputRef.current?.click()}>
            {stage.fileName} — not a valid artifact
          </div>
          <ul className="rf-error-list">
            {stage.errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </>
      )}

      {stage.kind === "ready" && (
        <>
          <div className="rf-summary">
            <div className="rf-summary-name">{stage.fileName}</div>
            <div className="rf-summary-row">
              <span>Root</span>
              <span>
                {stage.summary.rootComponentName} ({stage.summary.rootComponentKind})
              </span>
            </div>
            <div className="rf-summary-row">
              <span>Components</span>
              <span>{stage.summary.componentCount}</span>
            </div>
            <div className="rf-summary-row">
              <span>Variants</span>
              <span>{stage.summary.variantCount}</span>
            </div>
            <div className="rf-summary-row">
              <span>Nodes</span>
              <span>{stage.summary.nodeCount}</span>
            </div>
            <div className="rf-summary-row">
              <span>Assets</span>
              <span>
                {stage.summary.assetCount} ({stage.summary.embeddedAssetCount} embedded)
              </span>
            </div>
          </div>
          <button className="rf-button" onClick={handleImport}>
            Import
          </button>
        </>
      )}

      {stage.kind === "importing" && (
        <>
          <div className="rf-progress-track">
            <div className="rf-progress-fill" style={{ width: `${stage.total > 0 ? Math.round((stage.current / stage.total) * 100) : 0}%` }} />
          </div>
          <div className="rf-progress-label">{stage.message}</div>
        </>
      )}

      {stage.kind === "success" && (
        <>
          <div className="rf-success">✓ Imported into Figma</div>
          {stage.warnings.length > 0 && (
            <ul className="rf-warning-list">
              {stage.warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          )}
          <button className="rf-button rf-button-secondary" onClick={handleReset}>
            Import another
          </button>
        </>
      )}

      {stage.kind === "error" && (
        <>
          <div className="rf-error-list">Rendering failed: {stage.message}</div>
          <button className="rf-button rf-button-secondary" onClick={handleReset}>
            Try again
          </button>
        </>
      )}
    </div>
  );
}
