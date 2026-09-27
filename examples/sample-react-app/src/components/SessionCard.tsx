import React from "react";
import { Avatar } from "./Avatar.js";
import { Badge } from "./Badge.js";
import { Button } from "./Button.js";
import "./SessionCard.css";

export interface SessionCardProps {
  learnerName: string;
  avatarSrc: string;
  status: "scheduled" | "completed" | "missed";
  score?: number;
  scheduledFor: string;
}

const statusTone: Record<SessionCardProps["status"], "success" | "warning" | "danger"> = {
  completed: "success",
  scheduled: "warning",
  missed: "danger",
};

export function SessionCard({ learnerName, avatarSrc, status, score, scheduledFor }: SessionCardProps): React.JSX.Element {
  return (
    <div className="card">
      <div className="card-body">
        <div className="session-card-row">
          <div className="session-card-avatar-wrap">
            <Avatar src={avatarSrc} alt={learnerName} />
            {/* Absolutely-positioned status dot over the avatar's corner — demonstrates layout.mode:"none" / absolute positioning within an otherwise flex-laid-out parent. */}
            <span className={`session-card-status-dot session-card-status-dot-${statusTone[status]}`} />
          </div>
          <div className="session-card-info">
            <p className="session-card-name">{learnerName}</p>
            <p className="session-card-meta">{scheduledFor}</p>
            <Badge label={status} tone={statusTone[status]} />
          </div>
        </div>
        {score !== undefined && <p className="session-card-score">Score: {score}/9</p>}
        <div className="session-card-actions">
          <Button variant="secondary" size="medium">
            View details
          </Button>
        </div>
      </div>
    </div>
  );
}
