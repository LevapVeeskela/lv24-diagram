import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let assetDir: string | undefined;

function swaggerAssetDir(): string {
  assetDir ??= dirname(require.resolve("swagger-ui-dist/package.json"));
  return assetDir;
}

const ASSETS: Readonly<Record<string, { file: string; type: string }>> = {
  "/docs/swagger-ui.css": { file: "swagger-ui.css", type: "text/css; charset=utf-8" },
  "/docs/swagger-ui-bundle.js": {
    file: "swagger-ui-bundle.js",
    type: "text/javascript; charset=utf-8",
  },
};

const cache = new Map<string, Buffer>();

/** Whitelisted swagger-ui-dist assets; nothing else is read from the package. */
export async function readSwaggerAsset(
  path: string,
): Promise<{ body: Buffer; contentType: string } | undefined> {
  const asset = ASSETS[path];
  if (!asset) return undefined;
  const cached = cache.get(path);
  if (cached) return { body: cached, contentType: asset.type };
  const body = await readFile(join(swaggerAssetDir(), asset.file));
  cache.set(path, body);
  return { body, contentType: asset.type };
}

export const SWAGGER_UI_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>diagram-api docs</title>
    <link rel="stylesheet" href="/docs/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/docs/swagger-ui-bundle.js"></script>
    <script>
      SwaggerUIBundle({ url: "/docs-json", dom_id: "#swagger-ui", deepLinking: true });
    </script>
  </body>
</html>
`;
