import assert from "node:assert/strict";
import { test } from "node:test";
import {
  downloadPayPalDocument,
  getDisputes,
  submitEvidence
} from "./paypal.js";

test("rejects malformed or invalid OAuth token responses safely", async () => {
  const originalFetch = globalThis.fetch;
  const originalClientId = process.env.PAYPAL_CLIENT_ID;
  const originalClientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const invalidResponses = [
    { access_token: "", expires_in: 3600 },
    { access_token: "   ", expires_in: 3600 },
    { access_token: "test-token", expires_in: 0 },
    { access_token: "test-token", expires_in: -1 },
    { access_token: "test-token", expires_in: "3600" }
  ];
  let responseIndex = 0;
  process.env.PAYPAL_CLIENT_ID = "test-client-id";
  process.env.PAYPAL_CLIENT_SECRET = "test-client-secret";

  globalThis.fetch = async () => new Response(
    JSON.stringify(invalidResponses[responseIndex++]),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

  try {
    for (const invalidResponse of invalidResponses) {
      const expectedMessage = !invalidResponse.access_token.trim()
        ? /no valid access token/
        : /invalid token expiry/;
      await assert.rejects(getDisputes(), expectedMessage);
    }

    globalThis.fetch = async () => new Response("not-json", { status: 200 });
    await assert.rejects(getDisputes(), /returned invalid JSON/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalClientId === undefined) {
      delete process.env.PAYPAL_CLIENT_ID;
    } else {
      process.env.PAYPAL_CLIENT_ID = originalClientId;
    }
    if (originalClientSecret === undefined) {
      delete process.env.PAYPAL_CLIENT_SECRET;
    } else {
      process.env.PAYPAL_CLIENT_SECRET = originalClientSecret;
    }
  }
});

test("sends an evidence image as multipart and evidence details as JSON", async () => {
  const originalFetch = globalThis.fetch;
  const originalClientId = process.env.PAYPAL_CLIENT_ID;
  const originalClientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  process.env.PAYPAL_CLIENT_ID = "sandbox-client-id";
  process.env.PAYPAL_CLIENT_SECRET = "sandbox-client-secret";

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/v1/oauth2/token")) {
      return new Response(
        JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await submitEvidence(
      "PP-TEST-1",
      [{ evidence_type: "ITEM_DESCRIPTION", notes: "Seller notes" }],
      {
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        mimetype: "image/png",
        filename: "item-photo.png"
      }
    );

    assert.deepEqual(result, {});
    assert.equal(calls.length, 3);
    assert.ok(calls[0].url.endsWith("/v1/oauth2/token"));

    const fileUpload = calls[1];
    assert.match(fileUpload.url, /\/provide-evidence$/);
    assert.ok(fileUpload.init?.body instanceof FormData);
    const formData = fileUpload.init?.body as FormData;
    const uploadedFile = formData.get("evidence-file");
    assert.ok(uploadedFile instanceof Blob);
    assert.equal((uploadedFile as File).name, "item-photo.png");
    assert.equal(formData.has("evidences"), false);

    const metadataSubmission = calls[2];
    assert.match(metadataSubmission.url, /\/provide-evidence$/);
    assert.equal(
      new Headers(metadataSubmission.init?.headers).get("Content-Type"),
      "application/json"
    );
    assert.deepEqual(
      JSON.parse(String(metadataSubmission.init?.body)),
      {
        evidences: [
          { evidence_type: "ITEM_DESCRIPTION", notes: "Seller notes" }
        ]
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalClientId === undefined) {
      delete process.env.PAYPAL_CLIENT_ID;
    } else {
      process.env.PAYPAL_CLIENT_ID = originalClientId;
    }
    if (originalClientSecret === undefined) {
      delete process.env.PAYPAL_CLIENT_SECRET;
    } else {
      process.env.PAYPAL_CLIENT_SECRET = originalClientSecret;
    }
  }
});

test("downloads a buyer document only from the configured PayPal origin", async () => {
  const originalFetch = globalThis.fetch;
  const originalClientId = process.env.PAYPAL_CLIENT_ID;
  const originalClientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  process.env.PAYPAL_CLIENT_ID = "sandbox-client-id";
  process.env.PAYPAL_CLIENT_SECRET = "sandbox-client-secret";

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/v1/oauth2/token")) {
      return new Response(
        JSON.stringify({ access_token: "document-test-token", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
      status: 200,
      headers: { "Content-Type": "image/jpeg" }
    });
  };

  try {
    const document = await downloadPayPalDocument(
      "https://api-m.sandbox.paypal.com/v2/content/documents/preview-1"
    );
    assert.equal(document.contentType, "image/jpeg");
    assert.deepEqual(document.data, Buffer.from([0xff, 0xd8, 0xff]));

    const documentRequest = calls.at(-1);
    assert.ok(documentRequest);
    assert.match(
      documentRequest.url,
      /\/v2\/content\/documents\/preview-1$/
    );
    assert.ok(
      new Headers(documentRequest.init?.headers)
        .get("Authorization")
        ?.startsWith("Bearer ")
    );
    assert.equal(documentRequest.init?.redirect, "manual");

    await assert.rejects(
      downloadPayPalDocument("https://example.invalid/image.png"),
      /outside the configured PayPal API/
    );
    await assert.rejects(
      downloadPayPalDocument(
        "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-1"
      ),
      /outside the configured PayPal API/
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalClientId === undefined) {
      delete process.env.PAYPAL_CLIENT_ID;
    } else {
      process.env.PAYPAL_CLIENT_ID = originalClientId;
    }
    if (originalClientSecret === undefined) {
      delete process.env.PAYPAL_CLIENT_SECRET;
    } else {
      process.env.PAYPAL_CLIENT_SECRET = originalClientSecret;
    }
  }
});

test("logs only the HTTP status for PayPal API errors", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const originalClientId = process.env.PAYPAL_CLIENT_ID;
  const originalClientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const logs: unknown[][] = [];
  process.env.PAYPAL_CLIENT_ID = "test-client-id";
  process.env.PAYPAL_CLIENT_SECRET = "test-client-secret";
  globalThis.fetch = async () => new Response(
    JSON.stringify({ detail: "sensitive response content" }),
    { status: 502 }
  );
  console.error = (...args: unknown[]) => {
    logs.push(args);
  };

  try {
    await assert.rejects(getDisputes(), /PayPal API request failed: 502/);
    assert.deepEqual(logs, [
      ["PayPal API request failed.", { status: 502 }]
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    if (originalClientId === undefined) {
      delete process.env.PAYPAL_CLIENT_ID;
    } else {
      process.env.PAYPAL_CLIENT_ID = originalClientId;
    }
    if (originalClientSecret === undefined) {
      delete process.env.PAYPAL_CLIENT_SECRET;
    } else {
      process.env.PAYPAL_CLIENT_SECRET = originalClientSecret;
    }
  }
});
