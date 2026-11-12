import { assert, it } from "@effect/vitest";
import { assertMigrationCompatibility } from "./migrationCompatibility.ts";

it("rejects newer or renamed V2 migrations before an older binary can approve rollback", () => {
  assert.throws(
    () => assertMigrationCompatibility([{ migration_id: 66, name: "Future" }], [[65, "Known"]]),
    /Incompatible/,
  );
  assert.throws(
    () => assertMigrationCompatibility([{ migration_id: 65, name: "Different" }], [[65, "Known"]]),
    /Incompatible/,
  );
  assert.doesNotThrow(() =>
    assertMigrationCompatibility([{ migration_id: 65, name: "Known" }], [[65, "Known"]]),
  );
  assert.doesNotThrow(() =>
    assertMigrationCompatibility([{ migration_id: 30, name: "SiteLocalV1" }], [[65, "Known"]]),
  );
});
