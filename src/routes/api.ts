import type { FastifyInstance, FastifyReply } from "fastify";

import { listFiles, readSourceFile } from "../fs.js";
import type { SourceConfig, SourceRoute } from "../types.js";
import { sendFsError, sendUnknownSource } from "./errors.js";

/**
 * Owns the entire `/api/${pattern}/...` URL space for each source route:
 * each configured source, and the short-link namespace.
 *
 * Two routes per source route:
 *   /api/${pattern}/    — source-root listing
 *   /api/${pattern}/*   — catch-all dispatching by suffix:
 *                          trailing slash → sub-directory listing
 *                          .md            → raw markdown
 *                          .html          → raw HTML
 *                          otherwise      → 404
 *
 * Fastify rejects duplicate method+path registrations, so the bare
 * source-root route must be registered as its own narrow route rather
 * than handled inside the wildcard.
 */
export function registerApiRoutes(
  app: FastifyInstance,
  routes: SourceRoute[],
): void {
  for (const route of routes) {
    app.get<{ Params: Record<string, string> }>(
      `/api${route.pattern}/`,
      async (request, reply) => {
        const source = route.lookup(request.params);
        if (source === undefined) return sendUnknownSource(reply);
        return sendListing(reply, source, "");
      },
    );

    app.get<{ Params: Record<string, string> }>(
      `/api${route.pattern}/*`,
      async (request, reply) => {
        const source = route.lookup(request.params);
        if (source === undefined) return sendUnknownSource(reply);
        const captured = request.params["*"];

        if (captured.endsWith("/")) {
          return sendListing(reply, source, captured.replace(/\/+$/, ""));
        }

        const contentType = captured.endsWith(".md")
          ? "text/markdown; charset=utf-8"
          : captured.endsWith(".html")
            ? "text/html; charset=utf-8"
            : undefined;

        if (contentType === undefined) {
          return reply
            .status(404)
            .send({ error: "Only .md and .html files are served" });
        }

        try {
          const content = await readSourceFile(source.root, captured);
          // Hosted HTML carries its own inline scripts/styles that cannot
          // be nonce-tagged, so the strict CSP is dropped for raw HTML.
          if (captured.endsWith(".html")) {
            void reply.removeHeader("Content-Security-Policy");
          }
          return reply.header("Content-Type", contentType).send(content);
        } catch (error: unknown) {
          return sendFsError(reply, error, captured);
        }
      },
    );
  }
}

async function sendListing(
  reply: FastifyReply,
  source: SourceConfig,
  subPath: string,
) {
  try {
    const entries = await listFiles(source.root, subPath);
    const mapped = entries.map((entry) => ({
      ...entry,
      path: `/${source.prefix}/${entry.path}`,
    }));
    return reply.send(mapped);
  } catch (error: unknown) {
    return sendFsError(reply, error, subPath);
  }
}
