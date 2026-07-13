/**
 * Minimal AWS Signature V4 helpers for S3-compatible APIs (R2/MinIO).
 * Used for ListObjectsV2 / PutObject / DeleteObject without full AWS SDK.
 */

function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function amzDate(d = new Date()): { amz: string; date: string } {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amz: iso, date: iso.slice(0, 8) };
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key instanceof Uint8Array ? key : new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getSigningKey(
  secret: string,
  date: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(new TextEncoder().encode("AWS4" + secret), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export type S3Creds = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
};

function endpointHost(endpoint: string): { host: string; base: string } {
  const u = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`);
  return { host: u.host, base: `${u.protocol}//${u.host}` };
}

async function signedFetch(
  creds: S3Creds,
  method: string,
  keyPath: string,
  query: Record<string, string> = {},
  body?: Uint8Array | string | null,
  contentType?: string,
  timeoutMs = 10_000,
): Promise<Response> {
  const { host, base } = endpointHost(creds.endpoint);
  const region = creds.region || "auto";
  const forcePath = creds.forcePathStyle !== false;
  const bucket = creds.bucket;
  // path-style: /bucket/key
  const canonicalUri = forcePath
    ? `/${encodeRfc3986(bucket).replace(/%2F/g, "/")}${keyPath ? "/" + keyPath.split("/").map(encodeRfc3986).join("/") : ""}`
    : keyPath
      ? `/${keyPath.split("/").map(encodeRfc3986).join("/")}`
      : "/";
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(query[k]!)}`)
    .join("&");
  const payload =
    body == null
      ? new Uint8Array(0)
      : typeof body === "string"
        ? new TextEncoder().encode(body)
        : body;
  const payloadHash = await sha256Hex(payload);
  const { amz, date } = amzDate();
  const headers: Record<string, string> = {
    host: forcePath ? host : `${bucket}.${host}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amz,
  };
  if (contentType) headers["content-type"] = contentType;
  if (payload.length) headers["content-length"] = String(payload.length);

  const signedHeaderKeys = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderKeys.map((k) => `${k}:${headers[k]!.trim()}\n`).join("");
  const signedHeaders = signedHeaderKeys.join(";");
  const canonicalRequest = [
    method,
    canonicalUri,
    qs,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amz,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = await getSigningKey(creds.secretAccessKey, date, region, "s3");
  const sigBuf = await hmac(signingKey, stringToSign);
  const signature = [...new Uint8Array(sigBuf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const urlHost = forcePath ? host : `${bucket}.${host}`;
  const url = `${base.replace(host, urlHost)}${canonicalUri}${qs ? `?${qs}` : ""}`;
  // rebuild base correctly for virtual-hosted
  const finalUrl = forcePath
    ? `${base}${canonicalUri}${qs ? `?${qs}` : ""}`
    : `https://${urlHost}${canonicalUri}${qs ? `?${qs}` : ""}`;

  const reqHeaders = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    if (k === "host") continue;
    reqHeaders.set(k, v);
  }
  reqHeaders.set("Authorization", authorization);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(finalUrl || url, {
      method,
      headers: reqHeaders,
      body: payload.length ? payload : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message))) {
      const err = new Error("S3 request timed out");
      (err as Error & { code?: string }).code = "s3_network";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function s3ListObjects(
  creds: S3Creds,
  opts: { prefix?: string; maxKeys?: number; timeoutMs?: number } = {},
): Promise<{ ok: true; keys: { Key: string; LastModified?: string }[] } | { ok: false; status: number; message: string; code?: string }> {
  const query: Record<string, string> = {
    "list-type": "2",
    "max-keys": String(opts.maxKeys ?? 1),
  };
  if (opts.prefix) query.prefix = opts.prefix;
  try {
    const r = await signedFetch(creds, "GET", "", query, null, undefined, opts.timeoutMs ?? 10_000);
    const text = await r.text();
    if (!r.ok) {
      return { ok: false, status: r.status, message: text.slice(0, 200) };
    }
    const keys: { Key: string; LastModified?: string }[] = [];
    const re = /<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?(?:<LastModified>([^<]+)<\/LastModified>)?[\s\S]*?<\/Contents>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      keys.push({ Key: m[1]!, LastModified: m[2] });
    }
    return { ok: true, keys };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, message: msg.slice(0, 200), code: "s3_network" };
  }
}

export async function s3PutObject(
  creds: S3Creds,
  key: string,
  body: string,
  contentType = "application/json",
  timeoutMs = 30_000,
): Promise<{ ok: true } | { ok: false; status: number; message: string; code?: string }> {
  try {
    const r = await signedFetch(creds, "PUT", key, {}, body, contentType, timeoutMs);
    if (!r.ok) {
      const text = await r.text();
      return { ok: false, status: r.status, message: text.slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, message: msg.slice(0, 200), code: "s3_network" };
  }
}

export async function s3DeleteObject(
  creds: S3Creds,
  key: string,
  timeoutMs = 15_000,
): Promise<void> {
  const response = await signedFetch(creds, "DELETE", key, {}, null, undefined, timeoutMs);
  if (!response.ok) {
    throw new Error(`S3 DELETE failed: HTTP ${response.status}`);
  }
}

export function classifyS3Error(status: number, message: string): string {
  const low = message.toLowerCase();
  if (!status || low.includes("timed out") || low.includes("abort") || low.includes("network")) {
    return "s3_network";
  }
  if (status === 403 || low.includes("access denied") || low.includes("forbidden")) {
    return low.includes("signature") || low.includes("invalidaccesskey")
      ? "s3_auth"
      : "s3_forbidden";
  }
  if (status === 404 || low.includes("nosuchbucket")) return "s3_not_found";
  if (status === 401 || low.includes("invalidaccesskey") || low.includes("signature")) {
    return "s3_auth";
  }
  return "s3_network";
}
