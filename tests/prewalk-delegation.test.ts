import { describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig } from "../src/config.js";
import type { FabricPrewalkChecklist } from "../src/prewalk/checklist.js";
import {
  PREWALK_DELEGATE_DISCIPLINE,
  checklistContinuationPrompt,
  prewalkArmedPrompt,
} from "../src/prewalk/handoff.js";

const checklist = (): FabricPrewalkChecklist => ({
  items: [
    { task: "Read the module", validation: "List every prompt surface" },
    { task: "Add the flag", validation: "Config parses it" },
    { task: "Thread it through", validation: "Arm carries it" },
    { task: "Inject the discipline", validation: "Prompts carry it when on" },
    { task: "Document it", validation: "Docs mention default" },
  ],
  readyAt: 0,
});

describe("prewalk delegateContext", () => {
  it("defaults on; only an explicit false disables it", () => {
    expect(DEFAULT_FABRIC_CONFIG.prewalk.delegateContext).toBe(true);
    expect(normalizeFabricConfig({}).prewalk.delegateContext).toBe(true);
    expect(normalizeFabricConfig({ prewalk: { delegateContext: true } }).prewalk.delegateContext).toBe(
      true,
    );
    expect(normalizeFabricConfig({ prewalk: { delegateContext: false } }).prewalk).not.toHaveProperty(
      "delegateContext",
    );
  });

  it("injects the plan-then-delegate discipline into the armed prompt only when enabled", () => {
    const off = prewalkArmedPrompt("anthropic/executor");
    const on = prewalkArmedPrompt("anthropic/executor", { delegateContext: true });

    expect(off).not.toContain(PREWALK_DELEGATE_DISCIPLINE);
    expect(on).toContain(PREWALK_DELEGATE_DISCIPLINE);
    // The discipline names real offload surfaces: a support role and consult.
    expect(on).toContain("scout");
    expect(on).toContain("consult.run");
    // It must never make delegation unconditional; zero agents stays the default.
    expect(on.toLowerCase()).not.toContain("must delegate");
  });

  it("injects the same discipline into the executor continuation prompt only when enabled", () => {
    const off = checklistContinuationPrompt(checklist());
    const on = checklistContinuationPrompt(checklist(), { delegateContext: true });

    expect(off).not.toContain(PREWALK_DELEGATE_DISCIPLINE);
    expect(on).toContain(PREWALK_DELEGATE_DISCIPLINE);
    expect(on).toContain("consult.run");
    // The executor keeps planning on Main's intent while owning implementation.
    expect(on).toContain("Main");
  });
});
