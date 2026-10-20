import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

export async function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error("payload too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid JSON body");
  }
}

/**
 * Serve a static file from `root`, guarding against path traversal. Falls back
 * to index.html for client-side routing (SPA). Returns true if handled.
 */
export async function serveStatic(
  root: string,
  urlPath: string,
  res: ServerResponse,
): Promise<boolean> {
  let rel = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  if (rel === "/" || rel === "") rel = "/index.html";
  const full = normalize(join(root, rel));
  if (!full.startsWith(normalize(root))) {
    res.writeHead(403).end("Forbidden");
    return true;
  }

  let target = full;
  try {
    const s = await stat(target);
    if (s.isDirectory()) target = join(target, "index.html");
  } catch {
    // Not found: fall back to SPA entry so the client router can handle it.
    target = join(root, "index.html");
  }

  try {
    const data = await readFile(target);
    const type = MIME[extname(target)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "content-length": data.length });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}
