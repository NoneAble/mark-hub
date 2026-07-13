import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(SCRIPT_DIR, "../../..");
const WEB_DIR = path.join(REPO_DIR, "apps/web");

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export async function buildTempSpa(outDir, marker) {
  const resolvedOut = path.resolve(outDir);
  assert.ok(!isWithin(REPO_DIR, resolvedOut), `SPA output must be outside the repository: ${resolvedOut}`);
  assert.ok(marker, "a non-empty SPA marker is required");

  const require = createRequire(import.meta.url);
  const viteUrl = pathToFileURL(require.resolve("vite", { paths: [WEB_DIR] })).href;
  const reactUrl = pathToFileURL(
    require.resolve("@vitejs/plugin-react", { paths: [WEB_DIR] }),
  ).href;
  const { build } = await import(viteUrl);
  const { default: react } = await import(reactUrl);

  await build({
    root: WEB_DIR,
    configFile: false,
    plugins: [react()],
    resolve: {
      alias: {
        "@markhub/api-client": path.join(REPO_DIR, "packages/api-client/src/index.ts"),
        "@markhub/core": path.join(REPO_DIR, "packages/core/src/index.ts"),
        "@markhub/ui": path.join(REPO_DIR, "packages/ui/src/index.ts"),
        "@": path.join(WEB_DIR, "src"),
      },
    },
    build: {
      outDir: resolvedOut,
      emptyOutDir: true,
    },
  });

  const indexPath = path.join(resolvedOut, "index.html");
  const index = await fs.readFile(indexPath, "utf8");
  assert.match(index, /<div id="root"><\/div>/, "built SPA root marker missing");
  const marked = index.replace(
    "</head>",
    `    <meta name="markhub-asset-harness" content="${marker}" />\n  </head>`,
  );
  assert.notEqual(marked, index, "could not inject the temporary SPA marker");
  await fs.writeFile(indexPath, marked, "utf8");
  return { indexPath, outDir: resolvedOut, marker };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildTempSpa(process.argv[2] || "", process.argv[3] || "");
}
