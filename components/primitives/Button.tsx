"use client";

import React from "react";

type ButtonVariant = "default" | "primary" | "dangerOutline" | "toolbar" | "menu";

interface ButtonProps {
  variant?: ButtonVariant;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  type?: "button" | "submit" | "reset";
  children: React.ReactNode;
  className?: string;
}

export function Button({
  variant = "default",
  active = false,
  danger = false,
  disabled = false,
  title,
  onClick,
  type = "button",
  children,
  className,
}: ButtonProps) {
  const classes = [
    "button",
    variant === "primary" ? "button--primary" : null,
    variant === "dangerOutline" ? "button--danger-outline" : null,
    variant === "toolbar" ? "button--toolbar" : null,
    variant === "toolbar" && active ? "button--active" : null,
    variant === "menu" ? "button--menu" : null,
    variant === "menu" && danger ? "button--menu--danger" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled}
      title={title}
      onClick={disabled ? undefined : onClick}
    >
      {children}
    </button>
  );
}
