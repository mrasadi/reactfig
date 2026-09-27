import React from "react";
import "./Sidebar.css";

const NAV_ITEMS = [
  { label: "Dashboard", active: true },
  { label: "Sessions", active: false },
  { label: "Learners", active: false },
  { label: "Reports", active: false },
  { label: "Settings", active: false },
];

export function Sidebar(): React.JSX.Element {
  return (
    <nav className="sidebar">
      <div className="sidebar-brand">BRIGHTPATH</div>
      <ul className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <li key={item.label} className={`sidebar-nav-item ${item.active ? "sidebar-nav-item-active" : ""}`}>
            {item.label}
          </li>
        ))}
      </ul>
    </nav>
  );
}
