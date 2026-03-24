const DEFAULT_ENDPOINT = import.meta.env.VITE_INVOICES_API_ENDPOINT;
const DEFAULT_API_KEY = import.meta.env.VITE_INVOICES_API_KEY;

function normalizeInvoicesResponse(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.invoices)) return data.invoices;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

export async function fetchInvoices(signal) {
  if (!DEFAULT_ENDPOINT) {
    throw new Error("Missing VITE_INVOICES_API_ENDPOINT in .env");
  }

  if (!DEFAULT_API_KEY) {
    throw new Error("Missing VITE_INVOICES_API_KEY in .env");
  }

  const url = new URL(DEFAULT_ENDPOINT);

  // Since your API docs say header OR query param, this sends both for compatibility.
  url.searchParams.set("apiKey", DEFAULT_API_KEY);

  const response = await fetch(url.toString(), {
    method: "GET",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEFAULT_API_KEY}`,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Failed to load invoices (${response.status})`);
  }

  const data = await response.json().catch(() => []);
  return normalizeInvoicesResponse(data);
}