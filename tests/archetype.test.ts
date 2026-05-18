import { describe, test, expect } from "bun:test";
import {
  classifyArchetype,
  filterByArchetypeExclude,
  tagWithArchetype,
  type Archetype,
} from "../src/search/archetype.ts";

/** Shorthand for the most common case: classify by file_path + name (qualified_name + kind defaulted). */
function classify(
  filePath: string,
  name: string,
  opts?: { qualifiedName?: string; kind?: string },
): Archetype {
  return classifyArchetype({
    name,
    qualified_name: opts?.qualifiedName ?? `no.nav.melosys.${name}`,
    file_path: filePath,
    kind: opts?.kind ?? "class",
  });
}

describe("classifyArchetype", () => {
  describe("test detection (highest priority)", () => {
    test("file under /test/ → test even if name suggests service", () => {
      expect(classify("src/test/java/no/nav/TodoService.java", "TodoService")).toBe("test");
    });

    test("file under /tests/ → test", () => {
      expect(classify("src/tests/Foo.kt", "Foo")).toBe("test");
    });

    test("file under /__tests__/ (TS convention) → test", () => {
      expect(classify("src/__tests__/foo.ts", "foo", { kind: "function" })).toBe("test");
    });

    test("name ends with Test → test", () => {
      expect(classify("src/main/java/BehandlingTest.java", "BehandlingTest")).toBe("test");
    });

    test("name ends with IT (integration test) → test", () => {
      expect(classify("src/main/java/BehandlingIT.java", "BehandlingIT")).toBe("test");
    });

    test("name ends with TestBuilder (test fixture) → test, not builder", () => {
      expect(classify("src/main/java/BehandlingTestBuilder.java", "BehandlingTestBuilder")).toBe("test");
    });
  });

  describe("name suffix rules", () => {
    test("ends with Controller → controller", () => {
      expect(classify("src/main/java/api/BehandlingController.java", "BehandlingController")).toBe("controller");
    });

    test("ends with Resource (JAX-RS) → controller", () => {
      expect(classify("src/main/java/BehandlingResource.java", "BehandlingResource")).toBe("controller");
    });

    test("ends with Service → service", () => {
      expect(classify("src/main/java/BehandlingService.java", "BehandlingService")).toBe("service");
    });

    test("ends with Mapper (MapStruct) → mapper", () => {
      expect(classify("src/main/java/BehandlingMapper.java", "BehandlingMapper")).toBe("mapper");
    });

    test("ends with Repository → repository", () => {
      expect(classify("src/main/java/BehandlingRepository.java", "BehandlingRepository")).toBe("repository");
    });

    test("ends with Dto → dto", () => {
      expect(classify("src/main/java/BehandlingDto.java", "BehandlingDto")).toBe("dto");
    });

    test("ends with Request → dto (REST request body)", () => {
      expect(classify("src/main/java/OpprettBehandlingRequest.java", "OpprettBehandlingRequest")).toBe("dto");
    });

    test("ends with Configuration → config", () => {
      expect(classify("src/main/java/SecurityConfiguration.java", "SecurityConfiguration")).toBe("config");
    });

    test("ends with Utils → util", () => {
      expect(classify("src/main/java/DateUtils.java", "DateUtils")).toBe("util");
    });

    test("ends with Exception → exception", () => {
      expect(classify("src/main/java/MelosysException.java", "MelosysException")).toBe("exception");
    });

    test("plain Builder (not TestBuilder) → builder", () => {
      expect(classify("src/main/java/QueryBuilder.java", "QueryBuilder")).toBe("builder");
    });
  });

  describe("path-based fallback when name has no suffix", () => {
    test("entity in /domain/ → entity", () => {
      expect(classify("src/main/java/no/nav/melosys/domain/Behandling.java", "Behandling")).toBe("entity");
    });

    test("naked class in /dto/ → dto", () => {
      expect(classify("src/main/java/no/nav/melosys/api/dto/Person.java", "Person")).toBe("dto");
    });

    test("naked class in /controller/ → controller", () => {
      expect(classify("src/main/java/controller/Onboarding.java", "Onboarding")).toBe("controller");
    });

    test("naked class in /service/ → service", () => {
      expect(classify("src/main/java/service/Onboarding.java", "Onboarding")).toBe("service");
    });
  });

  describe("methods/properties inherit from containing class via file_path", () => {
    test("method on Service class → service", () => {
      expect(
        classify("src/main/java/BehandlingService.java", "save", {
          qualifiedName: "no.nav.melosys.BehandlingService.save",
          kind: "method",
        }),
      ).toBe("service");
    });

    test("method on TestBuilder → test", () => {
      expect(
        classify("src/main/java/BehandlingTestBuilder.java", "build", {
          qualifiedName: "no.nav.BehandlingTestBuilder.build",
          kind: "method",
        }),
      ).toBe("test");
    });

    test("property on Dto → dto", () => {
      expect(
        classify("src/main/java/BehandlingDto.java", "id", {
          qualifiedName: "no.nav.BehandlingDto.id",
          kind: "property",
        }),
      ).toBe("dto");
    });
  });

  describe("multi-decl files: prefer symbol name over file basename", () => {
    test("Repository class in file named Service.kt → repository (not service)", () => {
      // Kotlin allows multiple top-level classes per file. Regression: a Repository class
      // living in a file with /service/ in the path used to fall through to service.
      expect(
        classifyArchetype({
          name: "SakerForÅrsavregningRepository",
          qualified_name: "no.nav.melosys.service.ftrl.SakerForÅrsavregningRepository",
          file_path: "src/main/kotlin/no/nav/melosys/service/ftrl/FtrlServices.kt",
          kind: "class",
        }),
      ).toBe("repository");
    });

    test("method on Repository class with multi-decl file → repository", () => {
      expect(
        classifyArchetype({
          name: "findById",
          qualified_name: "no.nav.melosys.repo.BehandlingRepository.findById",
          file_path: "src/main/kotlin/no/nav/melosys/Storage.kt",
          kind: "method",
        }),
      ).toBe("repository");
    });
  });

  describe("fallback to other", () => {
    test("plain class with no signal → other", () => {
      expect(classify("src/main/java/no/nav/melosys/Foo.java", "Foo")).toBe("other");
    });
  });
});

describe("tagWithArchetype", () => {
  test("preserves original fields and adds archetype", () => {
    const tagged = tagWithArchetype([
      {
        name: "BehandlingService",
        qualified_name: "no.nav.melosys.BehandlingService",
        file_path: "src/main/java/BehandlingService.java",
        kind: "class",
        depth: 1,
      },
    ]);
    expect(tagged[0]).toMatchObject({
      name: "BehandlingService",
      depth: 1,
      archetype: "service",
    });
  });
});

describe("filterByArchetypeExclude", () => {
  const entries = [
    { id: "a", archetype: "service" as Archetype },
    { id: "b", archetype: "test" as Archetype },
    { id: "c", archetype: "controller" as Archetype },
    { id: "d", archetype: "mapper" as Archetype },
  ];

  test("undefined exclude → unchanged", () => {
    expect(filterByArchetypeExclude(entries, undefined).map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
  });

  test("empty exclude → unchanged", () => {
    expect(filterByArchetypeExclude(entries, []).map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
  });

  test("exclude test and controller → only service and mapper", () => {
    expect(filterByArchetypeExclude(entries, ["test", "controller"]).map((e) => e.id)).toEqual(["a", "d"]);
  });
});
