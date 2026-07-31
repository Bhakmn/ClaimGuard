import React from "react";

interface KbdProps { children: React.ReactNode }

export function Kbd({ children }: KbdProps) {
  return <kbd className="kbd">{children}</kbd>;
}
