import React from "react";

interface BrandMarkProps {
  size?: "sm" | "lg";
}

export function BrandMark({ size = "sm" }: BrandMarkProps) {
  return (
    <div className="brand-mark">
      <div className={`brand-badge${size === "lg" ? " brand-badge--lg" : ""}`}>
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
          <path d="M9.5 12l1.8 1.8L15 10" />
        </svg>
      </div>
      <span className="brand-wordmark">ClaimGuard</span>
    </div>
  );
}
