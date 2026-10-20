// Bundle the server (and its workspace TS deps) into a single ESM file so the
// production image needs only `node dist/server.js`. Node builtins (including
// node:sqlite) stay external automatically for the node platform.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/server.js",
  banner: {
    // Allow bundled CJS deps (ws) to use require() under ESM.
    js: "import { createRequire as _cr } from 'node:module'; const require = _cr(import.meta.url);",
  },
  logLevel: "info",
});
