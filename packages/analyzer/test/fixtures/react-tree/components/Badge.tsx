import React from "react";

export interface BadgeProps {
  label: string;
}

export function Badge({ label }: BadgeProps) {
  return <span className="badge">{label}</span>;
}
