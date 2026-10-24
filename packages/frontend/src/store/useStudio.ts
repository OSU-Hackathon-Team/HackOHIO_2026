// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/06_state_and_api_client.md §3-4
import { useStore } from "zustand";
import { api } from "../api/client";
import { createStudio, type StudioState } from "./studioState";

export const studio = createStudio(api);

export function useStudio<T>(selector: (state: StudioState) => T): T {
  return useStore(studio, selector);
}

useStudio.getState = studio.getState;
useStudio.setState = studio.setState;
useStudio.subscribe = studio.subscribe;
