export interface WorkflowProgress {
  synced: boolean;
  evidenceCount: number;
  analyzed: boolean;
  responseGenerated: boolean;
  sellerApproved: boolean;
  submitted: boolean;
}

export interface WorkflowStep {
  label: string;
  complete: boolean;
}

export function getWorkflowSteps(progress: WorkflowProgress): WorkflowStep[] {
  return [
    { label: "Buyer raises a dispute", complete: true },
    { label: "Seller syncs the dispute", complete: progress.synced },
    {
      label: "Seller adds evidence",
      complete: progress.evidenceCount > 0
    },
    { label: "AI analyzes the evidence", complete: progress.analyzed },
    {
      label: "AI generates a response",
      complete: progress.responseGenerated
    },
    {
      label: "Seller reviews and approves",
      complete: progress.sellerApproved || progress.submitted
    },
    {
      label: "Evidence is submitted to PayPal",
      complete: progress.submitted
    }
  ];
}
