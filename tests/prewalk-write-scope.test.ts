import { describe, expect, it } from "vitest";
import { PrewalkController } from "../src/prewalk/controller.js";

describe("PrewalkController write scope", () => {
  const setup = () => {
    const ctrl = new PrewalkController();
    ctrl.arm({
      model: "test/model",
      sessionId: "s1",
      alwaysRearm: false,
    });
    // Accept a checklist so authorize does not throw on the missing-checklist guard.
    const boundary = ctrl.executionBoundary("s1")!;
    boundary.registerChecklist({
      items: [
        { task: "do thing", validation: "check it" },
        { task: "do other", validation: "check that" },
        { task: "do more", validation: "check more" },
        { task: "do last", validation: "check last" },
        { task: "do final", validation: "check final" },
      ],
    });
    return { ctrl, boundary };
  };

  it("authorizes an in-scope workspace mutation", () => {
    const { ctrl, boundary } = setup();
    ctrl.setWriteScope("s1", ["src/config.ts"]);
    expect(boundary.authorize({ ref: "pi.edit", effect: "workspace", path: "src/config.ts" })).toBe(true);
  });

  it("rejects an out-of-scope workspace mutation naming the path", () => {
    const { ctrl, boundary } = setup();
    ctrl.setWriteScope("s1", ["src/config.ts"]);
    expect(() =>
      boundary.authorize({ ref: "pi.edit", effect: "workspace", path: "src/other.ts" }),
    ).toThrow(/out-of-scope|outside the current wave/);
  });

  it("stays permissive when no scope is set", () => {
    const { boundary } = setup();
    expect(boundary.authorize({ ref: "pi.edit", effect: "workspace", path: "src/anywhere.ts" })).toBe(true);
  });

  it("stays permissive when the scope is empty", () => {
    const { ctrl, boundary } = setup();
    ctrl.setWriteScope("s1", []);
    expect(boundary.authorize({ ref: "pi.edit", effect: "workspace", path: "src/anywhere.ts" })).toBe(true);
  });

  it("releases the scope on settleTask so a later write is authorized again", () => {
    const { ctrl, boundary } = setup();
    ctrl.setWriteScope("s1", ["src/config.ts"]);
    expect(() =>
      boundary.authorize({ ref: "pi.edit", effect: "workspace", path: "src/other.ts" }),
    ).toThrow();
    ctrl.settleTask("s1");
    // Re-arm for the next wave so the boundary is available again.
    ctrl.arm({ model: "test/model", sessionId: "s1", alwaysRearm: false });
    const boundary2 = ctrl.executionBoundary("s1")!;
    boundary2.registerChecklist({
      items: [
        { task: "a", validation: "b" },
        { task: "c", validation: "d" },
        { task: "e", validation: "f" },
        { task: "g", validation: "h" },
        { task: "i", validation: "j" },
      ],
    });
    // No scope set after settle — should be permissive.
    expect(boundary2.authorize({ ref: "pi.edit", effect: "workspace", path: "src/other.ts" })).toBe(true);
  });
});