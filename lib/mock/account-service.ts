import type { AccountProfile } from "../types";
import { delay, getControls } from "./delay";

export interface AccountService {
  getProfile(): Promise<AccountProfile | null>;
  signIn(intent: "login" | "signup"): Promise<AccountProfile>;
  signOut(): Promise<void>;
}

export const FIXTURE_PROFILE: AccountProfile = {
  name: "Marguerite Okafor",
  email: "m.okafor@driftwavemedia.co",
  picture:
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
        '<rect width="40" height="40" rx="20" fill="#C65D3B"/>' +
        '<circle cx="20" cy="16" r="7" fill="#F4F1EA"/>' +
        '<path d="M6 40c0-8 6.3-13 14-13s14 5 14 13z" fill="#F4F1EA"/>' +
      "</svg>"
    ),
};

const FIXTURE_PROFILE_NO_AVATAR: AccountProfile = {
  name: "Marguerite Okafor",
  email: "m.okafor@driftwavemedia.co",
};

let _profile: AccountProfile | null = null;
let _initialised = false;

export const mockAccountService: AccountService = {
  async getProfile() {
    const controls = getControls();
    await delay(300);

    if (!_initialised) {
      _initialised = true;
      if (controls.account === "in") {
        const params =
          typeof window !== "undefined"
            ? new URLSearchParams(window.location.search)
            : null;
        _profile =
          params?.get("avatar") === "none"
            ? FIXTURE_PROFILE_NO_AVATAR
            : FIXTURE_PROFILE;
      } else {
        _profile = null;
      }
    }

    return _profile;
  },

  async signIn(_intent) {
    await delay(900);
    const params =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : null;
    _profile =
      params?.get("avatar") === "none"
        ? FIXTURE_PROFILE_NO_AVATAR
        : FIXTURE_PROFILE;
    _initialised = true;
    return _profile;
  },

  async signOut() {
    await delay(300);
    _profile = null;
  },
};
