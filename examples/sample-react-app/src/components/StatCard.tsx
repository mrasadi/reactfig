import React from "react";
import "./StatCard.css";

export interface StatCardProps {
  label: string;
  value: string;
  tone: "neutral" | "success" | "warning";
}

export function StatCard({ label, value, tone }: StatCardProps): React.JSX.Element {
  return (
    <div className={`stat-card stat-card-${tone}`}>
      <p className="stat-card-value">{value}</p>
      <p className="stat-card-label">{label}</p>
    </div>
  );
}
