import { describe, expect, it } from 'vitest';

import { cosine, decodeEmbedding, encodeEmbedding, slugify } from '../src/enrichment/dedup.js';

describe('slugify', () => {
  it('lowercases and kebab-cases', () => {
    expect(slugify('Fraud Detection')).toBe('fraud-detection');
  });

  it('strips punctuation', () => {
    expect(slugify('Rate Limiter, v2!')).toBe('rate-limiter-v2');
  });

  it('strips trailing plural "s" but preserves double-s', () => {
    expect(slugify('Orders')).toBe('order');
    expect(slugify('class')).toBe('class');
  });

  it('normalizes whitespace', () => {
    expect(slugify('  customer   onboarding  ')).toBe('customer-onboarding');
  });

  it('handles accented characters', () => {
    expect(slugify('Naïve Bayes')).toBe('naive-baye');
  });

  it('returns empty string for empty input', () => {
    expect(slugify('')).toBe('');
    expect(slugify('   ')).toBe('');
  });
});

describe('cosine', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = Float32Array.from([1, 2, 3]);
    expect(cosine(v, v)).toBeCloseTo(1, 5);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const a = Float32Array.from([1, 0, 0]);
    const b = Float32Array.from([0, 1, 0]);
    expect(cosine(a, b)).toBeCloseTo(0, 5);
  });

  it('returns 0 for different-length vectors', () => {
    expect(cosine(Float32Array.from([1, 2]), Float32Array.from([1, 2, 3]))).toBe(0);
  });

  it('returns 0 for zero vectors', () => {
    const zero = new Float32Array(3);
    expect(cosine(zero, zero)).toBe(0);
  });
});

describe('embedding round-trip', () => {
  it('preserves Float32Array values through base64', () => {
    const original = Float32Array.from([0.1, -0.5, 2.3, 1e-6]);
    const roundTripped = decodeEmbedding(encodeEmbedding(original));
    expect(roundTripped.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(roundTripped[i]).toBeCloseTo(original[i]!, 6);
    }
  });
});
