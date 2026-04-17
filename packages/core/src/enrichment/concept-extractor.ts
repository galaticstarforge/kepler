import type { ExtractionCandidate } from '@kepler/shared';

import { parseFrontmatter } from '../docs/frontmatter-parser.js';
import { stripMarkdown } from '../docs/markdown-stripper.js';
import { createLogger } from '../logger.js';

import type { LlmClient } from './llm/llm-client.js';

const log = createLogger('concept-extractor');

const MIN_CHUNK_WORDS = 100;

const SYSTEM_PROMPT = `You are a concept-extraction assistant.
Given a fragment of internal documentation, identify named domain concepts
(e.g. "fraud detection", "customer onboarding", "rate limiter") that a
future reader might search for.

Return ONLY valid JSON matching this schema:
{ "concepts": [
    { "name": string,           // canonical display name, 1-5 words
      "description": string,    // one sentence, <= 200 chars
      "confidence": number,     // 0.0 to 1.0
      "evidenceSpan": string    // a short exact quote from the input
    }
] }

Extract 0-10 concepts. Skip generic terms ("system", "data", "user") unless
they are clearly a domain-specific named entity in context. Prefer nouns
and noun phrases over verbs.`;

export class ConceptExtractor {
  constructor(private readonly llm: LlmClient) {}

  /**
   * Extract concept candidates from one document. The document is chunked
   * by H1/H2 headings; each chunk is sent to the LLM individually.
   */
  async extract(docPath: string, markdown: string): Promise<ExtractionCandidate[]> {
    const body = stripFrontmatter(markdown);
    const chunks = chunkByHeadings(body);

    const results: ExtractionCandidate[] = [];
    for (const chunk of chunks) {
      if (wordCount(chunk) < MIN_CHUNK_WORDS) continue;
      const plain = stripMarkdown(chunk);
      if (wordCount(plain) < MIN_CHUNK_WORDS) continue;

      try {
        const resp = await this.llm.complete({
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: plain,
          jsonMode: true,
          maxTokens: 1500,
        });
        const parsed = parseResponse(resp.text);
        results.push(...parsed);
      } catch (error) {
        log.warn('extraction failed for chunk', { docPath, error: String(error) });
      }
    }

    return results;
  }
}

function stripFrontmatter(markdown: string): string {
  const parsed = parseFrontmatter(markdown);
  return parsed.body;
}

function chunkByHeadings(body: string): string[] {
  const lines = body.split('\n');
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{1,2}\s/.test(line) && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  // Collapse anything split into a single chunk when the doc has no headings.
  return chunks.length === 0 ? [body] : chunks;
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function parseResponse(raw: string): ExtractionCandidate[] {
  const jsonStr = extractJsonObject(raw);
  if (!jsonStr) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object') return [];
  const concepts = (parsed as { concepts?: unknown }).concepts;
  if (!Array.isArray(concepts)) return [];

  const out: ExtractionCandidate[] = [];
  for (const c of concepts) {
    if (!c || typeof c !== 'object') continue;
    const obj = c as Record<string, unknown>;
    const name = typeof obj['name'] === 'string' ? obj['name'] : undefined;
    const description = typeof obj['description'] === 'string' ? obj['description'] : '';
    const confidence =
      typeof obj['confidence'] === 'number' ? obj['confidence'] : 0.5;
    const evidenceSpan =
      typeof obj['evidenceSpan'] === 'string' ? obj['evidenceSpan'] : undefined;

    if (!name || name.trim().length === 0) continue;
    const candidate: ExtractionCandidate = {
      name: name.trim(),
      description: description.trim(),
      confidence: Math.max(0, Math.min(1, confidence)),
    };
    if (evidenceSpan) candidate.evidenceSpan = evidenceSpan;
    out.push(candidate);
  }
  return out;
}

/** Find the first JSON object in the LLM's output and return it as a string. */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    switch (ch) {
      case '"': {
        inString = true;
        break;
      }
      case '{': {
        depth++;
        break;
      }
      case '}': {
        depth--;
        if (depth === 0) return raw.slice(start, i + 1);
        break;
      }
      default: {
        break;
      }
    }
  }
  return null;
}
