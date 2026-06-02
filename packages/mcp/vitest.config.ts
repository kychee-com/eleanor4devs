import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Types are checked by a standalone `tsc -p tsconfig.test.json --noEmit`
    // (the `typecheck` npm script), matching the rest of the Kychee ecosystem
    // (kysigned, run402-mcp). vitest runs the tests; tsc checks the types.
  },
});
