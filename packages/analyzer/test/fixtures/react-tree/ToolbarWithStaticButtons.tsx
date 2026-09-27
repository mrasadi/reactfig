import React from "react";

function Button(props: { variant: "primary" | "secondary" | "danger"; label: string }) {
  return <button className={`btn btn-${props.variant}`}>{props.label}</button>;
}

const ROWS = [
  { id: "1", status: "completed" as const },
  { id: "2", status: "completed" as const },
];

export function ToolbarWithStaticButtons() {
  return (
    <div className="toolbar">
      {/* No array behind these three — just three separately-typed-out
          call sites with different literal `variant` values. */}
      <Button variant="primary" label="Save changes" />
      <Button variant="secondary" label="Cancel dialog" />
      <Button variant="danger" label="Delete item" />

      {/* Same tag, but every usage's variant is identical — must NOT be
          proposed as a variant axis (nothing actually varies). */}
      <span className="hint">
        <Button variant="primary" label="Confirm action" />
        <Button variant="primary" label="Retry request" />
      </span>

      {/* Inside a .map() — must be skipped by extractStaticUsageVariants
          entirely (extractMappedDataRefs's job, not this one), even
          though its "status" value differs per rendered instance. */}
      {ROWS.map((row) => (
        <Button key={row.id} variant="secondary" label={row.status} />
      ))}
    </div>
  );
}
