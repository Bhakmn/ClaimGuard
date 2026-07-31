"use client";

import React, { useEffect, useRef } from "react";

export type ToastKind = "ok" | "err" | "info";

export interface ToastMessage {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastProps {
  toast: ToastMessage;
}

function Toast({ toast }: ToastProps) {
  return (
    <div
      className={`toast toast--${toast.kind} toast-enter`}
      role={toast.kind === "err" ? "alert" : undefined}
    >
      {toast.message}
    </div>
  );
}

interface ToastStackProps {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  // Auto-dismiss timers
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    for (const t of toasts) {
      if (!timers.current.has(t.id)) {
        const tid = setTimeout(() => {
          onDismiss(t.id);
          timers.current.delete(t.id);
        }, 4000);
        timers.current.set(t.id, tid);
      }
    }
    // Clean up timers for toasts that were removed externally
    for (const [id, tid] of timers.current) {
      if (!toasts.find((t) => t.id === id)) {
        clearTimeout(tid);
        timers.current.delete(id);
      }
    }
  }, [toasts, onDismiss]);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} />
      ))}
    </div>
  );
}

/* ─── Hook for managing the toast queue ─────────────────────────────────── */

let _toastCounter = 0;

export function useToasts() {
  const [toasts, setToasts] = React.useState<ToastMessage[]>([]);

  const push = React.useCallback(
    (message: string, kind: ToastKind = "ok") => {
      _toastCounter += 1;
      const id = _toastCounter;
      setToasts((prev) => [...prev, { id, message, kind }]);
    },
    []
  );

  const dismiss = React.useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, push, dismiss };
}
