import type { Analysis, Dispute, Evidence } from "./type.js";
import { matchRequestedEvidence } from "./evidenceMatching.js";

const evidenceLabel: Record<Evidence["type"], string> = {
  tracking: "Tracking information",
  note: "Supporting seller note",
  invoice: "Invoice or proof of sale",
  message: "Buyer or seller communication"
};

function hasEvidence(dispute: Dispute, type: Evidence["type"]) {
  return dispute.evidence.some(item =>
    item.type === type &&
    item.text.trim().length > 0
  );
}

export function analyzeDisputeWithRules(dispute: Dispute): Analysis {
  const trackingAvailable = hasEvidence(dispute, "tracking");
  const invoiceAvailable = hasEvidence(dispute, "invoice");
  const messageAvailable = hasEvidence(dispute, "message");
  const noteAvailable = hasEvidence(dispute, "note");

  const evidenceChecks: Array<{
    type: Evidence["type"];
    weight: number;
    points: number;
  }> = [
    {
      type: "tracking",
      weight: 35,
      points: trackingAvailable ? 35 : 0
    },
    {
      type: "invoice",
      weight: 25,
      points: invoiceAvailable ? 25 : 0
    },
    {
      type: "message",
      weight: 20,
      points: messageAvailable ? 20 : 0
    },
    {
      type: "note",
      weight: 20,
      points: noteAvailable ? 20 : 0
    }
  ];

  const strength = evidenceChecks.reduce(
    (total, item) => total + item.points,
    0
  );
  const missing = evidenceChecks
    .filter(item => item.points === 0)
    .map(item => evidenceLabel[item.type]);

  const available = evidenceChecks
    .filter(item => item.points > 0)
    .map(item => evidenceLabel[item.type]);

  const requestedEvidence = matchRequestedEvidence(dispute);
  const requestedMissing = requestedEvidence
    .filter(item => item.status === "missing")
    .map(item => item.paypalEvidenceType);
  const requestedVerification = requestedEvidence
    .filter(item => item.status === "needs_verification")
    .map(item => item.paypalEvidenceType);

  const facts = [
    `Dispute ${dispute.id} concerns ${dispute.reason}.`,
    `The current status is ${dispute.status}.`,
    `The disputed amount is ${dispute.amount} ${dispute.currency}.`
  ];

  if (dispute.dueDate) {
    facts.push(`The seller response is due on ${dispute.dueDate}.`);
  }

  if (trackingAvailable) {
    const tracking = dispute.evidence.filter(item => item.type === "tracking");
    const details = tracking
      .filter(item => item.carrier && item.trackingNumber)
      .map(item => `${item.carrier} tracking number ${item.trackingNumber}`)
      .join("; ");

    facts.push(
      details
        ? `Seller-provided tracking details include ${details}.`
        : "Seller-provided tracking evidence is available."
    );
  }

  if (invoiceAvailable) {
    facts.push("Seller-provided invoice or proof-of-sale evidence is available.");
  }

  if (messageAvailable) {
    facts.push("Seller-provided communication evidence is available.");
  }

  if (noteAvailable) {
    facts.push("Seller-provided supporting notes are available.");
  }

  const draft = [
    "Hello,",
    "",
    `I am responding to dispute ${dispute.id} regarding ${dispute.reason}.`,
    "",
    ...facts.slice(1),
    "",
    available.length
      ? `The seller has provided the following evidence: ${available.join(", ").toLowerCase()}.`
      : "No seller evidence has been added to this dispute yet.",
    missing.length
      ? `Additional evidence still recommended for review: ${missing.join(", ").toLowerCase()}.`
      : "The available evidence checklist has been completed.",
    requestedMissing.length
      ? `PayPal specifically requests these missing evidence types: ${requestedMissing.join(", ")}.`
      : "",
    requestedVerification.length
      ? `These PayPal-requested items require seller verification and not just automatic matching: ${requestedVerification.join(", ")}.`
      : "",
    "",
    "Please review the supplied evidence and determine an appropriate resolution based on the documented information.",
    "",
    "Thank you."
  ].join("\n");

  const requestedWhy = requestedEvidence.length
    ? ` PayPal requests ${requestedEvidence.length} evidence item${requestedEvidence.length === 1 ? "" : "s"}; ${requestedMissing.length} are missing and ${requestedVerification.length} require verification.`
    : "";
  const why = available.length
    ? `The ${strength}% score reflects ${available.join(", ").toLowerCase()} currently recorded for this dispute. It measures evidence completeness, not the likelihood of winning.`
    : `No supporting evidence is recorded, so the completeness score is ${strength}%. This score measures evidence completeness, not the likelihood of winning.`;

  return {
    strength,
    missing,
    draft,
    why: `${why}${requestedWhy}`
  };
}
