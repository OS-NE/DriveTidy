import { useSyncExternalStore } from "react";

export type ActivityKind = "skipped" | "moved" | "failed" | "stopped";
export interface ActivityEntry {
  id: number;
  time: number;
  kind: ActivityKind;
  path: string;
  reason: string;
}

const MAX = 5000;
let entries: ActivityEntry[] = [];
let seq = 0;
let dropped = 0;
const subs = new Set<() => void>();
let pending = false;

function emit() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    subs.forEach((s) => s());
  });
}

export function logActivity(kind: ActivityKind, path: string, reason: string) {
  entries = [...entries, { id: ++seq, time: Date.now(), kind, path, reason }];
  if (entries.length > MAX) {
    dropped += entries.length - MAX;
    entries = entries.slice(-MAX);
  }
  emit();
}

export function clearActivity() {
  entries = [];
  dropped = 0;
  emit();
}
export function droppedActivity() {
  return dropped;
}

export function useActivity() {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => entries,
    () => entries,
  );
}
