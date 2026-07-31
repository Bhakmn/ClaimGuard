/** Static metadata for each of the four scan stages. */
export interface StageDef {
  index: 0 | 1 | 2 | 3;
  label: string;
  cardBg: string;
  cardText: string;
  accent: string;
  description: string;
}

export const STAGES: StageDef[] = [
  {
    index: 0,
    label: "Load Engine",
    cardBg: "#D1D1C9",
    cardText: "#1F1F1F",
    accent: "#C65D3B",
    description:
      "Loading the audio engine that powers scanning, right in your browser.",
  },
  {
    index: 1,
    label: "Prepare Video",
    cardBg: "#FFC233",
    cardText: "#1F1F1F",
    accent: "#C65D3B",
    description:
      "Reading your video file and preparing its audio track.",
  },
  {
    index: 2,
    label: "Waveform",
    cardBg: "#C65D3B",
    cardText: "#F4F1EA",
    accent: "#FFC233",
    description: "Building a waveform preview of the soundtrack.",
  },
  {
    index: 3,
    label: "Scan",
    cardBg: "#1F1F1F",
    cardText: "#F4F1EA",
    accent: "#FFC233",
    description:
      "Fingerprinting the soundtrack and scanning video frames for copyrighted content.",
  },
];
