
const API_URL = "http://localhost:3001";

export async function apiRequest(
  endpoint: string,
  password: string,
  options: RequestInit = {}
) {
  const headers = new Headers(options.headers);
  headers.set("x-app-password", password);

  if (!(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers
  });

  const text = await response.text();
  let data: any;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("The server returned an invalid response.");
  }

  if (!response.ok) {
    throw new Error(data.error || "API request failed");
  }

  return data;
}

export async function fetchEvidenceImage(
  endpoint: string,
  password: string,
  signal: AbortSignal
): Promise<Blob> {
  const response = await fetch(`${API_URL}${endpoint}`, {
    headers: { "x-app-password": password },
    signal
  });

  if (!response.ok) {
    let message = "Could not load this evidence image.";
    try {
      const data = await response.json() as { error?: string };
      message = data.error || message;
    } catch {
      // Keep the generic message when the endpoint does not return JSON.
    }
    throw new Error(message);
  }

  return response.blob();
}

export async function syncDisputes(password: string) {
  return apiRequest("/api/sync", password, {
    method: "POST"
  });
}

export async function getDisputes(password: string) {
  return apiRequest("/api/disputes", password);
}

export async function getDispute(
  id: string,
  password: string
) {
  return apiRequest(
    `/api/disputes/${encodeURIComponent(id)}`,
    password
  );
}

// Dispute analysis
export async function analyzeDispute(
  id: string,
  password: string
) {
  return apiRequest(
    `/api/disputes/${encodeURIComponent(id)}/analyze`,
    password,
    {
      method: "POST"
    }
  );
}
