"use client";

import React from "react";
import type { FlaggedSpan, TrackSegment } from "@/lib/types";
import { formatClock } from "@/lib/formatters";
import { segmentEnd } from "@/lib/types";

/* ─── Shared menu shell ──────────────────────────────────────────────────── */

interface MenuProps {
  x: number;
  y: number;
  children: React.ReactNode;
  onClose: () => void;
}

export function ContextMenu({ x, y, children, onClose }: MenuProps) {
  const px = Math.min(x, window.innerWidth - 250);
  const py = Math.min(y, window.innerHeight - 260);
  return (
    <div
      className="context-menu"
      style={{ left: px, top: py }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  );
}

/* ─── Menu items ─────────────────────────────────────────────────────────── */

interface MenuItemProps {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

function MenuItem({ label, danger, onClick }: MenuItemProps) {
  return (
    <button
      className="button button--menu"
      style={danger ? { color: "var(--danger)" } : undefined}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function Separator() {
  return <div className="context-menu-separator" />;
}

/* ─── Region menu ────────────────────────────────────────────────────────── */

interface RegionMenuProps {
  x: number; y: number;
  span: FlaggedSpan;
  onClose: () => void;
  onSplitAtPlayhead: () => void;
  onToggleSpare: () => void;
  onDelete: () => void;
}

export function RegionContextMenu({
  x, y, span, onClose, onSplitAtPlayhead, onToggleSpare, onDelete,
}: RegionMenuProps) {
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      <MenuItem label="✂ Split region at playhead" onClick={() => { onSplitAtPlayhead(); onClose(); }} />
      {span.enabled ? (
        <MenuItem
          label="◌ Spare this section (leave it in)"
          onClick={() => { onToggleSpare(); onClose(); }}
        />
      ) : (
        <MenuItem
          label="● Mark for removal"
          onClick={() => { onToggleSpare(); onClose(); }}
        />
      )}
      <Separator />
      <MenuItem
        label="🗑 Delete region"
        danger
        onClick={() => { onDelete(); onClose(); }}
      />
    </ContextMenu>
  );
}

/* ─── Clip menu ──────────────────────────────────────────────────────────── */

interface ClipMenuProps {
  x: number; y: number;
  lane: "video" | "audio";
  clip: TrackSegment;
  hasPrevGap: boolean;
  onClose: () => void;
  onCutThisLane: () => void;
  onCutBothLanes: () => void;
  onCloseGap: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onGainChange: (g: number) => void;
  onGainDragStart: () => void;
}

export function ClipContextMenu({
  x, y, lane, clip, hasPrevGap,
  onClose, onCutThisLane, onCutBothLanes, onCloseGap, onToggle, onDelete,
  onGainChange, onGainDragStart,
}: ClipMenuProps) {
  const laneName = lane === "video" ? "video" : "sound";
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      <MenuItem
        label={`✂ Cut only ${laneName} at playhead`}
        onClick={() => { onCutThisLane(); onClose(); }}
      />
      <MenuItem
        label="✂ Cut both lanes at playhead"
        onClick={() => { onCutBothLanes(); onClose(); }}
      />
      <Separator />
      {hasPrevGap && (
        <MenuItem
          label="⇤ Close gap (snap to previous clip)"
          onClick={() => { onCloseGap(); onClose(); }}
        />
      )}
      {lane === "audio" && clip.enabled && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            fontFamily: 'var(--font-courier),"Courier Prime",monospace',
            fontSize: 12,
            color: "#1F1F1F",
          }}
        >
          <span>🔊 Volume</span>
          <input
            type="range"
            min={0}
            max={200}
            value={Math.round((clip.gain ?? 1) * 100)}
            style={{ flex: 1, minWidth: 90, accentColor: "#C65D3B" }}
            aria-label="Volume"
            onPointerDown={onGainDragStart}
            onChange={(e) => onGainChange(Number(e.target.value) / 100)}
          />
          <span
            style={{
              fontVariantNumeric: "tabular-nums",
              color: "var(--muted)",
              minWidth: 38,
              textAlign: "right",
            }}
          >
            {Math.round((clip.gain ?? 1) * 100)}%
          </span>
        </div>
      )}
      {lane === "video" && clip.enabled && (
        <MenuItem
          label="🚫 Black out this clip (its time stays)"
          onClick={() => { onToggle(); onClose(); }}
        />
      )}
      {lane === "audio" && clip.enabled && (
        <MenuItem
          label="🔇 Silence this clip (its time stays)"
          onClick={() => { onToggle(); onClose(); }}
        />
      )}
      {lane === "video" && !clip.enabled && (
        <MenuItem label="🎞 Restore video" onClick={() => { onToggle(); onClose(); }} />
      )}
      {lane === "audio" && !clip.enabled && (
        <MenuItem label="🔊 Restore sound" onClick={() => { onToggle(); onClose(); }} />
      )}
      <Separator />
      <MenuItem
        label={`🗑 Delete this ${laneName} clip (leaves a gap)`}
        danger
        onClick={() => { onDelete(); onClose(); }}
      />
    </ContextMenu>
  );
}

/* ─── Empty-area menu ────────────────────────────────────────────────────── */

interface EmptyMenuProps {
  x: number; y: number;
  clickTime: number;
  hasSpans: boolean;
  canSplit: boolean;
  onClose: () => void;
  onAddRegion: () => void;
  onSplitAtPlayhead: () => void;
  onSeekHere: () => void;
  onClearAll: () => void;
}

export function EmptyAreaContextMenu({
  x, y, clickTime, hasSpans, canSplit,
  onClose, onAddRegion, onSplitAtPlayhead, onSeekHere, onClearAll,
}: EmptyMenuProps) {
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      <MenuItem
        label={`+ Add region at ${formatClock(clickTime)}`}
        onClick={() => { onAddRegion(); onClose(); }}
      />
      {canSplit && (
        <MenuItem
          label="✂ Split region at playhead"
          onClick={() => { onSplitAtPlayhead(); onClose(); }}
        />
      )}
      <MenuItem
        label="⇥ Move playhead here"
        onClick={() => { onSeekHere(); onClose(); }}
      />
      {hasSpans && <Separator />}
      {hasSpans && (
        <MenuItem
          label="🗑 Clear all regions"
          danger
          onClick={() => { onClearAll(); onClose(); }}
        />
      )}
    </ContextMenu>
  );
}
