import React from "react";
export function StatCard({ label, value, tone }: { label: string; value: string; tone: string }) {
  return <div className={`stat-card stat-card-${tone}`}><span>{value}</span><span>{label}</span></div>;
}
