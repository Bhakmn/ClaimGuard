"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { parseMockControls, type MockControls } from "../mock/controls";
import { setControls } from "../mock/delay";
import { mockMediaService, type MediaService } from "../mock/media-service";
import { mockScanService, type ScanService } from "../mock/scan-service";
import { mockExportService, type ExportService } from "../mock/export-service";
import { mockAccountService, type AccountService } from "../mock/account-service";
import { mockPublishService, type PublishService } from "../mock/publish-service";
import { realScanService } from "./real/scan-service";
import { realAccountService } from "./real/account-service";
import { realPublishService } from "./real/publish-service";
import { realExportService } from "./real/export-service";

/* ─── Feature flag ───────────────────────────────────────────────────────── */

/**
 * When NEXT_PUBLIC_USE_REAL_SERVICES=true the app uses real backend services.
 * If the backend is unreachable, an error is thrown — no silent mock fallback.
 *
 * When the flag is false (or unset), mock services are used unconditionally.
 *
 * Media and export always stay on mock implementations — they use the Web
 * Audio API and the browser's native media pipeline, not the backend.
 */
const WANTS_REAL = process.env.NEXT_PUBLIC_USE_REAL_SERVICES === "true";

/**
 * Probe GET /health with a short timeout.
 * Throws with a descriptive message if the backend is unreachable or returns
 * a non-2xx response — callers must not silently swallow the error.
 */
async function assertBackendReachable(): Promise<void> {
  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    res = await fetch("/health", {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
  } catch {
    throw new Error(
      "Backend unreachable — make sure the server is running on port 4000 (npm run dev:all)."
    );
  }
  if (!res.ok) {
    throw new Error(
      `Backend health check failed with status ${res.status}. Check the server logs for errors.`
    );
  }
}

/* ─── Context shape ──────────────────────────────────────────────────────── */

export interface Services {
  media: MediaService;
  scan: ScanService;
  export: ExportService;
  account: AccountService;
  publish: PublishService;
  controls: MockControls;
}

const ServicesCtx = createContext<Services | null>(null);

/* ─── Hook ───────────────────────────────────────────────────────────────── */

export function useServices(): Services {
  const ctx = useContext(ServicesCtx);
  if (!ctx) throw new Error("useServices must be used inside ServicesProvider");
  return ctx;
}

/* ─── Provider ───────────────────────────────────────────────────────────── */

export function ServicesProvider({ children }: { children: ReactNode }) {
  const [services, setServices] = useState<Services | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    const controls = parseMockControls();
    setControls(controls);

    async function init() {
      if (WANTS_REAL) {
        // Throws if backend is down — surfaces an error instead of fake data.
        await assertBackendReachable();
        setServices({
          media:   mockMediaService,
          scan:    realScanService,
          export:  realExportService,
          account: realAccountService,
          publish: realPublishService,
          controls,
        });
      } else {
        setServices({
          media:   mockMediaService,
          scan:    mockScanService,
          export:  realExportService,
          account: mockAccountService,
          publish: mockPublishService,
          controls,
        });
      }
    }

    init().catch((err: unknown) => {
      setInitError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  if (initError) {
    return (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        minHeight: "100vh", padding: "32px", fontFamily: "system-ui, sans-serif",
        background: "#0f0f0f", color: "#f87171",
      }}>
        <div style={{ maxWidth: 480, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 16 }}>⚠</div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, color: "#fca5a5" }}>
            Backend not available
          </div>
          <div style={{ fontSize: 13, color: "#f87171", lineHeight: 1.6 }}>
            {initError}
          </div>
        </div>
      </div>
    );
  }

  if (!services) return null;

  return (
    <ServicesCtx.Provider value={services}>
      {children}
    </ServicesCtx.Provider>
  );
}
