import assert from "node:assert/strict";
import test from "node:test";
import {
  extractBuyerEvidence,
  extractRequestedEvidence,
  getBuyerEvidenceDocumentUrl,
  mapPayPalEvidenceType,
  matchRequestedEvidence
} from "./evidenceMatching.js";
import type { Dispute } from "./type.js";

function dispute(rawData: unknown, evidence: Dispute["evidence"] = []): Dispute {
  return {
    id: "PP-R-TEST",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    status: "WAITING_FOR_SELLER_RESPONSE",
    amount: "25.00",
    currency: "USD",
    rawData: rawData as Record<string, unknown>,
    evidence
  };
}

test("extracts only requested seller evidence", () => {
  const requests = extractRequestedEvidence({
    evidences: [
      { source: "SUBMITTED_BY_BUYER", evidence_type: "CREATE" },
      {
        source: "REQUESTED_FROM_SELLER",
        evidence_type: "PROOF_OF_FULFILLMENT",
        notes: "Provide shipping proof"
      }
    ]
  });

  assert.deepEqual(requests, [{
    evidenceType: "PROOF_OF_FULFILLMENT",
    notes: "Provide shipping proof"
  }]);
});

test("handles missing and malformed evidence data", () => {
  assert.deepEqual(extractRequestedEvidence(undefined), []);
  assert.deepEqual(extractRequestedEvidence({ evidences: null }), []);
  assert.deepEqual(extractRequestedEvidence({
    evidences: [{ source: "REQUESTED_FROM_SELLER" }, null, "invalid"]
  }), []);
});

test("extracts buyer evidence content and downloadable document metadata", () => {
  assert.deepEqual(extractBuyerEvidence({
    evidences: [
      {
        source: "SUBMITTED_BY_BUYER",
        evidence_type: "CREATE",
        evidence_info: {
          item_description: "Item differs from listing",
          order: { item_name: "Blue jacket" }
        },
        notes: "Buyer explanation",
        documents: [
          { name: "photo.png", url: "https://example.invalid/private-file" }
        ]
      },
      {
        source: "REQUESTED_FROM_SELLER",
        evidence_type: "INVOICE",
        notes: "Not buyer evidence"
      }
    ]
  }), [{
    type: "CREATE",
    details: [
      "item_description: Item differs from listing",
      "order.item_name: Blue jacket",
      "notes: Buyer explanation"
    ],
    documents: [{ index: 0, name: "photo.png", downloadable: true }]
  }]);
});

test("returns only buyer document URLs by evidence and document indexes", () => {
  const rawData = {
    evidences: [
      {
        source: "REQUESTED_FROM_SELLER",
        documents: [{ name: "seller.png", url: "https://api-m.sandbox.paypal.com/v1/seller" }]
      },
      {
        source: "SUBMITTED_BY_BUYER",
        documents: [{ name: "buyer.png", url: "https://api-m.sandbox.paypal.com/v1/buyer" }]
      }
    ]
  };
  assert.equal(
    getBuyerEvidenceDocumentUrl(rawData, 0, 0),
    "https://api-m.sandbox.paypal.com/v1/buyer"
  );
  assert.equal(getBuyerEvidenceDocumentUrl(rawData, 1, 0), undefined);
  assert.equal(getBuyerEvidenceDocumentUrl(rawData, 0, 1), undefined);
});

test("maps supported PayPal evidence types", () => {
  assert.equal(mapPayPalEvidenceType("PROOF_OF_FULFILLMENT"), "tracking");
  assert.equal(mapPayPalEvidenceType("INVOICE"), "invoice");
  assert.equal(mapPayPalEvidenceType("COMMUNICATION"), "message");
  assert.equal(mapPayPalEvidenceType("OTHER"), "note");
  assert.equal(mapPayPalEvidenceType("UNSUPPORTED_TYPE"), undefined);
});

test("normalizes and maps alias evidence types", () => {
  assert.equal(mapPayPalEvidenceType("  proof_of_delivery "), "tracking");
  assert.equal(mapPayPalEvidenceType("shipping_label"), "tracking");
  assert.equal(mapPayPalEvidenceType("purchase_invoice"), "invoice");
  assert.equal(mapPayPalEvidenceType("customer_communication"), "message");
  assert.equal(mapPayPalEvidenceType("seller_note"), "note");
});

test("matches invoice and message evidence", () => {
  const result = matchRequestedEvidence(dispute({
    evidences: [
      {
        source: "REQUESTED_FROM_SELLER",
        evidence_type: "INVOICE",
        notes: "Invoice requested"
      },
      {
        source: "REQUESTED_FROM_SELLER",
        evidence_type: "COMMUNICATION",
        notes: "Communication requested"
      }
    ]
  }, [
    {
      id: 1,
      disputeId: "PP-R-TEST",
      type: "invoice",
      text: "Invoice copy",
      createdAt: "2026-11-07"
    },
    {
      id: 2,
      disputeId: "PP-R-TEST",
      type: "message",
      text: "Conversation copy",
      createdAt: "2026-11-07"
    }
  ]));

  assert.equal(result[0].status, "available");
  assert.equal(result[1].status, "available");
});

test("reports missing requested evidence", () => {
  const result = matchRequestedEvidence(dispute({
    evidences: [{
      source: "REQUESTED_FROM_SELLER",
      evidence_type: "INVOICE"
    }]
  }));

  assert.equal(result[0].status, "missing");
  assert.deepEqual(result[0].matchedEvidenceIds, []);
});

test("tracking without delivery confirmation needs verification", () => {
  const result = matchRequestedEvidence(dispute({
    evidences: [{
      source: "REQUESTED_FROM_SELLER",
      evidence_type: "PROOF_OF_FULFILLMENT"
    }]
  }, [{
    id: 1,
    disputeId: "PP-R-TEST",
    type: "tracking",
    text: "Tracking number supplied",
    carrier: "Test Carrier",
    trackingNumber: "123456",
    createdAt: "2026-11-07"
  }]));

  assert.equal(result[0].status, "needs_verification");
  assert.equal(result[0].verificationRequired, true);
  assert.deepEqual(result[0].matchedEvidenceIds, [1]);
});

test("tracking records require carrier and tracking number to match", () => {
  const result = matchRequestedEvidence(dispute({
    evidences: [{
      source: "REQUESTED_FROM_SELLER",
      evidence_type: "PROOF_OF_FULFILLMENT"
    }]
  }, [{
    id: 1,
    disputeId: "PP-R-TEST",
    type: "tracking",
    text: "A tracking reference",
    createdAt: "2026-11-07"
  }]));

  assert.equal(result[0].status, "missing");
  assert.deepEqual(result[0].matchedEvidenceIds, []);
});

test("unknown requested evidence needs manual verification", () => {
  const result = matchRequestedEvidence(dispute({
    evidences: [{
      source: "REQUESTED_FROM_SELLER",
      evidence_type: "UNSUPPORTED_TYPE"
    }]
  }));

  assert.equal(result[0].status, "needs_verification");
  assert.equal(result[0].verificationRequired, true);
  assert.equal(result[0].internalEvidenceType, undefined);
});

test("disputes without requests return an empty checklist", () => {
  assert.deepEqual(matchRequestedEvidence(dispute({ evidences: [] })), []);
  assert.deepEqual(matchRequestedEvidence(dispute(null)), []);
});
