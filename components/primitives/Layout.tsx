import React from "react";

interface PanelProps { children: React.ReactNode; className?: string }

export function Panel({ children, className }: PanelProps) {
  return (
    <div className={["panel", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}

interface RowProps {
  spread?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Row({ spread, children, className }: RowProps) {
  return (
    <div
      className={[
        "row",
        spread ? "row--spread" : null,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}

interface StatusLineProps { text?: string; className?: string }

export function StatusLine({ text, className }: StatusLineProps) {
  if (!text) return null;
  return (
    <p className={["status-line", className].filter(Boolean).join(" ")}>
      {text}
    </p>
  );
}

interface ErrorBoxProps { message?: string | null; className?: string }

export function ErrorBox({ message, className }: ErrorBoxProps) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className={["error-box", className].filter(Boolean).join(" ")}
    >
      {message}
    </div>
  );
}

interface NoticeBoxProps { children: React.ReactNode; className?: string }

export function NoticeBox({ children, className }: NoticeBoxProps) {
  return (
    <div className={["notice-box", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}

export function OfflineBanner() {
  return (
    <div role="status" className="offline-banner">
      You&rsquo;re offline. Scanning and publishing need a connection — editing
      and export still work.
    </div>
  );
}
