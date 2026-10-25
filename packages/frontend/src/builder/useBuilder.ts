import { useStore } from "zustand";
import { createBuilderStore, type BuilderState } from "./store";
import { requestBuilderEdit } from "./api";
let storage: Storage | undefined;
try { storage = window.localStorage; } catch { /* The store exposes a save error after the first edit. */ }
export const builder = createBuilderStore(requestBuilderEdit, storage);
export const useBuilder = <T,>(selector: (state: BuilderState) => T) => useStore(builder, selector);
