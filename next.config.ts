import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  images: {
    unoptimized: true,
  },
  /**
   * Dev proxy: forward /api/*, /auth/* and /health* to the backend at
   * BACKEND_ORIGIN (default http://localhost:4000).
   *
   * This makes the browser see one origin (http://localhost:3000), which is
   * required for:
   *  - Cookies on every API call (SameSite=Lax with same origin)
   *  - The TikTok OAuth popup: window.opener.postMessage origin check
   *
   * In production a reverse proxy (nginx / Caddy) handles this instead —
   * Next.js rewrites are only active during `next dev` and `next build`.
   */
  async rewrites() {
    const api = process.env.BACKEND_ORIGIN ?? "http://localhost:4000";
    return [
      { source: "/api/:path*",  destination: `${api}/api/:path*` },
      { source: "/auth/:path*", destination: `${api}/auth/:path*` },
      { source: "/health",      destination: `${api}/health` },
      { source: "/health/:path*", destination: `${api}/health/:path*` },
    ];
  },
  /**
   * Allow Next.js dev-server asset and hot-reload requests from ngrok tunnels
   * used for TikTok OAuth testing (TikTok requires https redirect URIs).
   */
  allowedDevOrigins: ["*.ngrok-free.dev", "*.ngrok-free.app"],
};

export default nextConfig;
