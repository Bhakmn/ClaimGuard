"use client";

import React, { useCallback } from "react";
import type { FlaggedSpan, FlaggedVisualSpan, TrackSegment, ExportStrategy, VisualExportStrategy } from "@/lib/types";
import { resolveTimelineAt, VISUAL_CATEGORY_LABELS } from "@/lib/types";
import { formatClock } from "@/lib/formatters";
import { takeSnapshot, pushUndo, type WorkspaceState } from "@/lib/workspace-state";
import { clipsEdited } from "@/lib/clips-edited";

/* ─── Props ──────────────────────────────────────────────────────────────── */

interface FlaggedSectionsPanelProps {
  state: WorkspaceState;
  update: (patch: Partial<WorkspaceState>) => void;
  onExport: () => void;
}

/* ─── Row sub-component ──────────────────────────────────────────────────── */

interface RegionRowProps {
  span: FlaggedSpan;
  selected: boolean;
  audioSegments: TrackSegment[];
  onSelect: () => void;
  onSeek: (t: number) => void;
  onToggle: () => void;
  onDelete: () => void;
}

function RegionRow({
  span,
  selected,
  audioSegments,
  onSelect,
  onSeek,
  onToggle,
  onDelete,
}: RegionRowProps) {
  const startLabel = formatClock(span.start);
  const endLabel = formatClock(span.end);
  const title = span.title || "Unknown";

  // Build subtitle
  const parts: string[] = [];
  if (span.artists) {
    parts.push(span.artists);
  } else if (span.manual) {
    parts.push("added manually");
  }
  if (span.album) parts.push(span.album);
  if (span.confidence > 0) parts.push(`match ${Math.round(span.confidence)}%`);
  const subtitle = parts.join(" · ");

  const handleRowClick = useCallback(() => {
    onSelect();
    // Map span.start (source time) through audio segments to a timeline position
    const tl = resolveTimelineAt(audioSegments, span.start);
    if (tl !== null) onSeek(tl);
  }, [onSelect, onSeek, span.start, audioSegments]);

  const handleToggleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggle();
    },
    [onToggle]
  );

  const handleDeleteClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete();
    },
    [onDelete]
  );

  return (
    <div
      role="button"
      tabIndex={0}
      className={`region-row${selected ? " region-row--selected" : ""}`}
      onClick={handleRowClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleRowClick();
        }
      }}
      aria-pressed={selected}
    >
      {/* Timecodes */}
      <div className="region-row-timecodes">
        {startLabel} → {endLabel}
      </div>

      {/* Metadata */}
      <div className="region-row-meta">
        <div className="region-row-title">{title}</div>
        {subtitle && <div className="region-row-subtitle">{subtitle}</div>}
      </div>

      {/* Remove toggle */}
      <label
        className="region-row-toggle"
        onClick={handleToggleClick}
        aria-label={`Remove ${title} from ${startLabel} to ${endLabel}`}
      >
        <input
          type="checkbox"
          checked={span.enabled}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
        />
        remove
      </label>

      {/* Delete */}
      <button
        className="region-row-delete"
        onClick={handleDeleteClick}
        aria-label={`Delete the flag on ${title} at ${startLabel}`}
        type="button"
      >
        ✕
      </button>
    </div>
  );
}

/* ─── Visual region row ──────────────────────────────────────────────────── */

interface VisualRegionRowProps {
  span: FlaggedVisualSpan;
  onToggle: () => void;
  onDelete: () => void;
}

function VisualRegionRow({ span, onToggle, onDelete }: VisualRegionRowProps) {
  const startLabel = formatClock(span.start);
  const endLabel = formatClock(span.end);
  const displayLabel = VISUAL_CATEGORY_LABELS[span.label] ?? span.label;

  return (
    <div className="region-row" style={{ borderLeft: "3px solid #7c5cd8" }}>
      <div className="region-row-timecodes">{startLabel} → {endLabel}</div>
      <div className="region-row-meta">
        {/* Category headline */}
        <div className="region-row-title" style={{ color: "#7c5cd8" }}>
          ◈ Possible copyright · {displayLabel}
        </div>
        {/* Confidence + signals */}
        {span.signals.length > 0 && (
          <div className="region-row-subtitle">
            {span.signals.slice(0, 2).join(" · ")}
            {span.confidence > 0 ? ` · ${Math.round(span.confidence)}% confidence` : ""}
          </div>
        )}
        {/* Model reasoning — human-reviewable, not a legal determination */}
        {span.reasoning && span.reasoning !== "(inherited from previous frame — scene unchanged)" && (
          <div className="region-row-subtitle" style={{ fontStyle: "italic", marginTop: 2, color: "#57606a" }}>
            {span.reasoning}
          </div>
        )}
        {/* Review disclaimer */}
        <div className="region-row-subtitle" style={{ marginTop: 3, fontSize: 10, color: "#57606a" }}>
          Candidate for human review — not a legal determination.
        </div>
      </div>
      <label
        className="region-row-toggle"
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        aria-label={`Remove visual flag "${displayLabel}" from ${startLabel} to ${endLabel}`}
      >
        <input
          type="checkbox"
          checked={span.enabled}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
        />
        remove
      </label>
      <button
        className="region-row-delete"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        aria-label={`Delete visual flag "${displayLabel}" at ${startLabel}`}
        type="button"
      >
        ✕
      </button>
    </div>
  );
}

/* ─── Panel component ────────────────────────────────────────────────────── */

