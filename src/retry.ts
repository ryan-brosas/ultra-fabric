export interface RetryBackoffOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export interface RetryBackoffDependencies {
  sleep: (delayMs: number) => Promise<void>;
  random: () => number;
}

const defaultDependencies: RetryBackoffDependencies = {
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  random: Math.random,
};

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
      const exponential = Math.min(
        options.baseDelayMs * 2 ** (attempt - 1),
        options.maxDelayMs,
      );
      const jitter = dependencies.random() * options.jitterMs;
      await dependencies.sleep(exponential + jitter);
    }
  }
  throw lastError;
};
