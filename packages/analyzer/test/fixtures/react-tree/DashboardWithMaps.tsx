import React from "react";
import { Sidebar } from "./Sidebar.js";
import { SessionCard } from "./SessionCard.js";
import { StatCard } from "./StatCard.js";

const STATS = [
  { label: "Sessions this week", value: "12", tone: "neutral" as const },
  { label: "Avg. speaking score", value: "6.8", tone: "success" as const },
  { label: "Missed sessions", value: "1", tone: "warning" as const },
];

const SESSIONS = [
  { learnerName: "Amir", avatarSrc: "/a.png", status: "completed" as const },
  { learnerName: "Sara", avatarSrc: "/s.png", status: "scheduled" as const },
];

export function DashboardWithMaps() {
  return (
    <div className="dashboard">
      <Sidebar />
      <main>
        <div className="stats">
          {STATS.map((stat) => (
            <StatCard key={stat.label} {...stat} />
          ))}
        </div>
        {SESSIONS.map((session) => (
          <SessionCard key={session.learnerName} {...session} />
        ))}
      </main>
    </div>
  );
}
