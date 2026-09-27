import React from "react";
import { Avatar, Badge } from "./components/index.js";

export interface SessionCardProps {
  learnerName: string;
  avatarSrc: string;
  status: string;
}

export function SessionCard({ learnerName, avatarSrc, status }: SessionCardProps) {
  return (
    <div className="session-card">
      <Avatar src={avatarSrc} alt={learnerName} />
      <Badge label={status} />
    </div>
  );
}
