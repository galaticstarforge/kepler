import { describe, expect, it, vi } from 'vitest';

import { ConceptExtractor } from '../src/enrichment/concept-extractor.js';
import type {
  CompletionResponse,
  EmbeddingResponse,
  LlmClient,
} from '../src/enrichment/llm/llm-client.js';

function stubLlm(completions: string[]): LlmClient {
  const queue = [...completions];
  return {
    complete(): Promise<CompletionResponse> {
      const next = queue.shift() ?? '{"concepts":[]}';
      return Promise.resolve({ text: next });
    },
    embed(): Promise<EmbeddingResponse> {
      return Promise.resolve({ vector: new Float32Array(4), model: 'stub' });
    },
  };
}

const LONG_DOC = `---
title: Demo
---

# Fraud Detection

${'Our fraud detection pipeline looks for suspicious transaction patterns. '.repeat(30)}

## Customer Onboarding

${'Customer onboarding covers KYC checks and risk scoring. '.repeat(30)}
`;

describe('ConceptExtractor', () => {
  it('returns extracted candidates when LLM responds with valid JSON', async () => {
    const llm = stubLlm([
      JSON.stringify({
        concepts: [
          { name: 'Fraud Detection', description: 'd', confidence: 0.9, evidenceSpan: 'e' },
        ],
      }),
      JSON.stringify({
        concepts: [{ name: 'Customer Onboarding', description: 'd', confidence: 0.8 }],
      }),
    ]);

    const out = await new ConceptExtractor(llm).extract('demo.md', LONG_DOC);
    expect(out.map((c) => c.name)).toContain('Fraud Detection');
    expect(out.map((c) => c.name)).toContain('Customer Onboarding');
  });

  it('tolerates malformed JSON and returns empty', async () => {
    const llm = stubLlm(['not json at all', 'still { broken', '{"concepts":[]}']);
    const out = await new ConceptExtractor(llm).extract('demo.md', LONG_DOC);
    expect(out).toEqual([]);
  });

  it('extracts JSON even when LLM wraps it in prose', async () => {
    const llm = stubLlm([
      'Here is the result:\n```json\n{"concepts":[{"name":"X","description":"y","confidence":0.7}]}\n```',
    ]);
    const out = await new ConceptExtractor(llm).extract('demo.md', LONG_DOC);
    expect(out[0]?.name).toBe('X');
  });

  it('skips chunks below MIN_CHUNK_WORDS', async () => {
    const completeSpy = vi.fn().mockResolvedValue({ text: '{"concepts":[]}' });
    const llm: LlmClient = {
      complete: completeSpy,
      embed: () => Promise.resolve({ vector: new Float32Array(4), model: 'stub' }),
    };

    await new ConceptExtractor(llm).extract('tiny.md', '# Short\n\nOnly a few words.');
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it('clamps confidence to [0,1]', async () => {
    const llm = stubLlm([
      JSON.stringify({
        concepts: [
          { name: 'High', description: '', confidence: 5 },
          { name: 'Low', description: '', confidence: -1 },
        ],
      }),
    ]);
    const out = await new ConceptExtractor(llm).extract('demo.md', LONG_DOC);
    const high = out.find((c) => c.name === 'High');
    const low = out.find((c) => c.name === 'Low');
    expect(high?.confidence).toBe(1);
    expect(low?.confidence).toBe(0);
  });
});
