export interface MockControls {
  /** Multiplies every artificial delay. 1 by default; 4 under ?mock=slow. */
  speed: number;
  emptyScan: boolean;
  scanFails: boolean;
  rateLimited: boolean;
  offline: boolean;
  exportFails: boolean;
  unauthorised: boolean;
  publishUnconfigured: boolean;
  stallMedia: boolean;
  account: "in" | "out" | null;
}

/** Parse MockControls from the current page URL. Safe to call on the server
 *  (returns defaults) — only reads `window.location` when available. */
export function parseMockControls(): MockControls {
  if (typeof window === "undefined") {
    return defaultControls();
  }

  const params = new URLSearchParams(window.location.search);
  const mock = (params.get("mock") ?? "").split(",").map((s) => s.trim());
  const auth = params.get("auth") as "in" | "out" | null;

  return {
    speed: mock.includes("slow") ? 4 : 1,
    emptyScan: mock.includes("empty"),
    scanFails: mock.includes("scan-error"),
    rateLimited: mock.includes("rate-limit"),
    offline: mock.includes("offline"),
    exportFails: mock.includes("export-error"),
    unauthorised: mock.includes("unauthorised"),
    publishUnconfigured: mock.includes("unconfigured"),
    stallMedia: mock.includes("stall-media"),
    account: auth === "in" || auth === "out" ? auth : null,
  };
}

function defaultControls(): MockControls {
  return {
    speed: 1,
    emptyScan: false,
    scanFails: false,
    rateLimited: false,
    offline: false,
    exportFails: false,
    unauthorised: false,
    publishUnconfigured: false,
    stallMedia: false,
    account: null,
  };
}
