/**
 * Tests for @eleanor4devs/sdk — the canonical TypeScript surface.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § npm package
 * (v0.7.0). The SDK is the typed entry point every consumer (CLI,
 * downstream Node app) imports. Tests live in the `core` validation
 * tier — no network, no real backend.
 *
 * Plan: docs/plans/eleanor4devs-plan.md Phase 7 Task 1.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import { Eleanor } from "../src/index.js";

describe("@eleanor4devs/sdk — named exports", () => {
  it("exposes the Eleanor entry-point as a named export resolvable from the package", () => {
    // The first sub-test of the SDK task. The criterion is:
    //   import { Eleanor } from "@eleanor4devs/sdk"
    // resolves in a fresh Node 20+ project. The import statement at
    // the top of this file IS the proof at the module-resolution
    // layer; this expectation is the runtime existence check.
    expect(Eleanor).toBeDefined();
    expectTypeOf(Eleanor).not.toBeNever();
  });
});

describe("@eleanor4devs/sdk — Core validation profile (no network)", () => {
  it("constructs in Core profile and exposes core-only state without invoking globalThis.fetch", () => {
    // The second sub-test of the SDK task: SDK Validation Profile Core
    // passes with no network access. We stub globalThis.fetch with a
    // spy that throws — if the SDK so much as touches the network in
    // Core mode, this test fails loudly. Mirrors the Python backend's
    // `core` pytest tier from Phase 4 Task 17.
    let fetchCalls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("Core profile must not make network calls");
    }) as typeof globalThis.fetch;
    try {
      const eleanor = new Eleanor({ validationProfile: "core" });
      expect(eleanor.validationProfile).toBe("core");
    } finally {
      globalThis.fetch = original;
    }
    expect(fetchCalls).toBe(0);
  });

  it("defaults to Core profile when no options are passed (safe-by-default pin)", () => {
    // Pinning: a consumer who constructs `new Eleanor()` with no
    // options must NOT accidentally end up in a network-enabled mode.
    // Default of `core` is the safe choice.
    const eleanor = new Eleanor();
    expect(eleanor.validationProfile).toBe("core");
  });

  it("accepts each documented ValidationProfile (type-level + runtime)", () => {
    // Pinning the type union. If the union expands or contracts in
    // the future this test surfaces it.
    expect(new Eleanor({ validationProfile: "core" }).validationProfile).toBe("core");
    expect(new Eleanor({ validationProfile: "extension" }).validationProfile).toBe("extension");
    expect(new Eleanor({ validationProfile: "real_integration" }).validationProfile).toBe("real_integration");
  });
});
