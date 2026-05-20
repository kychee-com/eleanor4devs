import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    typecheck: {
      enabled: true,
      // Default Vitest typecheck only matches `*.test-d.ts`; we want regular
      // `*.test.ts` files to also be type-checked so `expectTypeOf` is real.
      include: ["test/**/*.test.ts", "test/**/*.test-d.ts"],
      tsconfig: "./tsconfig.test.json",
    },
  },
});
