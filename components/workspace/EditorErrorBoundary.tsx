"use client";

import React from "react";

interface State {
  error: Error | null;
}

interface Props {
  children: React.ReactNode;
  /** Optional label shown in the error banner — e.g. "Timeline" */
  label?: string;
  /** Called when the user clicks "Try again" */
  onReset?: () => void;
}

/**
 * Catches any synchronous render error inside its subtree and shows an
 * actionable banner instead of leaving the page blank.  Errors are also
 * logged to the console so they appear in DevTools.
 */
export class EditorErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(
      `[EditorErrorBoundary] Caught error in ${this.props.label ?? "editor"}:`,
      error,
      info.componentStack,
    );
  }

  private handleReset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          margin: "16px 0",
          padding: "16px 20px",
          background: "rgba(198,93,59,0.07)",
          border: "1px solid #C65D3B",
          borderRadius: 8,
          fontFamily: '"Courier Prime", "Courier New", monospace',
          fontSize: 12.5,
          lineHeight: 1.6,
          color: "#1F1F1F",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 6, color: "#C65D3B" }}>
          ⚠ {this.props.label ?? "Editor"} crashed
        </div>
        <div style={{ marginBottom: 12, color: "#57606a" }}>
          {error.message || String(error)}
        </div>
        <button
          type="button"
          onClick={this.handleReset}
          style={{
            cursor: "pointer",
            border: "1px solid #C65D3B",
            background: "#fff",
            color: "#C65D3B",
            fontFamily: "inherit",
            fontSize: 11,
            fontWeight: 700,
            padding: "4px 14px",
            borderRadius: 5,
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
