import { describe, expect, it, vi } from "vitest";
import { retryWithBackoff } from "../src/retry.js";

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
