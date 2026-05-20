import { describe, it, expectTypeOf } from "vitest";
import type {
  ProviderBox,
  DispatchInput,
  InjectInput,
  ThreadHandle,
  ThreadState,
  ThreadId,
  Unsubscribe,
  ProviderEvent,
} from "../src/index.js";

describe("ProviderBox contract (spec § Provider Boxes — 6 verbs)", () => {
  it("declares the 6 verbs with correct signatures", () => {
    expectTypeOf<ProviderBox>().toHaveProperty("dispatch");
    expectTypeOf<ProviderBox>().toHaveProperty("subscribe");
    expectTypeOf<ProviderBox>().toHaveProperty("inject");
    expectTypeOf<ProviderBox>().toHaveProperty("pause");
    expectTypeOf<ProviderBox>().toHaveProperty("resume");
    expectTypeOf<ProviderBox>().toHaveProperty("query");
  });

  it("dispatch takes DispatchInput and returns Promise<ThreadHandle>", () => {
    expectTypeOf<ProviderBox["dispatch"]>().parameters.toEqualTypeOf<
      [DispatchInput]
    >();
    expectTypeOf<ProviderBox["dispatch"]>().returns.toEqualTypeOf<
      Promise<ThreadHandle>
    >();
  });

  it("subscribe takes (ThreadId, handler) and returns Unsubscribe", () => {
    expectTypeOf<ProviderBox["subscribe"]>().parameters.toEqualTypeOf<
      [ThreadId, (event: ProviderEvent) => void]
    >();
    expectTypeOf<ProviderBox["subscribe"]>().returns.toEqualTypeOf<Unsubscribe>();
  });

  it("inject takes (ThreadId, InjectInput) and returns Promise<void>", () => {
    expectTypeOf<ProviderBox["inject"]>().parameters.toEqualTypeOf<
      [ThreadId, InjectInput]
    >();
    expectTypeOf<ProviderBox["inject"]>().returns.toEqualTypeOf<Promise<void>>();
  });

  it("pause takes ThreadId and returns Promise<void>", () => {
    expectTypeOf<ProviderBox["pause"]>().parameters.toEqualTypeOf<[ThreadId]>();
    expectTypeOf<ProviderBox["pause"]>().returns.toEqualTypeOf<Promise<void>>();
  });

  it("resume takes ThreadId and returns Promise<void>", () => {
    expectTypeOf<ProviderBox["resume"]>().parameters.toEqualTypeOf<[ThreadId]>();
    expectTypeOf<ProviderBox["resume"]>().returns.toEqualTypeOf<Promise<void>>();
  });

  it("query takes ThreadId and returns Promise<ThreadState>", () => {
    expectTypeOf<ProviderBox["query"]>().parameters.toEqualTypeOf<[ThreadId]>();
    expectTypeOf<ProviderBox["query"]>().returns.toEqualTypeOf<
      Promise<ThreadState>
    >();
  });
});
