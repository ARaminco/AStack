/**
 * Embeddings through a local Ollama server (`POST /api/embed`).
 *
 * The default model is bge-m3, a multilingual model that handles Persian.
 * Nothing here is required: when Ollama or the model is missing, `available()`
 * says so and search stays lexical. Tests inject a fake embedder with the
 * same two methods.
 */
export class OllamaEmbedder {
  constructor({ url = "http://127.0.0.1:11434", model = "bge-m3", timeoutMs = 60000, batchSize = 16, maxChars = 2000 } = {}) {
    this.url = String(url).replace(/\/+$/, "");
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.batchSize = batchSize;
    this.maxChars = maxChars;
    this.probe = null;
  }

  /** { ok, reason } — cached for the life of the process. */
  async available() {
    if (this.probe) {
      return this.probe;
    }
    try {
      const response = await fetch(this.url + "/api/tags", { signal: AbortSignal.timeout(2500) });
      if (!response.ok) {
        this.probe = { ok: false, reason: "ollama answered " + response.status };
        return this.probe;
      }
      const body = await response.json();
      const names = (body.models ?? []).flatMap((entry) => [entry.name, entry.model]).filter(Boolean);
      const wanted = this.model.includes(":") ? this.model : this.model + ":latest";
      const found = names.some((name) => name === this.model || name === wanted);
      this.probe = found ? { ok: true, reason: null } : { ok: false, reason: "model " + this.model + " is not pulled (ollama pull " + this.model + ")" };
    } catch (error) {
      this.probe = { ok: false, reason: "ollama is not reachable at " + this.url + " (" + (error?.name === "TimeoutError" ? "timeout" : error?.message ?? error) + ")" };
    }
    return this.probe;
  }

  async embed(texts) {
    const vectors = [];
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      const batch = texts.slice(offset, offset + this.batchSize).map((text) => String(text ?? "").slice(0, this.maxChars) || " ");
      const response = await fetch(this.url + "/api/embed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: batch, truncate: true }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!response.ok) {
        throw new Error("ollama /api/embed answered " + response.status + ": " + (await response.text()).slice(0, 200));
      }
      const body = await response.json();
      for (const vector of body.embeddings ?? []) {
        vectors.push(Float32Array.from(vector));
      }
    }
    if (vectors.length !== texts.length) {
      throw new Error("ollama returned " + vectors.length + " embeddings for " + texts.length + " inputs");
    }
    return vectors;
  }
}

export function cosine(a, b) {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    left += a[index] * a[index];
    right += b[index] * b[index];
  }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}

/**
 * Reciprocal rank fusion: each ranked list contributes 1 / (k + rank).
 * Returns [{ key, score, ranks }] sorted by fused score.
 */
export function reciprocalRankFusion(lists, { k = 60 } = {}) {
  const fused = new Map();
  lists.forEach((list, listIndex) => {
    list.forEach((key, position) => {
      const entry = fused.get(key) ?? { key, score: 0, ranks: [] };
      entry.score += 1 / (k + position + 1);
      entry.ranks[listIndex] = position + 1;
      fused.set(key, entry);
    });
  });
  return [...fused.values()].sort((a, b) => b.score - a.score);
}
