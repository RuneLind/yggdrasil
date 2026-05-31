import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

/**
 * Embedding model configuration.
 *
 * EMBEDDING_MODEL: HuggingFace model ID (must be ONNX-compatible via @xenova/transformers)
 * EMBEDDING_DIMS: vector dimensions (must match the model output and the DB column)
 *
 * Defaults to multilingual-e5-small (384 dims) which handles Norwegian identifiers
 * and mixed-language code. For English-only codebases, all-MiniLM-L6-v2 is faster.
 * For code-heavy search, consider jinaai/jina-embeddings-v2-base-code.
 */
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "Xenova/multilingual-e5-small";
export const EMBEDDING_DIMS = parseInt(process.env.EMBEDDING_DIMS ?? "384", 10);

let extractor: FeatureExtractionPipeline | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, {
      quantized: true,
    });
  }
  return extractor;
}

/**
 * Guard the dimension contract: the DB column is a fixed-width pgvector, so a vector
 * of the wrong length must never be written. Returns null (treated as a failure) on
 * mismatch instead of letting a wrong-width vector reach the DB.
 */
export function validateEmbedding(vec: number[] | null): number[] | null {
  if (!vec) return null;
  if (vec.length !== EMBEDDING_DIMS) {
    console.error(
      `[yggdrasil] Embedding dim mismatch: model produced ${vec.length}, expected ${EMBEDDING_DIMS}. ` +
        `Check EMBEDDING_MODEL / EMBEDDING_DIMS and the ci_symbols.embedding column width.`,
    );
    return null;
  }
  return vec;
}

export async function generateEmbedding(
  text: string,
): Promise<number[] | null> {
  try {
    const ext = await getExtractor();
    const result = await ext(text, { pooling: "mean", normalize: true });
    return validateEmbedding(Array.from(result.data as Float32Array));
  } catch (e) {
    console.error("[yggdrasil] Embedding generation failed:", e);
    return null;
  }
}

let dimsValidated = false;

export async function warmupEmbeddings(): Promise<void> {
  const ext = await getExtractor();
  // Fail fast on a model/config dimension mismatch — once per process. Without this,
  // EMBEDDING_DIMS is dead config: a model swap silently breaks every write (and pgvector
  // rejects them) with no signal beyond a per-symbol console.error. Memoized so repeated
  // embedSymbols calls don't re-run a probe inference.
  if (dimsValidated) return;
  const probe = await ext("warmup", { pooling: "mean", normalize: true });
  const dims = (probe.data as Float32Array).length;
  if (dims !== EMBEDDING_DIMS) {
    throw new Error(
      `[yggdrasil] Model ${EMBEDDING_MODEL} produces ${dims}-dim vectors but EMBEDDING_DIMS=${EMBEDDING_DIMS}. ` +
        `Set EMBEDDING_DIMS=${dims} (and a migration matching the ci_symbols.embedding column width), ` +
        `or choose a ${EMBEDDING_DIMS}-dim model.`,
    );
  }
  dimsValidated = true;
}

/** Build the text used for embedding a symbol — keeps embedding input consistent. */
export function symbolEmbeddingText(sym: {
  qualified_name: string;
  signature: string | null;
  doc_comment: string | null;
}): string {
  const parts = [sym.qualified_name];
  if (sym.signature) parts.push(sym.signature);
  if (sym.doc_comment) parts.push(sym.doc_comment);
  return parts.join(" ");
}
