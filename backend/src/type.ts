
export interface Evidence {
  id: number;
  disputeId: string;
  type: "tracking" | "note" | "invoice" | "message";
  text: string;
  carrier?: string;
  trackingNumber?: string;
  imageFilename?: string;
  imageMimeType?: string;
  createdAt: string;
}

export interface BuyerEvidence {
  type: string;
  details: string[];
  documents: Array<{
    index: number;
    name: string;
    downloadable: boolean;
  }>;
}

export interface Analysis {
  summary?: string;
  buyerClaims?: string[];
  sellerEvidenceAssessment?: string[];
  conflicts?: string[];
  recommendedActions?: string[];
  strength: number;
  missing: string[];
  draft: string;
  why: string;
}

export type RequestedEvidenceStatus =
  | "available"
  | "missing"
  | "needs_verification";

export interface RequestedEvidence {
  paypalEvidenceType: string;
  source: "REQUESTED_FROM_SELLER";
  notes?: string;
  internalEvidenceType?: Evidence["type"];
  status: RequestedEvidenceStatus;
  matchedEvidenceIds: number[];
  verificationRequired: boolean;
}

export interface Dispute {
  id: string;
  reason: string;
  status: string;
  amount: string;
  currency: string;
  createdAt?: string;
  updatedAt?: string;
  outcome?: string;
  dueDate?: string;
  lifecycleStage?: string;
  rawData: Record<string, unknown>;
  evidence: Evidence[];
  buyerEvidence?: BuyerEvidence[];
  analysis?: Analysis;
  requestedEvidence?: RequestedEvidence[];
  submittedAt?: string;
  submissionAttempt?: {
    mode: "seller" | "automation";
    status: "processing" | "submitted" | "needs_review";
    startedAt: string;
    finishedAt?: string;
    message?: string;
  };
}
