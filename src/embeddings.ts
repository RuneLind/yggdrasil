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

/** Pre-load the embedding model. */
export async function warmupEmbeddings(): Promise<void> {
  await getExtractor();
}
