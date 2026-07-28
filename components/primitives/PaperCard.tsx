import React from "react";

interface PaperCardProps {
  bg?: string;
  color?: string;
  width?: string | number;
  height?: string | number;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function PaperCard({
  bg,
  color,
  width,
  height,
  children,
  className,
  style,
}: PaperCardProps) {
  return (
    <div
      className={["paper-texture rounded-lg", className].filter(Boolean).join(" ")}
      style={{
        background: bg,
        color,
        width,
        height,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
