import { describe, it, expectTypeOf } from "vitest";

import type { paths } from "./generated/schema";

// Type-level, executable form of amendment A5: the generated client must expose
// BOTH the 200 and 503 responses of GET /health with the HealthResponse shape.
// Non-vacuous vs the drift test: deleting the 503 and dutifully regenerating
// leaves every drift check green — only this test (and tsc --noEmit) goes red,
// because the [503] index access below stops resolving.
type Health200 =
  paths["/health"]["get"]["responses"][200]["content"]["application/json"];
type Health503 =
  paths["/health"]["get"]["responses"][503]["content"]["application/json"];

type Shape = { status: "ok" | "degraded"; database: "ok" | "unavailable" };

describe("GET /health contract", () => {
  it("declares both 200 and 503 with the HealthResponse shape", () => {
    expectTypeOf<Health200>().toEqualTypeOf<Shape>();
    expectTypeOf<Health503>().toEqualTypeOf<Shape>();
  });
});
