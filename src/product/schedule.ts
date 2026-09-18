import { digest } from "../core/integrity.js";
import type { Task, HarnessRelease } from "../core/records.js";
import type { Slot } from "./types.js";
export function buildSchedule(
  comparisonId: string,
  tasks: Task[],
  releases: { current: HarnessRelease; candidate: HarnessRelease },
  seed: string,
): Slot[] {
  const slots: Slot[] = [];
  for (const task of tasks)
    for (const repeat of [1, 2] as const) {
      const order = (
        parseInt(digest({ seed, task: task.id, repeat }).slice(0, 2), 16) %
          2 ===
        0
          ? ["current", "candidate"]
          : ["candidate", "current"]
      ) as ("current" | "candidate")[];
      for (const release_id of order) {
        slots.push({
          id: `${comparisonId}-${task.id}-${repeat}-${release_id}`,
          task_id: task.id,
          task_digest: task.digest,
          release_id,
          release_digest: releases[release_id].digest,
          repeat,
          block_id: `${task.id}-${repeat}`,
          order: slots.length,
        });
      }
    }
  return slots;
}
