import React from "react";
import "./Avatar.css";

export interface AvatarProps {
  src: string;
  alt: string;
  size?: "small" | "medium";
}

export function Avatar({ src, alt, size = "medium" }: AvatarProps): React.JSX.Element {
  return <img className={`avatar avatar-${size}`} src={src} alt={alt} />;
}
