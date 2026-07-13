#!/usr/bin/env node

import http from "node:http";
import { pathToFileURL } from "node:url";

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizePath(value) {
  return decodeURIComponent(String(value || ""))
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function webdavListing(pathname, files) {
  const directory = normalizePath(pathname);
  const directoryHref = directory ? `/${directory}/` : "/";
  const responses = [
    `<d:response><d:href>${xmlEscape(directoryHref)}</d:href><d:propstat><d:prop><d:displayname>${xmlEscape(
      directory || "/",
    )}</d:displayname><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
  ];
  for (const file of [...files.keys()].sort()) {
    if (directory && !file.startsWith(`${directory}/`)) continue;
    const relative = directory ? file.slice(directory.length + 1) : file;
    if (!relative || relative.includes("/")) continue;
    responses.push(
      `<d:response><d:href>/${xmlEscape(file)}</d:href><d:propstat><d:prop><d:displayname>${xmlEscape(
        relative,
      )}</d:displayname><d:resourcetype/><d:getcontentlength>${files.get(file).length}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
    );
  }
  return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses.join("")}</d:multistatus>`;
}

function s3Listing(objects, prefix, maxKeys) {
  const selected = [...objects.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, maxKeys);
  const contents = selected
    .map(
      ([key, object]) =>
        `<Contents><Key>${xmlEscape(key)}</Key><LastModified>${xmlEscape(
          object.lastModified,
        )}</LastModified><ETag>&quot;fake-etag&quot;</ETag><Size>${object.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><KeyCount>${selected.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>${contents}</ListBucketResult>`;
}

export function createFakeRemoteProvider({ host = "127.0.0.1", port }) {
  if (!Number.isInteger(port) || port < 1) throw new Error("port must be a positive integer");

  const state = {
    bucket: "markhub-test",
    webdavFiles: new Map(),
    s3Objects: new Map(),
    failWebdavDelete: new Set(),
    failS3Delete: new Set(),
    failWebdavPut: false,
    failS3Put: false,
    failWebdavList: false,
    failS3List: false,
    requests: [],
  };

  const reset = (body = {}) => {
    state.bucket = String(body.bucket || "markhub-test");
    state.webdavFiles = new Map(
      (body.webdav_files || []).map((file) => [normalizePath(file), Buffer.from("fake")]),
    );
    state.s3Objects = new Map(
      (body.s3_objects || []).map((object) => [
        normalizePath(object.key),
        {
          body: Buffer.from(object.body || "fake"),
          lastModified: object.last_modified || "2020-01-01T00:00:00.000Z",
        },
      ]),
    );
    state.failWebdavDelete = new Set((body.fail_webdav_delete || []).map(normalizePath));
    state.failS3Delete = new Set((body.fail_s3_delete || []).map(normalizePath));
    state.failWebdavPut = Boolean(body.fail_webdav_put);
    state.failS3Put = Boolean(body.fail_s3_put);
    state.failWebdavList = Boolean(body.fail_webdav_list);
    state.failS3List = Boolean(body.fail_s3_list);
    state.requests = [];
  };

  const snapshot = () => ({
    bucket: state.bucket,
    webdav_files: [...state.webdavFiles.keys()].sort(),
    s3_objects: [...state.s3Objects.keys()].sort(),
    requests: [...state.requests],
  });

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${host}:${port}`);
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === "/__health") return json(response, 200, { ok: true });
      if (pathname === "/__control/reset" && request.method === "POST") {
        const raw = await readBody(request);
        reset(raw.length ? JSON.parse(raw.toString("utf8")) : {});
        return json(response, 200, snapshot());
      }
      if (pathname === "/__control/state" && request.method === "GET") {
        return json(response, 200, snapshot());
      }

      const authorization = request.headers.authorization || "";
      const s3Request =
        authorization.startsWith("AWS4-HMAC-SHA256 ") ||
        url.searchParams.get("list-type") === "2";
      const normalized = normalizePath(pathname);
      state.requests.push({ method: request.method, path: pathname, provider: s3Request ? "s3" : "webdav" });

      if (s3Request) {
        const bucketPrefix = `${state.bucket}/`;
        const key = normalized.startsWith(bucketPrefix)
          ? normalized.slice(bucketPrefix.length)
          : "";
        if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
          if (state.failS3List) return json(response, 503, { error: "fake S3 list failure" });
          const prefix = url.searchParams.get("prefix") || "";
          const maxKeys = Math.max(1, Number(url.searchParams.get("max-keys") || 1000));
          response.writeHead(200, { "Content-Type": "application/xml" });
          return response.end(s3Listing(state.s3Objects, prefix, maxKeys));
        }
        if (request.method === "PUT") {
          if (state.failS3Put) return json(response, 503, { error: "fake S3 upload failure" });
          state.s3Objects.set(key, {
            body: await readBody(request),
            lastModified: new Date().toISOString(),
          });
          response.writeHead(200, { ETag: '"fake-etag"' });
          return response.end();
        }
        if (request.method === "DELETE") {
          if (state.failS3Delete.has(key)) {
            return json(response, 503, { error: "fake S3 delete failure" });
          }
          state.s3Objects.delete(key);
          response.writeHead(204);
          return response.end();
        }
        return json(response, 404, { error: "unknown fake S3 route" });
      }

      if (request.method === "HEAD") {
        response.writeHead(200);
        return response.end();
      }
      if (request.method === "PROPFIND") {
        if (state.failWebdavList) return json(response, 503, { error: "fake WebDAV list failure" });
        response.writeHead(207, { "Content-Type": "application/xml" });
        return response.end(webdavListing(pathname, state.webdavFiles));
      }
      if (request.method === "PUT") {
        if (state.failWebdavPut) return json(response, 503, { error: "fake WebDAV upload failure" });
        state.webdavFiles.set(normalized, await readBody(request));
        response.writeHead(201);
        return response.end();
      }
      if (request.method === "DELETE") {
        const name = normalized.split("/").at(-1) || normalized;
        if (state.failWebdavDelete.has(normalized) || state.failWebdavDelete.has(name)) {
          return json(response, 503, { error: "fake WebDAV delete failure" });
        }
        state.webdavFiles.delete(normalized);
        response.writeHead(204);
        return response.end();
      }
      return json(response, 404, { error: "unknown fake WebDAV route" });
    } catch (error) {
      return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return {
    reset,
    snapshot,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      return `http://${host}:${port}`;
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function parseArgs(argv) {
  const options = { host: "127.0.0.1", port: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--host") options.host = argv[++index];
    else if (argv[index] === "--port") options.port = Number(argv[++index]);
    else throw new Error(`unknown argument ${argv[index]}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const provider = createFakeRemoteProvider(parseArgs(process.argv.slice(2)));
  const url = await provider.start();
  console.log(`FAKE_REMOTE_PROVIDER_READY ${url}`);
  const stop = async () => {
    await provider.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
