import React from "react";

export interface ButtonProps {
  variant: "primary" | "secondary";
  size?: "medium" | "large";
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}

export function Button({ variant, size = "medium", disabled = false, onClick, children }: ButtonProps) {
  return (
    <button className={`btn btn-${variant} btn-${size}`} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}
