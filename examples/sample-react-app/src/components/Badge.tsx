import React from "react";
import "./Badge.css";

export interface BadgeProps {
  label: string;
  tone: "success" | "warning" | "danger" | "neutral";
}

export function Badge({ label, tone }: BadgeProps): React.JSX.Element {
  return <span className={`badge badge-${tone}`}>{label}</span>;
}
