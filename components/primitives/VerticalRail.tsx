import React from "react";

interface VerticalRailProps {
  text: string;
  side: "left" | "right";
  className?: string;
}

export function VerticalRail({ text, side, className }: VerticalRailProps) {
  return (
    <span
      className={[
        "text-vertical absolute font-typewriter uppercase",
        side === "left" ? "left-0" : "right-0",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ opacity: 0.25, fontSize: 10, letterSpacing: "0.25em" }}
      aria-hidden="true"
    >
      {text}
    </span>
  );
}
