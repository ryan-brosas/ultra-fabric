import { describe, expect, it } from "vitest";
import { routeModel, type ModelRouteCandidate } from "../src/routing/model-router.js";

const model = (
  key: string,
  overrides: Partial<ModelRouteCandidate> = {},
): ModelRouteCandidate => ({
  key,
  available: true,
  authenticated: true,
  input: ["text"],
  reasoning: true,
  contextWindow: 100_000,
  maxTokens: 16_000,
  inputCost: 3,
  outputCost: 15,
  ...overrides,
});

describe("routeModel", () => {
  it("selects a capability-preserving fallback when the primary cannot satisfy input", () => {
    expect(routeModel({
      requestedModel: "p/text",
      fallbackModels: ["p/vision"],
      requirements: { input: ["text", "image"], minContextWindow: 80_000 },
      candidates: [
        model("p/text"),
        model("p/vision", { input: ["text", "image"] }),
      ],
      allowQualityDowngrade: false,
    })).toMatchObject({
      version: 1,
      requestedModel: "p/text",
      selectedModel: "p/vision",
      kind: "fallback",
      reason: "capability_mismatch",
      quality: "preserved",
      considered: [
        { model: "p/text", eligible: false, reasons: ["missing_input:image"] },
        { model: "p/vision", eligible: true, selected: true },
      ],
    });
  });

  it("blocks quality downgrade unless policy explicitly allows it", () => {
    const input = {
      requestedModel: "p/primary",
      fallbackModels: ["p/small"],
      requirements: { input: ["text"] as Array<"text" | "image"> },
      candidates: [
        model("p/primary", { authenticated: false, contextWindow: 200_000 }),
        model("p/small", { contextWindow: 100_000, maxTokens: 8_000 }),
      ],
    };
    expect(() => routeModel({ ...input, allowQualityDowngrade: false })).toThrow(
      "No eligible model route",
    );
    expect(routeModel({ ...input, allowQualityDowngrade: true })).toMatchObject({
      selectedModel: "p/small",
      quality: "downgraded",
      downgradeReasons: ["smaller_context", "smaller_output"],
      reason: "primary_unauthenticated",
    });
  });

  it("enforces reasoning, context, output, and cost as hard requirements", () => {
    expect(() => routeModel({
      requestedModel: "p/expensive",
      fallbackModels: [],
      requirements: {
        reasoning: true,
        minContextWindow: 200_000,
        minOutputTokens: 32_000,
        maxInputCost: 2,
        maxOutputCost: 10,
      },
      candidates: [model("p/expensive", { reasoning: false })],
      allowQualityDowngrade: true,
    })).toThrow(/reasoning_required.*context_below:200000.*output_below:32000.*input_cost_above:2.*output_cost_above:10/);
  });
});
