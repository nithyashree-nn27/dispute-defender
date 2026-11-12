import type {
  BuyerEvidence,
  Dispute,
  Evidence,
  RequestedEvidence
} from "./type.js";

const PAYPAL_TO_INTERNAL_TYPE: Record<string, Evidence["type"]> = {
  PROOF_OF_FULFILLMENT: "tracking",
  PROOF_OF_DELIVERY: "tracking",
  TRACKING_NUMBER: "tracking",
  TRACKING: "tracking",
  SHIPPING_LABEL: "tracking",
  INVOICE: "invoice",
  PURCHASE_INVOICE: "invoice",
  ORDER_CONFIRMATION: "invoice",
  COMMUNICATION: "message",
  CUSTOMER_COMMUNICATION: "message",
  MESSAGE: "message",
  OTHER: "note",
  SELLER_NOTE: "note",
  SUPPORTING_NOTE: "note"
};

export function mapPayPalEvidenceType(
  evidenceType: unknown
): Evidence["type"] | undefined {
  if (typeof evidenceType !== "string") return undefined;

  const normalized = evidenceType.trim().toUpperCase();
  return PAYPAL_TO_INTERNAL_TYPE[normalized];
}

export function normalizePayPalEvidenceType(
  evidenceType: unknown
): string | undefined {
  if (typeof evidenceType !== "string") return undefined;

  const normalized = evidenceType.trim().toUpperCase();
  return normalized || undefined;
}

export function extractRequestedEvidence(
  rawData: unknown
): Array<{ evidenceType: string; notes?: string }> {
  if (
    !rawData ||
    typeof rawData !== "object" ||
    !Array.isArray((rawData as Record<string, unknown>).evidences)
  ) {
    return [];
  }

  return ((rawData as { evidences: unknown[] }).evidences)
    .filter((item): item is Record<string, unknown> =>
      Boolean(item) &&
      typeof item === "object" &&
      (item as Record<string, unknown>).source === "REQUESTED_FROM_SELLER"
    )
    .flatMap(item => {
      const evidenceType = item.evidence_type;
      if (typeof evidenceType !== "string" || !evidenceType.trim()) {
        return [];
      }

      return [{
        evidenceType: evidenceType.trim(),
        notes: typeof item.notes === "string" && item.notes.trim()
          ? item.notes.trim()
          : undefined
      }];
    });
}

function collectTextDetails(
  value: unknown,
  prefix = "",
  depth = 0
): string[] {
  if (depth > 4 || !value || typeof value !== "object") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).flatMap((item, index) =>
      collectTextDetails(item, `${prefix}[${index + 1}]`, depth + 1)
    );
  }

  return Object.entries(value as Record<string, unknown>).slice(0, 20).flatMap(
    ([key, item]) => {
      const label = prefix ? `${prefix}.${key}` : key;
      if (typeof item === "string" || typeof item === "number") {
        const text = String(item).trim();
        return text ? [`${label}: ${text.slice(0, 1000)}`] : [];
      }
      return collectTextDetails(item, label, depth + 1);
    }
  );
}

export function extractBuyerEvidence(rawData: unknown): BuyerEvidence[] {
  if (
    !rawData ||
    typeof rawData !== "object" ||
    !Array.isArray((rawData as Record<string, unknown>).evidences)
  ) {
    return [];
  }

  return ((rawData as { evidences: unknown[] }).evidences)
    .filter((item): item is Record<string, unknown> =>
      Boolean(item) &&
      typeof item === "object" &&
      (item as Record<string, unknown>).source === "SUBMITTED_BY_BUYER"
    )
    .slice(0, 10)
    .map(item => {
      const type = typeof item.evidence_type === "string"
        ? item.evidence_type.trim().slice(0, 100)
        : "UNSPECIFIED";
      let remainingCharacters = 4000;
      const details = [
        ...collectTextDetails(item.evidence_info),
        ...(typeof item.notes === "string" && item.notes.trim()
          ? [`notes: ${item.notes.trim().slice(0, 1000)}`]
          : [])
      ].slice(0, 20).flatMap(detail => {
        if (remainingCharacters <= 0) return [];
        const bounded = detail.slice(0, remainingCharacters);
        remainingCharacters -= bounded.length;
        return [bounded];
      });
      const documents = Array.isArray(item.documents)
        ? item.documents.flatMap((document, index) => {
            if (!document || typeof document !== "object") return [];
            const record = document as Record<string, unknown>;
            const name = [record.name, record.file_name, record.document_name]
              .find(value => typeof value === "string" && value.trim());
            return typeof name === "string"
              ? [{
                  index,
                  name: name.trim().slice(0, 255),
                  downloadable: typeof record.url === "string" &&
                    record.url.trim().length > 0
                }]
              : [];
          }).slice(0, 10)
        : [];

      return { type: type || "UNSPECIFIED", details, documents };
    });
}

export function getBuyerEvidenceDocumentUrl(
  rawData: unknown,
  evidenceIndex: number,
  documentIndex: number
): string | undefined {
  if (
    !rawData ||
    typeof rawData !== "object" ||
    !Array.isArray((rawData as Record<string, unknown>).evidences)
  ) {
    return undefined;
  }

  const buyerEvidence = ((rawData as { evidences: unknown[] }).evidences)
    .filter((item): item is Record<string, unknown> =>
      Boolean(item) &&
      typeof item === "object" &&
      (item as Record<string, unknown>).source === "SUBMITTED_BY_BUYER"
    )
    .slice(0, 10);
  const evidence = buyerEvidence[evidenceIndex];
  if (!evidence || !Array.isArray(evidence.documents)) return undefined;

  const document = evidence.documents.slice(0, 10)[documentIndex];
  if (!document || typeof document !== "object") return undefined;

  const url = (document as Record<string, unknown>).url;
  return typeof url === "string" && url.trim() ? url.trim() : undefined;
}

export function matchRequestedEvidence(
  dispute: Dispute
): RequestedEvidence[] {
  return extractRequestedEvidence(dispute.rawData)
    .map(request => {
      const internalEvidenceType = mapPayPalEvidenceType(
        request.evidenceType
      );
      const matchingEvidence = internalEvidenceType
        ? dispute.evidence.filter(item =>
            item.type === internalEvidenceType &&
            item.text.trim().length > 0 &&
            (
              internalEvidenceType !== "tracking" ||
              Boolean(item.carrier?.trim() && item.trackingNumber?.trim())
            )
          )
        : [];

      const verificationRequired =
        internalEvidenceType === "tracking" ||
        internalEvidenceType === undefined;

      let status: RequestedEvidence["status"] = "missing";
      if (matchingEvidence.length > 0) {
        status = verificationRequired
          ? "needs_verification"
          : "available";
      } else if (internalEvidenceType === undefined) {
        status = "needs_verification";
      }

      return {
        paypalEvidenceType: request.evidenceType,
        source: "REQUESTED_FROM_SELLER" as const,
        notes: request.notes,
        internalEvidenceType,
        status,
        matchedEvidenceIds: matchingEvidence.map(item => item.id),
        verificationRequired
      };
    });
}
