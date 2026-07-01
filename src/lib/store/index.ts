import { MemoryStore } from "./memory";
import { SupabaseStore } from "./supabase";
import type { Store } from "./types";

let cached: Store | null = null;

/**
 * Returns the Supabase-backed store when SUPABASE_URL is configured,
 * otherwise a process-wide in-memory store (paper mode, demos, tests).
 */
export function getStore(): Store {
  if (!cached) {
    cached = process.env.SUPABASE_URL ? SupabaseStore.fromEnv() : new MemoryStore();
  }
  return cached;
}

export { MemoryStore } from "./memory";
export { SupabaseStore } from "./supabase";
export type * from "./types";
