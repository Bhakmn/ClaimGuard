"use client";

import React, { useState } from "react";
import type { AccountProfile } from "@/lib/types";
import type { AccountService } from "@/lib/mock/account-service";

interface AccountControlsProps {
  accountService: AccountService;
  offline: boolean;
  profile: AccountProfile | null;
  loading: boolean;
  onProfileChange: (p: AccountProfile | null) => void;
}

export function AccountControls({
  accountService,
  offline,
  profile,
  loading,
  onProfileChange,
}: AccountControlsProps) {
  const [signingIn, setSigningIn] = useState<"login" | "signup" | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  /* Loading — render nothing */
  if (loading) return null;

  /* Offline — show text only */
  if (offline) {
    return (
      <span
        style={{
          fontFamily: 'var(--font-courier),"Courier Prime",monospace',
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.2em",
          color: "rgba(31,31,31,0.45)",
        }}
      >
        Offline
      </span>
    );
  }

  async function handleSignIn(intent: "login" | "signup") {
    setSigningIn(intent);
    try {
      const p = await accountService.signIn(intent);
      onProfileChange(p);
    } finally {
      setSigningIn(null);
    }
  }

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await accountService.signOut();
      onProfileChange(null);
    } finally {
      setSigningOut(false);
    }
  }

  const baseAnchorStyle: React.CSSProperties = {
    fontFamily: 'var(--font-courier),"Courier Prime",monospace',
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.2em",
    padding: "8px 16px",
    borderRadius: 4,
    cursor: "pointer",
    textDecoration: "none",
    display: "inline-block",
    transition: "background-color 150ms",
    userSelect: "none",
    whiteSpace: "nowrap",
  };

  /* Signed in */
  if (profile) {
    const initial =
      (profile.name?.[0] ?? profile.email?.[0] ?? "?").toUpperCase();
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* Identity cluster */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {profile.picture ? (
            <img
              src={profile.picture}
              alt=""
              width={24}
              height={24}
              style={{ borderRadius: "50%", flexShrink: 0 }}
            />
          ) : (
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: "50%",
                background: "rgba(198,93,59,0.2)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  fontFamily:
                    'var(--font-courier),"Courier Prime",monospace',
                  fontSize: 11,
                  color: "#C65D3B",
                }}
              >
                {initial}
              </span>
            </div>
          )}
          <span
            style={{
              fontFamily:
                'var(--font-courier),"Courier Prime",monospace',
              fontSize: 11,
              letterSpacing: "0.05em",
              color: "#1F1F1F",
              maxWidth: 160,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {profile.name ?? profile.email}
          </span>
        </div>
        {/* Log out */}
        <button
          onClick={handleSignOut}
          disabled={signingOut}
          style={{
            ...baseAnchorStyle,
            background: "transparent",
            border: "1px solid rgba(31,31,31,0.3)",
            color: "#1F1F1F",
            opacity: signingOut ? 0.5 : 1,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              "rgba(31,31,31,0.05)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              "transparent";
          }}
        >
          Log out
        </button>
      </div>
    );
  }

  /* Signed out */
  const busy = signingIn !== null;
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <button
        onClick={() => !busy && handleSignIn("login")}
        disabled={busy}
        style={{
          ...baseAnchorStyle,
          background: "transparent",
          border: "1px solid rgba(31,31,31,0.3)",
          color: "#1F1F1F",
          opacity: busy ? 0.5 : 1,
        }}
        onMouseEnter={(e) => {
          if (!busy)
            (e.currentTarget as HTMLButtonElement).style.background =
              "rgba(31,31,31,0.05)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background =
            "transparent";
        }}
      >
        {signingIn === "login" ? "Signing in…" : "Log in"}
      </button>
      <button
        onClick={() => !busy && handleSignIn("signup")}
        disabled={busy}
        style={{
          ...baseAnchorStyle,
          background: "#1F1F1F",
          border: "1px solid #1F1F1F",
          color: "#F4F1EA",
          opacity: busy ? 0.5 : 1,
        }}
        onMouseEnter={(e) => {
          if (!busy)
            (e.currentTarget as HTMLButtonElement).style.background =
              "#C65D3B";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background =
            "#1F1F1F";
        }}
      >
        {signingIn === "signup" ? "Signing up…" : "Sign up"}
      </button>
    </div>
  );
}
