export interface FabricTask {
  id: string;
  description: string;
  dependsOn: string[];
  parallel: boolean;
  conflictsWith: string[];
  files: string[];
  verify: string | undefined;
}

export type TaskDag = FabricTask[];

export type TaskWave = FabricTask[];

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_TASKS = 128;
const MAX_FILES_PER_TASK = 32;


const bounded = (value: string, limit: number): string => value.trim().slice(0, limit);

const parseId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return ID_PATTERN.test(id) ? id : undefined;
};

const parseStringArray = (value: unknown, limit: number): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) return undefined;
    items.push(bounded(item, limit));
  }
  return items.slice(0, limit);
};

const parseTask = (value: unknown): FabricTask | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const id = parseId(raw.id);
  if (!id) return undefined;
  const description = typeof raw.description === "string" ? bounded(raw.description, 4_096) : "";
  const dependsOn = raw.dependsOn === undefined ? [] : parseStringArray(raw.dependsOn, MAX_TASKS);
  if (dependsOn === undefined) return undefined;
  const conflictsWith = raw.conflictsWith === undefined ? [] : parseStringArray(raw.conflictsWith, MAX_TASKS);
  if (conflictsWith === undefined) return undefined;
  const files = raw.files === undefined ? [] : parseStringArray(raw.files, MAX_FILES_PER_TASK);
  if (files === undefined) return undefined;
  const parallel = typeof raw.parallel === "boolean" ? raw.parallel : true;
  const verify = typeof raw.verify === "string" ? bounded(raw.verify, 1_024) : undefined;
  return { id, description, dependsOn, parallel, conflictsWith, files, verify };
};

export const parseTaskDag = (input: unknown): TaskDag => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Task DAG must be an array of task objects");
  }
  const raw = input as Record<string, unknown>;
  const taskArray = Array.isArray(raw.tasks) ? raw.tasks : (Array.isArray(input) ? input : undefined);
  if (!taskArray) throw new Error("Task DAG requires a tasks array");
  if (taskArray.length === 0) throw new Error("Task DAG must not be empty");
  if (taskArray.length > MAX_TASKS) throw new Error(`Task DAG exceeds ${MAX_TASKS} tasks`);

  const tasks: FabricTask[] = [];
  const seen = new Set<string>();
  for (const rawTask of taskArray) {
    const task = parseTask(rawTask);
    if (!task) throw new Error("Task DAG contains a malformed task");
    if (seen.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    seen.add(task.id);
    tasks.push(task);
  }

  validateDag(tasks);
  return tasks;
};

export const validateDag = (tasks: TaskDag): void => {
  const ids = new Set(tasks.map((t) => t.id));
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(`Task ${task.id} depends on nonexistent id: ${dep}`);
      }
    }
  }
  const visited = new Set<string>();
  const stack = new Set<string>();
  const cyclePath: string[] = [];
  const dfs = (id: string): boolean => {
    if (stack.has(id)) { cyclePath.push(id); return true; }
    if (visited.has(id)) return false;
    visited.add(id);
    stack.add(id);
    const task = tasks.find((t) => t.id === id);
    if (task) {
      for (const dep of task.dependsOn) {
        if (dfs(dep)) { cyclePath.push(id); return true; }
      }
    }
    stack.delete(id);
    return false;
  };
  for (const task of tasks) {
    if (!visited.has(task.id)) {
      if (dfs(task.id)) {
        throw new Error(`Dependency cycle detected: ${[...cyclePath].reverse().join(" → ")}`);
      }
    }
  }
};

const filesOverlap = (a: string[], b: string[]): boolean =>
  a.some((f) => b.includes(f));

const conflictsWithBidirectional = (a: FabricTask, b: FabricTask): boolean =>
  a.conflictsWith.includes(b.id) || b.conflictsWith.includes(a.id);

export const orderWaves = (tasks: TaskDag): TaskWave[] => {
  const waves: TaskWave[] = [];
  const placed = new Set<string>();
  while (placed.size < tasks.length) {
    const wave: FabricTask[] = [];
    for (const task of tasks) {
      if (placed.has(task.id)) continue;
      const depsReady = task.dependsOn.every((dep) => placed.has(dep));
      if (!depsReady) continue;
      const conflicts = wave.some((w) =>
        conflictsWithBidirectional(task, w) || filesOverlap(task.files, w.files));
      if (!conflicts) {
        wave.push(task);
      }
    }
    if (wave.length === 0) {
      const stuck = tasks.filter((t) => !placed.has(t.id)).map((t) => t.id);
      throw new Error(`Unable to place tasks (possible missing dependency): ${stuck.join(", ")}`);
    }
    for (const task of wave) placed.add(task.id);
    waves.push(wave);
  }
  return waves;
};

export const selectNextWave = (
  tasks: TaskDag,
  completed: string[],
): TaskWave | undefined => {
  const waves = orderWaves(tasks);
  const done = new Set(completed);
  for (const wave of waves) {
    if (!wave.every((task) => done.has(task.id))) {
      return wave.filter((task) => !done.has(task.id));
    }
  }
  return undefined;
};