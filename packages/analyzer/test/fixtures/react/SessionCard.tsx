import React from "react";
import { Card } from "./Card";
import { Avatar } from "./Avatar";
import { Badge } from "./Badge";

export interface SessionCardProps {
  learnerName: string;
  avatarSrc: string;
  status: "scheduled" | "completed" | "missed";
  score?: number;
}

export function SessionCard({ learnerName, avatarSrc, status, score }: SessionCardProps) {
  return (
    <Card title={learnerName}>
      <div className="session-card-row">
        <Avatar src={avatarSrc} alt={learnerName} />
        <Badge label={status} tone={status === "completed" ? "success" : "warning"} />
        {score !== undefined && <span className="session-score">{score}</span>}
      </div>
    </Card>
  );
}
