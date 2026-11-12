
const PAYPAL_BASE_URL =
  process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
const MAX_BUYER_IMAGE_SIZE = 10 * 1024 * 1024;

let accessToken = "";
let tokenExpiry = 0;

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiry) {
    return accessToken;
  }

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("PayPal credentials are missing.");
  }

  const credentials = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const response = await fetch(
    `${PAYPAL_BASE_URL}/v1/oauth2/token`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(15000)
    }
  );

  if (!response.ok) {
    throw new Error("PayPal authentication failed.");
  }

  let tokenResponse: unknown;
  try {
    tokenResponse = await response.json();
  } catch {
    throw new Error("PayPal authentication returned invalid JSON.");
  }

  if (
    typeof tokenResponse !== "object" ||
    tokenResponse === null ||
    Array.isArray(tokenResponse)
  ) {
    throw new Error("PayPal authentication returned an invalid response.");
  }

  const data = tokenResponse as Record<string, unknown>;
  if (
    typeof data.access_token !== "string" ||
    !data.access_token.trim()
  ) {
    throw new Error(
      "PayPal authentication response has no valid access token."
    );
  }
  if (
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  ) {
    throw new Error(
      "PayPal authentication response has an invalid token expiry."
    );
  }

  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;

  return accessToken;
}

async function paypalRequest<T>(
  endpoint: string,
  options: RequestInit = {},
  timeoutMs = 20000
): Promise<T> {
  const token = await getAccessToken();
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);

  if (options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(
    `${PAYPAL_BASE_URL}${endpoint}`,
    {
      ...options,
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    }
  );

  if (!response.ok) {
    console.error("PayPal API request failed.", { status: response.status });
    throw new Error(`PayPal API request failed: ${response.status}`);
  }

  const text = await response.text();

  return (text ? JSON.parse(text) : {}) as T;
}

// Fetch disputes from PayPal
export async function getDisputes() {
  return paypalRequest<{
    items?: Array<{ dispute_id: string }>;
  }>("/v1/customer/disputes?page_size=20");
}

// Fetch complete details of one dispute
export async function getDisputeDetails(id: string) {
  if (!id.trim()) {
    throw new Error("Dispute ID is required.");
  }

  return paypalRequest<Record<string, unknown>>(
    `/v1/customer/disputes/${encodeURIComponent(id)}`
  );
}

export async function downloadPayPalDocument(url: string) {
  let documentUrl: URL;
  try {
    documentUrl = new URL(url);
  } catch {
    throw new Error("PayPal did not provide a valid document URL.");
  }

  const paypalOrigin = new URL(PAYPAL_BASE_URL).origin;
  if (
    documentUrl.protocol !== "https:" ||
    documentUrl.origin !== paypalOrigin ||
    documentUrl.username !== "" ||
    documentUrl.password !== "" ||
    !documentUrl.pathname.startsWith("/v2/content/documents/")
  ) {
    throw new Error("The document URL is outside the configured PayPal API.");
  }

  const token = await getAccessToken();
  const response = await fetch(documentUrl, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
    signal: AbortSignal.timeout(30000)
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error("PayPal redirected the document request; the image was not fetched.");
  }

  if (!response.ok) {
    throw new Error(`PayPal could not retrieve the document (HTTP ${response.status}).`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BUYER_IMAGE_SIZE) {
    throw new Error("The buyer image is larger than the 10 MB preview limit.");
  }

  if (!response.body) {
    throw new Error("PayPal returned an empty document.");
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalSize += value.byteLength;
    if (totalSize > MAX_BUYER_IMAGE_SIZE) {
      await reader.cancel();
      throw new Error("The buyer image is larger than the 10 MB preview limit.");
    }
    chunks.push(Buffer.from(value));
  }

  return {
    contentType: response.headers.get("content-type")?.split(";")[0].trim() ?? "",
    data: Buffer.concat(chunks, totalSize)
  };
}

// Submit seller evidence to PayPal
export async function submitEvidence(
  id: string,
  evidences: unknown[],
  file?: {
    buffer: Buffer;
    mimetype: string;
    filename: string;
  }
) {
  if (!evidences.length) {
    throw new Error("Evidence is required.");
  }

  if (file) {
    const form = new FormData();
    form.set(
      "evidence-file",
      new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }),
      file.filename
    );

    await paypalRequest<Record<string, unknown>>(
      `/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`,
      {
        method: "POST",
        body: form
      },
      60000
    );

    try {
      return await paypalRequest<Record<string, unknown>>(
        `/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`,
        {
          method: "POST",
          body: JSON.stringify({ evidences })
        }
      );
    } catch (error) {
      throw new Error(
        `PayPal accepted the image upload, but could not confirm the evidence details submission. Check the dispute in PayPal before retrying. ${
          error instanceof Error ? error.message : ""
        }`.trim()
      );
    }
  }

  return paypalRequest<Record<string, unknown>>(
    `/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`,
    {
      method: "POST",
      body: JSON.stringify({ evidences })
    }
  );
}

// Verify PayPal webhook signature
export async function verifyWebhook(
  headers: Record<string, string | string[] | undefined>,
  event: unknown
): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  if (!webhookId) {
    throw new Error("PayPal webhook ID is missing.");
  }

  const getHeader = (name: string) =>
    String(headers[name] ?? "");

  const result = await paypalRequest<{
    verification_status: string;
  }>("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: JSON.stringify({
      auth_algo: getHeader("paypal-auth-algo"),
      cert_url: getHeader("paypal-cert-url"),
      transmission_id: getHeader("paypal-transmission-id"),
      transmission_sig: getHeader("paypal-transmission-sig"),
      transmission_time: getHeader("paypal-transmission-time"),
      webhook_id: webhookId,
      webhook_event: event
    })
  });

  return result.verification_status === "SUCCESS";
}
