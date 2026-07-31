/**
 * Real AccountService implementation.
 *
 * Auth is handled entirely by the backend's Auth0 PKCE flow. Sign-in and
 * sign-out are plain browser navigations — not fetches. Profile data comes
 * from GET /api/session, which is already read server-side by the page shell
 * to avoid a flash on first paint.
 *
 * On the client side, `getProfile()` re-reads /api/session so components that
 * mount after the page has rendered can still show the signed-in state without
 * a prop-drilling chain.
 */

import type { AccountProfile } from "@/lib/types";
import type { AccountService } from "@/lib/mock/account-service";
import { apiFetch, ApiError } from "@/lib/api/client";
import { apiUrl } from "@/lib/api/config";

type SessionResponse = {
  authEnabled: boolean;
  user: { id: string; name?: string; email?: string; picture?: string } | null;
};

export const realAccountService: AccountService = {
  async getProfile(): Promise<AccountProfile | null> {
    try {
      const data = await apiFetch<SessionResponse>("/api/session");
      if (!data.user) return null;
      return {
        name:    data.user.name,
        email:   data.user.email,
        picture: data.user.picture,
      };
    } catch {
      return null;
    }
  },

  async signIn(intent: "login" | "signup"): Promise<AccountProfile> {
    // Navigate to the backend's Auth0 login endpoint.
    // This is a full-page navigation — the popup pattern is only for TikTok.
    const hint = intent === "signup" ? "?screen_hint=signup" : "";
    window.location.href = apiUrl(`/auth/login${hint}`);
    // This function never resolves — the navigation replaces the page.
    // Return a never-resolving promise to match the interface type.
    return new Promise<AccountProfile>(() => undefined);
  },

  async signOut(): Promise<void> {
    window.location.href = apiUrl("/auth/logout");
    // Same — never resolves.
    return new Promise<void>(() => undefined);
  },
};
