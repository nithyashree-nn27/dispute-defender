import { describe, expect, it } from "vitest";
import { getWorkflowSteps } from "./workflow";

describe("dispute response workflow", () => {
  it("shows all seven stages in the required order", () => {
    const steps = getWorkflowSteps({
      synced: false,
      evidenceCount: 0,
      analyzed: false,
      responseGenerated: false,
      sellerApproved: false,
      submitted: false
    });

    expect(steps.map(step => step.label)).toEqual([
      "Buyer raises a dispute",
      "Seller syncs the dispute",
      "Seller adds evidence",
      "AI analyzes the evidence",
      "AI generates a response",
      "Seller reviews and approves",
      "Evidence is submitted to PayPal"
    ]);
    expect(steps.map(step => step.complete)).toEqual([
      true, false, false, false, false, false, false
    ]);
  });

  it("marks seller approval before submission and completion after submission", () => {
    const progress = {
      synced: true,
      evidenceCount: 1,
      analyzed: true,
      responseGenerated: true,
      sellerApproved: true,
      submitted: false
    };

    expect(getWorkflowSteps(progress).map(step => step.complete)).toEqual([
      true, true, true, true, true, true, false
    ]);
    expect(getWorkflowSteps({ ...progress, submitted: true }).map(
      step => step.complete
    )).toEqual([
      true, true, true, true, true, true, true
    ]);
  });
});
