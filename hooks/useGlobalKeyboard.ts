"use client";

import { useEffect, useRef } from "react";
import type { WorkspaceState } from "@/lib/workspace-state";
import { applyUndo, applyRedo } from "@/lib/workspace-state";

type Updater = (patch: Partial<WorkspaceState>) => void;

interface KeyboardHandlerOptions {
  state: WorkspaceState;
  update: Updater;
  /** Step the playhead by delta seconds. */
  seek: (delta: number) => void;
  /** Toggle play / pause. */
  togglePlay: () => void;
  /** Delete the selected span if one is selected; else delete the selected clip. */
  deleteSelected: () => void;
  /** Split the flag region under the playhead. */
  splitRegion: () => void;
  /** Cut both lanes at the playhead. */
  cutAtPlayhead: () => void;
  /** Toggle selected region enabled/disabled. */
  toggleSelectedRegion: () => void;
  /** Close any open context menu. */
  closeMenu: () => void;
  /** Whether we are in workspace mode (media loaded). */
  inWorkspace: boolean;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof Element)) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export function useGlobalKeyboard({
  state,
  update,
  seek,
  togglePlay,
  deleteSelected,
  splitRegion,
  cutAtPlayhead,
  toggleSelectedRegion,
  closeMenu,
  inWorkspace,
}: KeyboardHandlerOptions) {
  // Keep a stable ref to the latest options so the listener is created once
  const opts = useRef({
    state,
    update,
    seek,
    togglePlay,
    deleteSelected,
    splitRegion,
    cutAtPlayhead,
    toggleSelectedRegion,
    closeMenu,
    inWorkspace,
  });

  useEffect(() => {
    opts.current = {
      state,
      update,
      seek,
      togglePlay,
      deleteSelected,
      splitRegion,
      cutAtPlayhead,
      toggleSelectedRegion,
      closeMenu,
      inWorkspace,
    };
  });

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;

      const o = opts.current;
      const meta = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const key = e.key;

      // Escape — close menu (always, even outside workspace)
      if (key === "Escape") {
        o.closeMenu();
        return;
      }

      // Everything else is inert in launch mode
      if (!o.inWorkspace) return;

      // Undo / redo
      if (meta && shift && (key === "z" || key === "Z")) {
        e.preventDefault();
        const patch = applyRedo(o.state);
        if (patch) o.update(patch as Partial<WorkspaceState>);
        return;
      }
      if (meta && (key === "z" || key === "Z")) {
        e.preventDefault();
        const patch = applyUndo(o.state);
        if (patch) o.update(patch as Partial<WorkspaceState>);
        return;
      }
      if (meta && (key === "y" || key === "Y")) {
        e.preventDefault();
        const patch = applyRedo(o.state);
        if (patch) o.update(patch as Partial<WorkspaceState>);
        return;
      }

      // Space — play/pause (no auto-repeat)
      if (key === " ") {
        if (e.repeat) return;
        e.preventDefault();
        o.togglePlay();
        return;
      }

      // Arrow keys — seek
      if (key === "ArrowLeft") {
        e.preventDefault();
        o.seek(shift ? -1 : -0.1);
        return;
      }
      if (key === "ArrowRight") {
        e.preventDefault();
        o.seek(shift ? 1 : 0.1);
        return;
      }

      // Delete / Backspace — delete selected
      if (key === "Delete" || key === "Backspace") {
        o.deleteSelected();
        return;
      }

      // S — split region
      if (key === "s" || key === "S") {
        o.splitRegion();
        return;
      }

      // C — cut at playhead
      if (key === "c" || key === "C") {
        if (!meta) o.cutAtPlayhead();
        return;
      }

      // M — toggle selected region
      if (key === "m" || key === "M") {
        if (o.state.selectedSpanId) o.toggleSelectedRegion();
        return;
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — intentionally stable
}
