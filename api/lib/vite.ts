/**
 * Production static-file server for the Vite build output (dist/public),
 * with SPA fallback to index.html.
 *
 * Registered LAST (after every /api/* route) by boot.ts. Content-Types are
 * mapped explicitly — notably `.wav` must be served as audio/wav because
 * Twilio rejects octet-stream audio with error 12300 (see boot.ts comment and
 * the /api/verify/tone.wav route).
 */
import fs from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHono = Hono<any>;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav", // Twilio <Play> refuses octet-stream (error 12300)
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};

function contentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** Resolve dist/public both from the esbuild bundle (dist/boot.js) and from
 *  a tsx/dev process rooted at the repo. */
function resolvePublicDir(): string {
  const candidates = [
    path.resolve(import.meta.dirname, "public"), // dist/boot.js → dist/public
    path.resolve(import.meta.dirname, "..", "dist", "public"), // api/lib/vite.ts (tsx)
    path.resolve(process.cwd(), "dist", "public"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return candidates[0];
}

function sendFile(c: Context, file: string) {
  const buf = fs.readFileSync(file);
  return c.body(new Uint8Array(buf), 200, {
    "Content-Type": contentType(file),
    "Cache-Control": file.includes(`${path.sep}assets${path.sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });
}

export function serveStaticFiles(app: AnyHono): void {
  const root = resolvePublicDir();

  app.get("*", (c) => {
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    // Prevent path traversal.
    const rel = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
    let file = path.join(root, rel);
    if (!file.startsWith(root)) file = path.join(root, "index.html");

    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return sendFile(c, file);
    }
    // SPA fallback — client-side router owns all non-/api paths.
    return sendFile(c, path.join(root, "index.html"));
  });
}
