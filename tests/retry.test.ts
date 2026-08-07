import { describe, expect, it, vi } from "vitest";
import {
  admissionBusyRetryAfterSeconds,
  isAdmissionBusyError,
  retryWithBackoff,
} from "../src/retry.js";

const options = {
  maxAttempts: 4,
  baseDelayMs: 100,
  maxDelayMs: 250,
  jitterMs: 50,
};

describe("retryWithBackoff", () => {
  it("returns first-attempt success without sleeping", async () => {
    const operation = vi.fn().mockResolvedValue("ok");
    const sleep = vi.fn();

    await expect(
      retryWithBackoff(operation, options, { sleep, random: () => 0.5 }),
    ).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("uses capped exponential delay plus deterministic jitter", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("one"))
      .mockRejectedValueOnce(new Error("two"))
      .mockRejectedValueOnce(new Error("three"))
      .mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryWithBackoff(operation, options, { sleep, random: () => 0.5 }),
    ).resolves.toBe("ok");
    expect(sleep.mock.calls).toEqual([[125], [225], [275]]);
  });

  it("stops immediately when the caller classifies an error as terminal", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("terminal"));
    const sleep = vi.fn();

    await expect(
      retryWithBackoff(
        operation,
        { ...options, shouldRetry: () => false },
        { sleep, random: () => 0 },
      ),
    ).rejects.toThrow("terminal");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("classifies chat_admission_busy as a transient admission error", () => {
    const busy = new Error(
      '503: {"error":{"code":"chat_admission_busy","message":"Chat admission capacity is temporarily unavailable. Retry shortly."}}',
    );
    expect(isAdmissionBusyError(busy)).toBe(true);
    expect(isAdmissionBusyError("HTTP 503 chat_admission_busy")).toBe(true);
    expect(isAdmissionBusyError(new Error("401 invalid api key"))).toBe(false);
    expect(isAdmissionBusyError(undefined)).toBe(false);
    expect(admissionBusyRetryAfterSeconds(busy)).toBe(2);
    expect(admissionBusyRetryAfterSeconds(new Error("model_not_found"))).toBeUndefined();
  });

  it("honors Retry-After seconds over the exponential schedule", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("busy"))
      .mockRejectedValueOnce(new Error("still busy"))
      .mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryWithBackoff(
        operation,
        {
          maxAttempts: 3,
          baseDelayMs: 100,
          maxDelayMs: 5000,
          jitterMs: 100,
          retryAfterSeconds: (error, attempt) => (attempt === 1 ? 2 : undefined),
        },
        { sleep, random: () => 0.5 },
      ),
    ).resolves.toBe("ok");
    expect(sleep.mock.calls).toEqual([[2000], [250]]);
  });

  it("bounds Retry-After by the configured max delay", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryWithBackoff(
        operation,
        {
          maxAttempts: 2,
          baseDelayMs: 100,
          maxDelayMs: 1500,
          jitterMs: 50,
          retryAfterSeconds: () => 10,
        },
        { sleep, random: () => 0 },
      ),
    ).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it("ignores invalid Retry-After values and stays on the exponential schedule", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryWithBackoff(
        operation,
        {
          maxAttempts: 2,
          baseDelayMs: 100,
          maxDelayMs: 5000,
          jitterMs: 50,
          retryAfterSeconds: () => Number.NaN,
        },
        { sleep, random: () => 0.5 },
      ),
    ).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledWith(125);
  });

  it("throws the final error after the attempt budget", async () => {
    const errors = [new Error("one"), new Error("two"), new Error("final")];
    const operation = vi.fn(async (attempt: number) => {
      throw errors[attempt - 1];
    });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryWithBackoff(
        operation,
        { ...options, maxAttempts: 3 },
        { sleep, random: () => 0 },
      ),
    ).rejects.toThrow("final");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
