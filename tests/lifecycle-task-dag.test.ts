import { describe, expect, it } from "vitest";
import {
  parseTaskDag,
  orderWaves,
  selectNextWave,
  validateDag,
  type FabricTask,
} from "../src/lifecycle/task-dag.js";

const task = (overrides: Partial<FabricTask> = {}): FabricTask => ({
  id: "1.1",
  description: "Setup task",
  dependsOn: [],
  parallel: true,
  conflictsWith: [],
  files: [],
  verify: undefined,
  ...overrides,
});

describe("parseTaskDag", () => {
  it("parses a multi-section plan with all fields on each task", () => {
    const dag = parseTaskDag({
      tasks: [
        task({ id: "1.1", description: "Setup", files: ["package.json"], verify: "pnpm run typecheck" }),
        task({ id: "1.2", description: "Config", dependsOn: ["1.1"], parallel: false, files: ["tsconfig.json"], verify: "pnpm exec tsc --noEmit" }),
        task({ id: "2.1", description: "Impl", dependsOn: ["1.1", "1.2"], parallel: true, conflictsWith: ["2.2"], files: ["src/feature/index.ts"], verify: "pnpm test" }),
      ],
    });
    expect(dag).toHaveLength(3);
    expect(dag[0]!.id).toBe("1.1");
    expect(dag[0]!.files).toEqual(["package.json"]);
    expect(dag[1]!.dependsOn).toEqual(["1.1"]);
    expect(dag[1]!.parallel).toBe(false);
    expect(dag[2]!.conflictsWith).toEqual(["2.2"]);
    expect(dag[2]!.verify).toBe("pnpm test");
  });

  it("handles a task that omits every optional field", () => {
    const dag = parseTaskDag({
      tasks: [{ id: "solo", description: "No deps, no files, no verify" }],
    });
    expect(dag).toHaveLength(1);
    expect(dag[0]!.dependsOn).toEqual([]);
    expect(dag[0]!.parallel).toBe(true);
    expect(dag[0]!.conflictsWith).toEqual([]);
    expect(dag[0]!.files).toEqual([]);
    expect(dag[0]!.verify).toBeUndefined();
  });

  it("rejects dependency cycles", () => {
    expect(() =>
      parseTaskDag({
        tasks: [
          task({ id: "a", dependsOn: ["b"] }),
          task({ id: "b", dependsOn: ["a"] }),
        ],
      }),
    ).toThrow(/cycle/i);
  });

  it("rejects dangling dependsOn references naming the id", () => {
    expect(() =>
      parseTaskDag({
        tasks: [
          task({ id: "1.1", dependsOn: ["ghost"] }),
        ],
      }),
    ).toThrow("ghost");
  });

  it("rejects duplicate task ids", () => {
    expect(() =>
      parseTaskDag({
        tasks: [
          task({ id: "dup" }),
          task({ id: "dup" }),
        ],
      }),
    ).toThrow("Duplicate task id: dup");
  });
});

describe("validateDag", () => {
  it("passes silently for a valid DAG", () => {
    const tasks = [task({ id: "a" }), task({ id: "b", dependsOn: ["a"] })];
    expect(() => validateDag(tasks)).not.toThrow();
  });

  it("rejects a dangling reference by id", () => {
    const tasks = [task({ id: "a", dependsOn: ["ghost"] })];
    expect(() => validateDag(tasks)).toThrow("ghost");
  });
});

describe("orderWaves", () => {
  it("keeps file-sharing parallel tasks in separate waves", () => {
    const waves = orderWaves([
      task({ id: "a", files: ["src/index.ts"] }),
      task({ id: "b", files: ["src/index.ts"] }),
    ]);
    expect(waves).toHaveLength(2);
    expect(waves[0]).toHaveLength(1);
    expect(waves[1]).toHaveLength(1);
  });

  it("keeps conflictsWith tasks in separate waves", () => {
    const waves = orderWaves([
      task({ id: "a", conflictsWith: ["b"] }),
      task({ id: "b", conflictsWith: ["a"] }),
    ]);
    expect(waves).toHaveLength(2);
  });

  it("groups disjoint-file parallel tasks into the same wave", () => {
    const waves = orderWaves([
      task({ id: "a", files: ["src/a.ts"] }),
      task({ id: "b", files: ["src/b.ts"] }),
    ]);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(2);
  });
});

describe("selectNextWave", () => {
  const dag = [
    task({ id: "a", files: ["a.ts"] }),
    task({ id: "b", files: ["b.ts"], dependsOn: ["a"] }),
    task({ id: "c", files: ["c.ts"], dependsOn: ["b"] }),
  ];

  it("returns the first wave when nothing is completed", () => {
    const wave = selectNextWave(dag, []);
    expect(wave?.map((t) => t.id)).toEqual(["a"]);
  });

  it("returns the next wave when the current one is fully completed", () => {
    const wave = selectNextWave(dag, ["a"]);
    expect(wave?.map((t) => t.id)).toEqual(["b"]);
  });

  it("returns undefined when the plan is fully completed", () => {
    expect(selectNextWave(dag, ["a", "b", "c"])).toBeUndefined();
  });
});