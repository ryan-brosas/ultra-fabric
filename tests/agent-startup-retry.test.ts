import { describe, expect, it } from "vitest";
import {
  retryablePiStartupError,
  startupRetryDelayMs,
} from "../src/agents/one-shot-manager.js";

const BUSY =
  '503: {"error":{"code":"chat_admission_busy","message":"Chat admission capacity is temporarily unavailable. Retry shortly."}}';

describe("one-shot startup retry classification", () => {
  it("treats chat_admission_busy as a retryable startup failure", () => {
    expect(retryablePiStartupError(BUSY)).toBe(true);
    expect(retryablePiStartupError("chat_admission_busy")).toBe(true);
  });

  it("keeps auth-classified startup failures retryable", () => {
    expect(retryablePiStartupError("Missing API key for provider")).toBe(true);
    expect(retryablePiStartupError("credentials not found for omniroute")).toBe(true);
  });

  it("does not retry permanent failures without the busy code", () => {
    expect(retryablePiStartupError("401 Unauthorized: invalid api key")).toBe(false);
    expect(retryablePiStartupError("400 model_not_found")).toBe(false);
    expect(retryablePiStartupError("502 bad gateway")).toBe(false);
    expect(retryablePiStartupError(undefined)).toBe(false);
  });

  it("uses the gateway Retry-After guidance for admission-busy and exponential otherwise", () => {
    expect(startupRetryDelayMs(BUSY, 1)).toBe(2000);
    expect(startupRetryDelayMs(BUSY, 2)).toBe(2000);
    expect(startupRetryDelayMs("Missing API key", 1)).toBe(500);
    expect(startupRetryDelayMs("Missing API key", 2)).toBe(1000);
  });
});
