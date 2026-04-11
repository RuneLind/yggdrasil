import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

const MODEL = "Xenova/all-MiniLM-L6-v2";
let extractor: FeatureExtractionPipeline | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", MODEL, {
      quantized: true,
    });
  }
  return extractor;
}

/** Generate a 384-dim embedding for the given text. Returns null on failure. */
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
