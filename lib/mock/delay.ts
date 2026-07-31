import type { MockControls } from "./controls";

let controls: MockControls | null = null;

export function setControls(c: MockControls): void {
  controls = c;
}

export function getControls(): MockControls {
  if (!controls) throw new Error("MockControls not initialised");
  return controls;
}

/** Resolves after ms * controls.speed milliseconds. */
export function delay(ms: number): Promise<void> {
  const speed = controls?.speed ?? 1;
  return new Promise((resolve) => setTimeout(resolve, ms * speed));
}
