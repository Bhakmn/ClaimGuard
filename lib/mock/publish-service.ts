import { delay, getControls } from "./delay";

export type PublishTarget = "youtube" | "tiktok" | "instagram";

export interface PublishService {
  isConfigured(target: PublishTarget): boolean;
  getConnection(target: PublishTarget): Promise<{ connected: boolean }>;
  connect(target: PublishTarget): Promise<void>;
  publish(input: {
    target: PublishTarget;
    url: string;
    filename: string;
    title: string;
  }): Promise<{ link?: string }>;
}

let tiktokConnected = false;

export const mockPublishService: PublishService = {
  isConfigured(target) {
    const controls = getControls();
    if (controls.publishUnconfigured && target === "youtube") return false;
    return true;
  },

  async getConnection(target) {
    if (target !== "tiktok") {
      await delay(400);
      return { connected: false };
    }
    await delay(400);
    return { connected: tiktokConnected };
  },

  async connect(target) {
    const controls = getControls();
    if (target !== "tiktok") return;
    if (controls.offline) {
      await delay(400);
      throw new Error("Couldn't reach TikTok. Check your connection.");
    }
    await delay(1500);
    tiktokConnected = true;
  },

  async publish(input) {
    const controls = getControls();

    if (controls.unauthorised) {
      await delay(300);
      throw new Error("Your session expired. Connect again.");
    }

    if (controls.offline) {
      await delay(300);
      throw new Error("No connection. Reconnect and try again.");
    }

    switch (input.target) {
      case "youtube":
        await delay(2600);
        return { link: "https://youtu.be/qN4x7Lm2Ptc" };
      case "tiktok":
        await delay(2200);
        return {};
      case "instagram":
        return {};
    }
  },
};
