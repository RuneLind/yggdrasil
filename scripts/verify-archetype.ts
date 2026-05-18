import { analyzeImpact } from "../src/search/impact.ts";
import { closeDb } from "../src/db/connection.ts";

const target = process.argv[2] ?? "no.nav.melosys.domain.Behandling";
const repo = process.argv[3] ?? "melosys-api";
const maxDepth = parseInt(process.argv[4] ?? "2", 10);

const result = await analyzeImpact(target, { repo, maxDepth });
if (!result) {
  console.log("not found:", target);
  await closeDb();
  process.exit(1);
}

console.log(`target: ${result.symbol.qualified_name} (archetype: ${result.symbol.archetype})`);
console.log(`affected total: ${result.affected.length}`);
console.log("\narchetype distribution:");
for (const [k, v] of Object.entries(result.archetype_counts).sort((a, b) => (b[1] as number) - (a[1] as number))) {
  console.log(`  ${k.padEnd(12)} ${v}`);
}

console.log("\nsample by archetype (first 2 each):");
const seen = new Map<string, string[]>();
for (const e of result.affected) {
  const cur = seen.get(e.archetype) ?? [];
  if (cur.length < 2) {
    cur.push(`${e.qualified_name} (depth ${e.depth})`);
    seen.set(e.archetype, cur);
  }
}
for (const [k, v] of [...seen.entries()].sort()) {
  console.log(`  ${k}:`);
  for (const q of v) console.log(`    ${q}`);
}

console.log("\nfilter scenarios:");
const f1 = await analyzeImpact(target, { repo, maxDepth, archetypeExclude: ["test"] });
console.log(`  exclude=[test]: ${f1!.affected.length}`);

const f2 = await analyzeImpact(target, { repo, maxDepth, archetypeExclude: ["test", "controller", "builder", "other"] });
console.log(`  exclude=[test,controller,builder,other]: ${f2!.affected.length}`);

const f3 = await analyzeImpact(target, { repo, maxDepth, archetypeExclude: ["test", "controller", "builder"] });
console.log(`  exclude=[test,controller,builder]: ${f3!.affected.length}`);

await closeDb();
