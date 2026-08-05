import { describe, expect, it } from "vitest";
import { phaseContract } from "../src/lifecycle/phase-contract.js";

describe("phaseContract", () => {
  const phases: Array<["research" | "create" | "plan" | "ship" | "verify" | "done", boolean]> = [
    ["research", true],
    ["create", true],
    ["plan", true],
    ["ship", true],
    ["verify", true],
    ["done", false],
  ];

  for (const [phase, shouldExist] of phases) {
    it(`returns ${shouldExist ? "non-empty text" : "undefined"} for ${phase}`, () => {
      const contract = phaseContract(phase);
      if (shouldExist) {
        expect(contract).toBeTruthy();
        expect(contract!.length).toBeLessThanOrEqual(1_200);
      } else {
        expect(contract).toBeUndefined();
      }
    });
  }

  it("names graph navigation tools in the ship contract", () => {
    const ship = phaseContract("ship");
    expect(ship).toContain("find_callers");
    expect(ship).toContain("find_importers");
    expect(ship).toContain("ultra-fabric");
    expect(ship).toContain("inspo");
    expect(ship).toContain("find_most_complex_functions");
  });
});