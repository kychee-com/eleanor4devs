import { describe, it, expectTypeOf } from "vitest";
import type { ProviderBox, ProviderCapabilities } from "../src/index.js";

/**
 * DD-24 — capability descriptors so Eleanor Core stays agent-agnostic.
 *
 * Every Provider Box exposes a `capabilities(): ProviderCapabilities`
 * introspection method returning a typed record. Eleanor Core branches on
 * these flags at orchestration-layer decision points instead of scattering
 * `if provider == "..."` through Core.
 */

describe("ProviderCapabilities descriptor (DD-24)", () => {
  it("declares can_dispatch as boolean", () => {
    expectTypeOf<ProviderCapabilities>().toHaveProperty("can_dispatch");
    expectTypeOf<ProviderCapabilities["can_dispatch"]>().toEqualTypeOf<boolean>();
  });

  it("declares inject_mechanism as 'native' | 'user_mediated'", () => {
    expectTypeOf<ProviderCapabilities>().toHaveProperty("inject_mechanism");
    expectTypeOf<
      ProviderCapabilities["inject_mechanism"]
    >().toEqualTypeOf<"native" | "user_mediated">();
  });

  it("declares can_observe_streaming as boolean", () => {
    expectTypeOf<ProviderCapabilities>().toHaveProperty(
      "can_observe_streaming",
    );
    expectTypeOf<
      ProviderCapabilities["can_observe_streaming"]
    >().toEqualTypeOf<boolean>();
  });

  it("declares session_lifetime as 'process' | 'container'", () => {
    expectTypeOf<ProviderCapabilities>().toHaveProperty("session_lifetime");
    expectTypeOf<
      ProviderCapabilities["session_lifetime"]
    >().toEqualTypeOf<"process" | "container">();
  });

  it("declares can_write_session_name as boolean", () => {
    expectTypeOf<ProviderCapabilities>().toHaveProperty(
      "can_write_session_name",
    );
    expectTypeOf<
      ProviderCapabilities["can_write_session_name"]
    >().toEqualTypeOf<boolean>();
  });
});

describe("ProviderBox.capabilities() (DD-24)", () => {
  it("ProviderBox has a capabilities() method", () => {
    expectTypeOf<ProviderBox>().toHaveProperty("capabilities");
  });

  it("capabilities() takes no arguments and returns ProviderCapabilities synchronously", () => {
    expectTypeOf<ProviderBox["capabilities"]>().parameters.toEqualTypeOf<[]>();
    expectTypeOf<
      ProviderBox["capabilities"]
    >().returns.toEqualTypeOf<ProviderCapabilities>();
  });
});
