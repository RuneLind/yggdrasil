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

export async function generateEmbedding(
  text: string,
): Promise<number[] | null> {
  try {
    const ext = await getExtractor();
    const result = await ext(text, { pooling: "mean", normalize: true });
    return Array.from(result.data as Float32Array);
  } catch (e) {
    console.error("[yggdrasil] Embedding generation failed:", e);
    return null;
  }
}

export async function warmupEmbeddings(): Promise<void> {
  await getExtractor();
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
