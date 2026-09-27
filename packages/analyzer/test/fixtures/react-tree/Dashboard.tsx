import React from "react";
import { Sidebar } from "./Sidebar.js";
import { SessionCard } from "./SessionCard.js";

const SESSIONS = [
  { learnerName: "Amir", avatarSrc: "/a.png", status: "completed" },
  { learnerName: "Sara", avatarSrc: "/s.png", status: "scheduled" },
];

export function Dashboard() {
  return (
    <div className="dashboard">
      <Sidebar />
      <main>
        {SESSIONS.map((session) => (
          <SessionCard key={session.learnerName} {...session} />
        ))}
      </main>
    </div>
  );
}
