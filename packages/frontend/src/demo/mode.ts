// Kept import-free: ideFixtures, the store and the API client all read it.
const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();

export const demoMode = (import.meta as any).env?.VITE_API_MODE === "demo" || params.get("mode") === "demo";

/** `?speed=4` plays the scripted pipeline four times faster. */
export const demoSpeed = Math.max(0.1, Number(params.get("speed")) || 1);
