import type { RateLimitsConfig } from '../config.js';

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the next request will be accepted. 0 when allowed. */
  retryAfter: number;
}

interface Bucket {
  /** Per-minute bucket: tokens available. */
  minuteTokens: number;
  minuteResetAt: number;
  /** Per-hour bucket: tokens available. */
  hourTokens: number;
  hourResetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly config: RateLimitsConfig;

  constructor(config: RateLimitsConfig) {
    this.config = config;
  }

  check(tokenName: string): RateLimitResult {
    const limits = this.limitsFor(tokenName);
    const now = Date.now();
    const bucket = this.getOrCreate(tokenName, now, limits);

    if (bucket.minuteTokens <= 0) {
      return { allowed: false, retryAfter: Math.ceil((bucket.minuteResetAt - now) / 1000) };
    }
    if (bucket.hourTokens <= 0) {
      return { allowed: false, retryAfter: Math.ceil((bucket.hourResetAt - now) / 1000) };
    }

    bucket.minuteTokens--;
    bucket.hourTokens--;
    return { allowed: true, retryAfter: 0 };
  }

  private limitsFor(name: string) {
    const override = this.config.perToken.find((p) => p.name === name);
    return override ?? this.config.defaults;
  }

  private getOrCreate(
    name: string,
    now: number,
    limits: { requestsPerMinute: number; requestsPerHour: number },
  ): Bucket {
    let bucket = this.buckets.get(name);
    if (!bucket) {
      bucket = {
        minuteTokens: limits.requestsPerMinute,
        minuteResetAt: now + 60_000,
        hourTokens: limits.requestsPerHour,
        hourResetAt: now + 3_600_000,
      };
      this.buckets.set(name, bucket);
      return bucket;
    }

    if (now >= bucket.minuteResetAt) {
      bucket.minuteTokens = limits.requestsPerMinute;
      bucket.minuteResetAt = now + 60_000;
    }
    if (now >= bucket.hourResetAt) {
      bucket.hourTokens = limits.requestsPerHour;
      bucket.hourResetAt = now + 3_600_000;
    }
    return bucket;
  }
}
