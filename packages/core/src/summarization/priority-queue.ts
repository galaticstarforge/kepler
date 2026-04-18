/**
 * Simple max-heap priority queue for community processing order.
 *
 * Priority function (from agent-loop.md):
 *   priority = w1 * avg(pageRank)
 *            + w2 * avg(fanIn)
 *            + w3 * fraction(isPublicApi)
 *            + w4 * avg(changeFrequency)
 *            - w5 * fraction(canonical summaries)
 *
 * Default weights: w1=0.4, w2=0.3, w3=0.2, w4=0.1, w5=1.0.
 */

export interface PriorityWeights {
  pageRank: number;
  fanIn: number;
  publicApi: number;
  changeFrequency: number;
  canonicalPenalty: number;
}

export const DEFAULT_PRIORITY_WEIGHTS: PriorityWeights = {
  pageRank: 0.4,
  fanIn: 0.3,
  publicApi: 0.2,
  changeFrequency: 0.1,
  canonicalPenalty: 1,
};

export interface CommunityQueueEntry {
  communityId: number;
  repo: string;
  score: number;
}

/**
 * Max-heap implemented as a sorted array. Suitable for the hundreds-of-communities
 * scale typical of a codebase; not optimised for millions of entries.
 */
export class CommunityPriorityQueue {
  private heap: CommunityQueueEntry[] = [];

  get size(): number {
    return this.heap.length;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  push(entry: CommunityQueueEntry): void {
    this.heap.push(entry);
    this.bubbleUp(this.heap.length - 1);
  }

  /** Returns and removes the highest-priority community. */
  pop(): CommunityQueueEntry | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0]!;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  peek(): CommunityQueueEntry | undefined {
    return this.heap[0];
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent]!.score >= this.heap[i]!.score) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let largest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.heap[left]!.score > this.heap[largest]!.score) largest = left;
      if (right < n && this.heap[right]!.score > this.heap[largest]!.score) largest = right;
      if (largest === i) break;
      this.swap(i, largest);
      i = largest;
    }
  }

  private swap(a: number, b: number): void {
    const tmp = this.heap[a]!;
    this.heap[a] = this.heap[b]!;
    this.heap[b] = tmp;
  }
}

/** Compute priority score from pre-aggregated community metrics. */
export function computePriorityScore(
  metrics: {
    avgPageRank: number;
    avgFanIn: number;
    publicApiFraction: number;
    avgChangeFrequency: number;
    canonicalFraction: number;
  },
  weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS,
): number {
  return (
    weights.pageRank * metrics.avgPageRank +
    weights.fanIn * metrics.avgFanIn +
    weights.publicApi * metrics.publicApiFraction +
    weights.changeFrequency * metrics.avgChangeFrequency -
    weights.canonicalPenalty * metrics.canonicalFraction
  );
}
