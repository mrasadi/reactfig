import React from "react";
import { Avatar } from "./Avatar.js";
import "./Header.css";

export interface HeaderProps {
  title: string;
  subtitle: string;
  userName: string;
  userAvatarSrc: string;
}

export function Header({ title, subtitle, userName, userAvatarSrc }: HeaderProps): React.JSX.Element {
  return (
    <header className="dashboard-header">
      <div className="dashboard-header-titles">
        <h1 className="dashboard-header-title">{title}</h1>
        <p className="dashboard-header-subtitle">{subtitle}</p>
      </div>
      <div className="dashboard-header-user">
        <span className="dashboard-header-username">{userName}</span>
        <Avatar src={userAvatarSrc} alt={userName} size="small" />
      </div>
    </header>
  );
}