export function FlaggedSectionsPanel({
  state,
  update,
  onExport,
}: FlaggedSectionsPanelProps) {
  const primaryItem = state.items[0] ?? null;
  const primaryDuration = primaryItem?.duration ?? 0;

  const edited = clipsEdited(
    state.items,
    state.videoSegments,
    state.audioSegments,
    primaryDuration
  );

  const hasSpans = state.spans.length > 0;
  const hasVisualSpans = state.visualSpans.length > 0;

  // Visibility gate
  if (!hasSpans && !hasVisualSpans && !edited) return null;

  const heading = hasSpans || hasVisualSpans
    ? `Flagged sections (${state.spans.length + state.visualSpans.length})`
    : "Edited timeline";

  /* ── Callbacks ─────────────────────────────────────────────────────────── */

  const handleStrategyChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      update({ exportStrategy: e.target.value as ExportStrategy });
    },
    [update]
  );

  const handleVisualStrategyChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      update({ visualExportStrategy: e.target.value as VisualExportStrategy });
    },
    [update]
  );

  const handleSelectSpan = useCallback(
    (id: string) => {
      update({ selectedSpanId: id, selectedClip: null });
    },
    [update]
  );

  const handleSeek = useCallback(
    (t: number) => {
      update({ playhead: t });
    },
    [update]
  );

  const handleToggle = useCallback(
    (id: string) => {
      const snap = takeSnapshot(state);
      update({
        ...pushUndo(state, snap),
        spans: state.spans.map((s) =>
          s.id === id ? { ...s, enabled: !s.enabled } : s
        ),
      });
    },
    [state, update]
  );

  const handleDelete = useCallback(
    (id: string) => {
      const snap = takeSnapshot(state);
      update({
        ...pushUndo(state, snap),
        spans: state.spans.filter((s) => s.id !== id),
        selectedSpanId:
          state.selectedSpanId === id ? null : state.selectedSpanId,
      });
    },
    [state, update]
  );

  const handleVisualToggle = useCallback(
    (id: string) => {
      const snap = takeSnapshot(state);
      update({
        ...pushUndo(state, snap),
        visualSpans: state.visualSpans.map((s) =>
          s.id === id ? { ...s, enabled: !s.enabled } : s
        ),
      });
    },
    [state, update]
  );

  const handleVisualDelete = useCallback(
    (id: string) => {
      const snap = takeSnapshot(state);
      update({
        ...pushUndo(state, snap),
        visualSpans: state.visualSpans.filter((s) => s.id !== id),
      });
    },
    [state, update]
  );

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div className="panel">
      {/* Header row */}
      <div className="flagged-header-row">
        <h2 className="flagged-panel-h2">{heading}</h2>

        <div className="flagged-header-controls">
          {/* Audio strategy select — shown when there are audio spans or edits */}
          {(hasSpans || edited) && (
            <select
              className="select-field"
              value={state.exportStrategy}
              onChange={handleStrategyChange}
              disabled={state.exporting}
              title="How to handle flagged audio sections"
              aria-label="Audio export strategy"
            >
              <option value="lossless">
                Audio: cut lossless (stream copy)
              </option>
              <option value="precise">
                Audio: cut precise (re-encode)
              </option>
              <option value="mute">Audio: mute only (keep length)</option>
            </select>
          )}

          {/* Visual strategy select — shown when there are visual spans */}
          {hasVisualSpans && (
            <select
              className="select-field"
              value={state.visualExportStrategy}
              onChange={handleVisualStrategyChange}
              disabled={state.exporting}
              title="How to handle flagged visual sections (muting is not offered — the footage is on-screen regardless)"
              aria-label="Visual export strategy"
            >
              <option value="cut_lossless">
                Visual: cut lossless (stream copy)
              </option>
              <option value="cut_precise">
                Visual: cut precise (re-encode)
              </option>
              <option value="warn_only">Visual: warn only (keep footage)</option>
            </select>
          )}

          {/* Export button */}
          <button
            className="button button--primary"
            onClick={onExport}
            disabled={state.exporting || state.scanning}
            type="button"
          >
            {state.exporting ? "Exporting…" : "Export cleaned video"}
          </button>
        </div>
      </div>

      {/* Audio region list */}
      {hasSpans && (
        <div
          style={{
            marginTop: 14,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {state.spans.map((span) => (
            <RegionRow
              key={span.id}
              span={span}
              selected={state.selectedSpanId === span.id}
              audioSegments={state.audioSegments}
              onSelect={() => handleSelectSpan(span.id)}
              onSeek={handleSeek}
              onToggle={() => handleToggle(span.id)}
              onDelete={() => handleDelete(span.id)}
            />
          ))}
        </div>
      )}

      {/* Visual region list */}
      {hasVisualSpans && (
        <div style={{ marginTop: hasSpans ? 16 : 14 }}>
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: "0.06em",
              color: "#7c5cd8",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            ◈ Visual flags ({state.visualSpans.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {state.visualSpans.map((span) => (
              <VisualRegionRow
                key={span.id}
                span={span}
                onToggle={() => handleVisualToggle(span.id)}
                onDelete={() => handleVisualDelete(span.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Selection hint */}
      {state.selectedSpanId && (
        <p className="selection-hint">
          Drag a region&rsquo;s edges to fine-tune where the cut starts and
          ends; edges snap to the playhead and to neighbouring region and clip
          boundaries. The region itself is pinned to the sound it flags — to
          move it, drag the audio clip underneath.
        </p>
      )}
    </div>
  );
}
