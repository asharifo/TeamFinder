export async function parseResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

export async function throwIfError(response, payload) {
  if (response.ok) {
    return;
  }

  const message = typeof payload === "string" ? payload : payload?.error || "Request failed";
  const error = new Error(message);
  error.status = response.status;
  error.payload = payload;
  throw error;
}
