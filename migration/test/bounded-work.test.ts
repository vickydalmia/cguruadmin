import assert from "node:assert/strict";
import test from "node:test";
import { runBoundedWork } from "../src/utils/bounded-work.js";

test("worker failure stops queued work but waits for active work", async () => {
  const started: string[] = [];
  const completed: string[] = [];

  await assert.rejects(
    runBoundedWork({
      items: ["broken", "slow", "must-not-start-1", "must-not-start-2"],
      concurrency: 2,
      label: "Taxonomy migration",
      worker: async (item) => {
        started.push(item);
        if (item === "broken") throw new Error("broken term");
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
        completed.push(item);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /Taxonomy migration: 1 task\(s\) failed/);
      return true;
    },
  );

  assert.deepEqual(started, ["broken", "slow"]);
  assert.deepEqual(completed, ["slow"]);
});

test("successful bounded workers process every item exactly once", async () => {
  const completed: number[] = [];
  await runBoundedWork({
    items: [1, 2, 3, 4],
    concurrency: 2,
    label: "work",
    worker: async (item) => {
      completed.push(item);
    },
  });

  assert.deepEqual([...completed].sort((a, b) => a - b), [1, 2, 3, 4]);
});
