/**
 * Concept deduplication primitives: slug normalization, cosine similarity,
 * and base64 <-> Float32Array conversion for embedding persistence.
 */

/**
 * Normalize a concept name into a stable slug. The same function is used
 * both as the JSON `id` and as the fast-path hash key during dedup, so
 * callers never observe a slug/key mismatch.
 */
export function slugify(name: string): string {
  const lowered = name.toLowerCase().trim();
  const ascii = lowered
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .replaceAll(/[^a-z0-9\s-]/g, '')
    .replaceAll(/\s+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '');

  // Strip trailing plural "s" (cars -> car) but preserve double-s (class).
  if (ascii.length > 2 && ascii.endsWith('s') && !ascii.endsWith('ss')) {
    return ascii.slice(0, -1);
  }
  return ascii;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [i, av] of a.entries()) {
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function encodeEmbedding(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}

export function decodeEmbedding(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  // Copy so we own an aligned buffer rather than a slice of a Node pool.
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(buf);
  return new Float32Array(copy);
}
