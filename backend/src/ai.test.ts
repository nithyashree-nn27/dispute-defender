import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeDispute, checkAIAvailability } from "./ai.js";
import type { Dispute } from "./type.js";

const dispute: Dispute = {
  id: "PP-TEST-1",
  reason: "ITEM_NOT_RECEIVED",
  status: "WAITING_FOR_SELLER_RESPONSE",
  amount: "20.00",
  currency: "USD",
  rawData: {},
  evidence: [
    {
      id: 1,
      disputeId: "PP-TEST-1",
      type: "tracking",
      text: "Carrier reports delivered",
      carrier: "Example Carrier",
      trackingNumber: "12345",
      createdAt: "2026-01-01"
    }
  ]
};

function analysisResponse(content: string): Response {
  return new Response(
    JSON.stringify({ message: { content } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

test("asks Ollama for a schema-constrained analysis using dispute evidence", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      model: string;
      format: { required: string[] };
      messages: Array<{ role: string; content: string }>;
    };

    assert.ok(request.model);
    assert.deepEqual(request.format.required, [
      "summary",
      "buyerClaims",
      "sellerEvidenceAssessment",
      "conflicts",
      "recommendedActions",
      "strength",
      "missing",
      "draft",
      "why"
    ]);
    assert.match(request.messages[1].content, /12345/);
    assert.match(request.messages[1].content, /ITEM_NOT_RECEIVED/);
    assert.doesNotMatch(request.messages[1].content, /rawData/);
    assert.match(request.messages[0].content, /buyer-submitted evidence/);
    assert.match(request.messages[0].content, /not read by this text model/);
    assert.match(request.messages[0].content, /wrong item delivered/);
    assert.match(request.messages[1].content, /Seller evidence #1/);

    return analysisResponse(JSON.stringify({
      summary: "Buyer reports non-receipt; seller added a tracking record.",
      buyerClaims: ["Buyer evidence is not available in this test case."],
      sellerEvidenceAssessment: [
        "Seller evidence #1: tracking is recorded, but delivery confirmation is not supplied."
      ],
      conflicts: ["No direct conflict can be established from the supplied data."],
      recommendedActions: ["Verify the carrier tracking status and recipient details."],
      strength: 65,
      missing: ["Invoice or proof of sale"],
      draft: "Please review the attached delivery evidence.",
      why: "Tracking evidence is present but does not independently confirm the recipient."
    }));
  };

  try {
    const result = await analyzeDispute(dispute);
    assert.equal(result.strength, 65);
    assert.deepEqual(result.missing, ["Invoice or proof of sale"]);
    assert.equal(result.sellerEvidenceAssessment?.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("includes buyer-submitted evidence separately from seller evidence", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const facts = JSON.parse(
      request.messages.find(item => item.role === "user")!.content
    ) as {
      buyerEvidence: Array<{
        sourceLabel: string;
        type: string;
        details: string[];
        documents: string[];
      }>;
      sellerEvidence: Array<{ sourceLabel: string; text: string }>;
    };

    assert.deepEqual(facts.buyerEvidence, [{
      sourceLabel: "Buyer evidence #1",
      type: "CREATE",
      details: [
        "item_description: Buyer says the package contained the wrong item",
        "notes: The received product did not match the listing"
      ],
      documents: ["buyer-photo.png"]
    }]);
    assert.deepEqual(facts.sellerEvidence, [{
      sourceLabel: "Seller evidence #1",
      type: "tracking",
      text: "Carrier reports delivered",
      carrier: "Example Carrier",
      trackingNumber: "12345",
      imageAttachment: null
    }]);

    return analysisResponse(JSON.stringify({
      summary: "Buyer says the wrong item arrived; seller supplied delivery tracking.",
      buyerClaims: ["Buyer evidence #1 says the product did not match the listing."],
      sellerEvidenceAssessment: [
        "Seller evidence #1 records carrier delivery, but does not establish item identity."
      ],
      conflicts: [
        "The buyer's item-condition claim is not resolved by the seller's delivery tracking."
      ],
      recommendedActions: [
        "Compare the buyer's description with the order record and item listing."
      ],
      strength: 65,
      missing: ["Verify the buyer's attached photo"],
      draft: "Please review the seller's response.",
      why: "The buyer's description conflicts with the seller's delivery record."
    }));
  };

  try {
    await analyzeDispute({
      ...dispute,
      rawData: {
        evidences: [
          {
            source: "SUBMITTED_BY_BUYER",
            evidence_type: "CREATE",
            evidence_info: {
              item_description: "Buyer says the package contained the wrong item"
            },
            notes: "The received product did not match the listing",
            documents: [{ name: "buyer-photo.png", url: "not sent to AI" }]
          },
          {
            source: "REQUESTED_FROM_SELLER",
            evidence_type: "PROOF_OF_FULFILLMENT",
            notes: "Provide shipping proof"
          }
        ]
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps item-not-received and wrong-item-delivered categories distinct", async () => {
  const originalFetch = globalThis.fetch;
  const categories: string[] = [];

  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMessage = request.messages.find(item => item.role === "user");
    assert.ok(userMessage);
    const facts = JSON.parse(userMessage.content) as {
      reasonCategory: string;
    };
    categories.push(facts.reasonCategory);
    return analysisResponse(JSON.stringify({
      summary: "Evidence review.",
      buyerClaims: ["No buyer evidence was supplied."],
      sellerEvidenceAssessment: ["Seller evidence was supplied."],
      conflicts: ["No direct conflict can be established."],
      recommendedActions: ["Review evidence."],
      strength: 10,
      missing: ["Relevant evidence"],
      draft: "Please review the available evidence.",
      why: "The evidence provided is limited."
    }));
  };

  try {
    await analyzeDispute({
      ...dispute,
      reason: "ITEM_NOT_RECEIVED"
    });
    await analyzeDispute({
      ...dispute,
      reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"
    });

    assert.match(categories[0], /order did not arrive/);
    assert.match(categories[1], /wrong item delivered/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports unavailable Ollama and provides model setup guidance", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ models: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

  try {
    const status = await checkAIAvailability();
    assert.equal(status.available, false);
    assert.match(status.message, /ollama pull/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports Ollama as ready when the configured model is installed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ models: [{ name: process.env.OLLAMA_MODEL || "qwen2.5:7b" }] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

  try {
    const status = await checkAIAvailability();
    assert.equal(status.available, true);
    assert.match(status.message, /ready/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects malformed or incomplete model output", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => analysisResponse(
    JSON.stringify({
      summary: "Invalid score.",
      buyerClaims: [],
      sellerEvidenceAssessment: [],
      conflicts: [],
      recommendedActions: ["Review."],
      strength: 110,
      missing: [],
      draft: "",
      why: "Not valid."
    })
  );

  try {
    await assert.rejects(
      analyzeDispute(dispute),
      /unsupported format/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explains when Ollama cannot find the requested model", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: "model not found" }),
    { status: 404, headers: { "Content-Type": "application/json" } }
  );

  try {
    await assert.rejects(analyzeDispute(dispute), /ollama pull/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
