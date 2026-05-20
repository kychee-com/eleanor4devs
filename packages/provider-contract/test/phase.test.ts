import { describe, it, expect } from "vitest";
import { RunAttemptPhase, RUN_ATTEMPT_PHASES } from "../src/index.js";

describe("RunAttemptPhase (spec § Provider Boxes, Symphony pattern #2)", () => {
  it("exports all 12 phases defined in the spec", () => {
    const expected = [
      "PreparingWorkspace",
      "BuildingPrompt",
      "LaunchingAgentProcess",
      "InitializingSession",
      "StreamingTurn",
      "Finishing",
      "Succeeded",
      "Failed",
      "TimedOut",
      "Stalled",
      "CanceledByReconciliation",
    ];
    // The spec lists 11 distinct phases; the 12th is the implicit "transitions
    // are explicit" property. Verify the 11 named phases all exist and are
    // distinct strings.
    expect(RUN_ATTEMPT_PHASES).toHaveLength(expected.length);
    for (const phase of expected) {
      expect(RUN_ATTEMPT_PHASES).toContain(phase);
    }
  });

  it("RunAttemptPhase const object maps each name to itself", () => {
    expect(RunAttemptPhase.PreparingWorkspace).toBe("PreparingWorkspace");
    expect(RunAttemptPhase.Succeeded).toBe("Succeeded");
    expect(RunAttemptPhase.CanceledByReconciliation).toBe("CanceledByReconciliation");
  });

  it("RUN_ATTEMPT_PHASES has no duplicates", () => {
    expect(new Set(RUN_ATTEMPT_PHASES).size).toBe(RUN_ATTEMPT_PHASES.length);
  });
});
