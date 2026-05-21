/**
 * F-006 SDK sub-fix regression — `Eleanor` class must expose typed verb
 * methods (`report`, `status`, `subscribe`) so the IDE/type surface
 * matches the spec acceptance criterion ("typed entry points covering
 * all MCP verbs plus thread orchestration, status, and auth").
 *
 * The methods throw `NotImplementedError` with a clear "Phase 11"
 * message. The full wire implementation lands when the MCP wire
 * protocol is finalized; these stubs make T-161 testable now.
 *
 * Plan: Phase 15 F-006 SDK sub-fix.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  Eleanor,
  NotImplementedError,
  type ReportPayload,
  type ReportResult,
  type StatusResult,
  type EventHandler,
  type Unsubscribe,
  type ThreadId,
} from "../src/index.js";

describe("F-006 SDK — Eleanor verb stubs", () => {
  it("`new Eleanor().report` is a function (typed)", () => {
    const e = new Eleanor();
    expect(typeof e.report).toBe("function");
  });

  it("`new Eleanor().status` is a function (typed)", () => {
    const e = new Eleanor();
    expect(typeof e.status).toBe("function");
  });

  it("`new Eleanor().subscribe` is a function (typed)", () => {
    const e = new Eleanor();
    expect(typeof e.subscribe).toBe("function");
  });

  it("report({event: 'progress'}) rejects with NotImplementedError mentioning Phase 11", async () => {
    const e = new Eleanor();
    await expect(e.report({ event: "progress" })).rejects.toThrow(
      NotImplementedError,
    );
    await expect(e.report({ event: "progress" })).rejects.toThrow(/Phase 11/);
  });

  it("status() rejects with NotImplementedError mentioning Phase 11", async () => {
    const e = new Eleanor();
    await expect(e.status()).rejects.toThrow(NotImplementedError);
    await expect(e.status()).rejects.toThrow(/Phase 11/);
  });

  it("subscribe(...) throws NotImplementedError mentioning Phase 11", () => {
    const e = new Eleanor();
    expect(() =>
      e.subscribe("t_demo" as ThreadId, () => {
        /* noop */
      }),
    ).toThrow(NotImplementedError);
    expect(() =>
      e.subscribe("t_demo" as ThreadId, () => {
        /* noop */
      }),
    ).toThrow(/Phase 11/);
  });

  it("type signature of `report` accepts ReportPayload and returns Promise<ReportResult>", () => {
    // Type-level pin — locks the signature so a future refactor can't
    // silently widen the inputs or narrow the return.
    expectTypeOf<Eleanor["report"]>().parameter(0).toEqualTypeOf<ReportPayload>();
    expectTypeOf<Eleanor["report"]>().returns.toEqualTypeOf<Promise<ReportResult>>();
  });

  it("type signature of `status` returns Promise<StatusResult>", () => {
    expectTypeOf<Eleanor["status"]>().returns.toEqualTypeOf<Promise<StatusResult>>();
  });

  it("type signature of `subscribe(threadId, handler)` returns Unsubscribe", () => {
    expectTypeOf<Eleanor["subscribe"]>().parameters.toEqualTypeOf<
      [ThreadId, EventHandler]
    >();
    expectTypeOf<Eleanor["subscribe"]>().returns.toEqualTypeOf<Unsubscribe>();
  });
});
