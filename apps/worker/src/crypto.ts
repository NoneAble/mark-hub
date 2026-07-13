/**
 * Authenticated encryption for Worker secrets (F-007).
 * AES-GCM with key derived from MARKHUB_MASTER_KEY via SHA-256.
 * Format: enc:v1:<iv_b64url>:<ct_b64url>
 */

const PREFIX = "enc:v1:";

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function deriveKey(master: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(master));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(plain: string, masterKey: string): Promise<string> {
  if (!plain) return "";
  if (!masterKey || masterKey.length < 16) {
    throw new Error("MARKHUB_MASTER_KEY required for secret encryption");
  }
  const key = await deriveKey(masterKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  return `${PREFIX}${b64urlEncode(iv)}:${b64urlEncode(ct)}`;
}

export async function decryptSecret(stored: string, masterKey: string): Promise<string> {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) {
    // Legacy plaintext migration path
    return stored;
  }
  if (!masterKey) return "";
  try {
    const rest = stored.slice(PREFIX.length);
    const [ivPart, ctPart] = rest.split(":");
    if (!ivPart || !ctPart) return "";
    const key = await deriveKey(masterKey);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(ivPart) },
      key,
      b64urlDecode(ctPart),
    );
    return new TextDecoder().decode(pt);
  } catch {
    return "";
  }
}

export function requireStrongSecret(name: string, value: string | undefined, min = 16): string {
  const v = (value || "").trim();
  const insecure = new Set([
    "",
    "change-me",
    "change-me-jwt-secret",
    "change-me-master-key-32bytes!!!!",
    "secret",
  ]);
  if (insecure.has(v) || v.length < min) {
    throw new Error(
      `${name} must be a strong secret (>=${min} chars) and not a known default`,
    );
  }
  return v;
}
