import React from "react";

export function CardBack() {
  const STEPS = [
    {
      num: "01",
      title: "Upload",
      desc: "Drop an MP4 / MOV / WebM. It stays in your browser.",
    },
    {
      num: "02",
      title: "Scan",
      desc: "Audio fingerprinting finds every copyrighted song in the soundtrack.",
    },
    {
      num: "03",
      title: "Edit & Export",
      desc: "Cut, mute or trim the flagged parts, then download clean.",
    },
  ];

  return (
    <div
      className="launch-card-back card-in paper-texture"
    >
      {/* Vertical rail */}
      <div
        style={{
          position: "absolute",
          left: 16,
          top: 0,
          bottom: 0,
          display: "flex",
          alignItems: "center",
          borderRight: "1px solid rgba(0,0,0,0.1)",
          paddingRight: 8,
        }}
      >
        <span
          style={{
            writingMode: "vertical-rl",
            textOrientation: "mixed",
            fontFamily: 'var(--font-courier),"Courier Prime",monospace',
            fontSize: 10,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            opacity: 0.6,
            color: "#1F1F1F",
            transform: "rotate(180deg)",
          }}
          aria-hidden="true"
        >
          the process, start to finish
        </span>
      </div>

      {/* Body */}
      <div
        style={{
          padding: "40px 32px 32px 48px",
          display: "flex",
          flexDirection: "column",
          height: "100%",
        }}
      >
        {/* Heading */}
        <div style={{ marginTop: 16 }}>
          <div
            className="font-serif-display"
            style={{
              fontSize: 36,
              lineHeight: 1,
              color: "#1F1F1F",
            }}
          >
            <div style={{ letterSpacing: "-0.02em" }}>How it</div>
            <div style={{ fontStyle: "italic", paddingLeft: 16 }}>works</div>
          </div>
        </div>

        {/* Steps */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 20,
            marginTop: 24,
            justifyContent: "center",
          }}
        >
          {STEPS.map((step) => (
            <div
              key={step.num}
              style={{ display: "flex", gap: 12 }}
            >
              <span
                style={{
                  fontFamily:
                    'var(--font-courier),"Courier Prime",monospace',
                  fontSize: 10,
                  color: "#C65D3B",
                  textTransform: "uppercase",
                  letterSpacing: "0.2em",
                  marginTop: 4,
                  flexShrink: 0,
                }}
              >
                {step.num}
              </span>
              <div>
                <div
                  className="font-serif-display"
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    lineHeight: 1.25,
                    color: "#1F1F1F",
                  }}
                >
                  {step.title}
                </div>
                <div
                  style={{
                    fontFamily:
                      'var(--font-courier),"Courier Prime",monospace',
                    fontSize: 12,
                    lineHeight: 1.625,
                    opacity: 0.6,
                    color: "#1F1F1F",
                    marginTop: 2,
                  }}
                >
                  {step.desc}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
