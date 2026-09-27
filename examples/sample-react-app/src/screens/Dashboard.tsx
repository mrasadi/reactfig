import React from "react";
import { Sidebar } from "../components/Sidebar.js";
import { Header } from "../components/Header.js";
import { StatCard } from "../components/StatCard.js";
import { SessionCard } from "../components/SessionCard.js";
import "./Dashboard.css";

const SESSIONS = [
  { learnerName: "Amir Hosseini", avatarSrc: "/avatars/amir.png", status: "completed" as const, score: 7, scheduledFor: "Today, 4:00 PM" },
  { learnerName: "Sara Ahmadi", avatarSrc: "/avatars/sara.png", status: "scheduled" as const, scheduledFor: "Tomorrow, 10:00 AM" },
  { learnerName: "Dana Karimi", avatarSrc: "/avatars/dana.png", status: "missed" as const, scheduledFor: "Yesterday, 2:00 PM" },
];

const STATS = [
  { label: "Sessions this week", value: "12", tone: "neutral" as const },
  { label: "Avg. speaking score", value: "6.8", tone: "success" as const },
  { label: "Missed sessions", value: "1", tone: "warning" as const },
];

export function Dashboard(): React.JSX.Element {
  return (
    <div className="dashboard-page">
      <Sidebar />
      <main className="dashboard-main">
        <Header title="Overview" subtitle="Your coaching activity this week" userName="Reza" userAvatarSrc="/avatars/current-user.png" />

        <div className="dashboard-stats">
          {STATS.map((stat) => (
            <StatCard key={stat.label} {...stat} />
          ))}
        </div>

        <h2 className="dashboard-section-title">Recent sessions</h2>
        <div className="dashboard-session-grid">
          {SESSIONS.map((session) => (
            <SessionCard key={session.learnerName} {...session} />
          ))}
        </div>
      </main>
    </div>
  );
}
