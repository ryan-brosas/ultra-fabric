export interface RetryBackoffOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  // Seconds to wait before the next attempt. Takes precedence over the
  // exponential schedule when present and finite, so an upstream Retry-After
  // header or documented recovery window is honored instead of guessed.
  retryAfterSeconds?: (error: unknown, attempt: number) => number | undefined;
}

export interface RetryBackoffDependencies {
  sleep: (delayMs: number) => Promise<void>;
  random: () => number;
}

const defaultDependencies: RetryBackoffDependencies = {
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  random: Math.random,
};

// Gateway-side transient chat admission rejection. The omniroute gateway
// returns 503 chat_admission_busy when the single heavy-request lease is held
// and asks the client to retry shortly (Retry-After: 2 byte-level, 1
// structural). Matching on the stable code keeps auth, capability, budget, and
// permanent provider failures out of the retry class.
export const ADMISSION_BUSY_PATTERN = /\bchat_admission_busy\b/i;

const errorText = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const record = error as { message?: unknown; error?: unknown };
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
  }
  return "";
};

export const isAdmissionBusyError = (error: unknown): boolean =>
  ADMISSION_BUSY_PATTERN.test(errorText(error));

// Documented recovery window for a chat_admission_busy rejection when no
// Retry-After header reached the caller: the gateway's byte-level guidance.
export const ADMISSION_BUSY_RETRY_AFTER_SECONDS = 2;

export const admissionBusyRetryAfterSeconds = (
  error: unknown,
): number | undefined =>
  isAdmissionBusyError(error) ? ADMISSION_BUSY_RETRY_AFTER_SECONDS : undefined;

export const retryWithBackoff = async <Value>(
  operation: (attempt: number) => Promise<Value>,
  options: RetryBackoffOptions,
  dependencies: RetryBackoffDependencies = defaultDependencies,
): Promise<Value> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (options.shouldRetry && !options.shouldRetry(error, attempt)) throw error;
      if (attempt >= options.maxAttempts) break;
      const retryAfter = options.retryAfterSeconds?.(error, attempt);
      let delayMs: number;
      if (retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0) {
        delayMs = Math.min(retryAfter * 1000, options.maxDelayMs);
      } else {
        const exponential = Math.min(
          options.baseDelayMs * 2 ** (attempt - 1),
          options.maxDelayMs,
        );
        delayMs = exponential + dependencies.random() * options.jitterMs;
      }
      await dependencies.sleep(delayMs);
    }
  }
  throw lastError;
};
