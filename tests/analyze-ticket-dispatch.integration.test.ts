import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";
import { analyzeTicket, type AnalyzeTicketResult } from "../src/search/analyze-ticket.ts";

/**
 * `analyzeTicket` bundles each candidate with the callers that reach it by dispatch,
 * not only its direct callers. The fixture has no embeddings, so the ticket text selects
 * the candidates by name/FTS alone; hybridSearch still loads the embedding model for the
 * query, so the one analyzeTicket call runs in beforeAll with a cold-start timeout.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/analyze-ticket-dispatch.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

const P = "no.nav.at";

describe.skipIf(!RUN)("analyzeTicket callers include dispatched callers", () => {
  let repo: FixtureRepo;
  let result: AnalyzeTicketResult;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/no/nav/at/Frobber.java": `package ${P};

public interface Frobber {
    String frobnicate(String x);
}
`,
      "src/main/java/no/nav/at/FrobberImpl.java": `package ${P};

public class FrobberImpl implements Frobber {
    @Override
    public String frobnicate(String x) { return x; }
}
`,
      "src/main/java/no/nav/at/Client.java": `package ${P};

public class Client {
    private final Frobber frobber;

    public Client(Frobber frobber) { this.frobber = frobber; }

    public String use(String x) { return frobber.frobnicate(x); }
}
`,
    }, ["java"]);
    result = await analyzeTicket("frobnicate", { repo: repo.name, topK: 5, maxDepth: 2 });
  }, 60_000);

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("the implementation's bundle lists the interface caller with via = the interface method", () => {
    const impl = result.symbols.find((s) => s.target.qualified_name === `${P}.FrobberImpl.frobnicate`);
    expect(impl).toBeDefined();
    const callers = impl!.callers.map((c) => `${c.qualified_name}|${c.via ?? null}`);
    expect(callers).toEqual([`${P}.Client.use|${P}.Frobber.frobnicate`]);
  });

  test("the interface method's bundle lists the same caller directly, without via", () => {
    const iface = result.symbols.find((s) => s.target.qualified_name === `${P}.Frobber.frobnicate`);
    expect(iface).toBeDefined();
    const callers = iface!.callers.map((c) => `${c.qualified_name}|${c.via ?? null}`);
    expect(callers).toEqual([`${P}.Client.use|null`]);
  });
});
