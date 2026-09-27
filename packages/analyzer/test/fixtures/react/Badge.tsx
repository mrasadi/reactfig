import React from "react";

export interface BadgeProps {
  label: string;
  tone: "success" | "warning" | "danger";
}

export function Badge({ label, tone }: BadgeProps) {
  return <span className={`badge badge-${tone}`}>{label}</span>;
}
