import { describe, expect, it } from 'vitest';

import {
  CommunityPriorityQueue,
  computePriorityScore,
  DEFAULT_PRIORITY_WEIGHTS,
} from '../../src/summarization/priority-queue.js';

describe('CommunityPriorityQueue', () => {
  it('pops entries in descending score order', () => {
    const q = new CommunityPriorityQueue();
    for (const entry of [
      { communityId: 1, repo: 'r', score: 0.5 },
      { communityId: 2, repo: 'r', score: 1.2 },
      { communityId: 3, repo: 'r', score: 0.8 },
    ]) q.push(entry);

    expect(q.pop()?.communityId).toBe(2); // highest
    expect(q.pop()?.communityId).toBe(3);
    expect(q.pop()?.communityId).toBe(1);
    expect(q.pop()).toBeUndefined();
  });

  it('size reflects current entry count', () => {
    const q = new CommunityPriorityQueue();
    expect(q.size).toBe(0);
    q.push({ communityId: 1, repo: 'r', score: 1 });
    expect(q.size).toBe(1);
    q.pop();
    expect(q.size).toBe(0);
  });

  it('isEmpty returns true when empty', () => {
    const q = new CommunityPriorityQueue();
    expect(q.isEmpty()).toBe(true);
    q.push({ communityId: 1, repo: 'r', score: 1 });
    expect(q.isEmpty()).toBe(false);
  });

  it('peek does not remove the entry', () => {
    const q = new CommunityPriorityQueue();
    q.push({ communityId: 1, repo: 'r', score: 1 });
    q.peek();
    expect(q.size).toBe(1);
  });
});

describe('computePriorityScore', () => {
  it('uses default weights from spec', () => {
    const score = computePriorityScore(
      {
        avgPageRank: 1,
        avgFanIn: 0,
        publicApiFraction: 0,
        avgChangeFrequency: 0,
        canonicalFraction: 0,
      },
      DEFAULT_PRIORITY_WEIGHTS,
    );
    expect(score).toBeCloseTo(0.4);
  });

  it('penalises communities already covered', () => {
    const uncovered = computePriorityScore(
      { avgPageRank: 0.5, avgFanIn: 0.5, publicApiFraction: 0.5, avgChangeFrequency: 0.5, canonicalFraction: 0 },
      DEFAULT_PRIORITY_WEIGHTS,
    );
    const covered = computePriorityScore(
      { avgPageRank: 0.5, avgFanIn: 0.5, publicApiFraction: 0.5, avgChangeFrequency: 0.5, canonicalFraction: 1 },
      DEFAULT_PRIORITY_WEIGHTS,
    );
    expect(uncovered).toBeGreaterThan(covered);
  });

  it('respects custom weights', () => {
    const score = computePriorityScore(
      { avgPageRank: 1, avgFanIn: 0, publicApiFraction: 0, avgChangeFrequency: 0, canonicalFraction: 0 },
      { pageRank: 1, fanIn: 0, publicApi: 0, changeFrequency: 0, canonicalPenalty: 0 },
    );
    expect(score).toBeCloseTo(1);
  });
});
