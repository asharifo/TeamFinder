function randomString(length = 64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const random = new Uint8Array(length);
  crypto.getRandomValues(random);
  return Array.from(random, (value) => chars[value % chars.length]).join("");
}

function toBase64Url(input) {
  const bytes = new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function codeChallenge(codeVerifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return toBase64Url(digest);
}

export async function generatePkcePair() {
  const verifier = randomString(96);
  const challenge = await codeChallenge(verifier);
  return { verifier, challenge };
}

export function generateStateToken() {
  return randomString(48);
}
