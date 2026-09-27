import React from "react";
import "./Button.css";

export interface ButtonProps {
  variant: "primary" | "secondary" | "ghost";
  size?: "medium" | "large";
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}

export function Button({ variant, size = "medium", disabled = false, onClick, children }: ButtonProps): React.JSX.Element {
  return (
    <button className={`btn btn-${variant} btn-${size}`} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}
