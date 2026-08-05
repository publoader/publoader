import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { AppContext } from "./context.js";
import { registerWorkerRoutes } from "./routes/worker.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerTokenRoutes } from "./routes/tokens.js";
import { registerOpsRoutes } from "./routes/ops.js";
import { registerQueueRoutes } from "./routes/queues.js";
import { registerSysopsRoutes } from "./routes/sysops.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerSessionRoutes } from "./session.js";
import { registerMangadexLoginRoutes } from "./mangadexLogin.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerDashboardRoutes } from "./dashboard.js";

/**
 * The control-plane HTTP server. Public entry is expected to be fronted by
 * TLS (cloudflared tunnel at https://publoader.ardax.dev or a reverse proxy);
 * the server itself binds an internal port only.
 *
 * Security defaults baked in:
 *  - request-id on every request/response (correlation)
 *  - conservative security headers
 *  - 1 MiB default body limit (routes opt into larger, capped limits)
 *  - binary parsers only for the exact content types that need them
 *  - /healthz and /readyz are unauthenticated and intended for container
 *    probes and the internal network. /metrics is deliberately NOT served here:
 *    it is on the internal-only METRICS_PORT (see services/api.ts), because the
 *    tunnel forwards EVERY path on the public hostname, and queue depths,
 *    worker names and failure counts are not public information.
 *  - /dash serves the operator dashboard (static, CSP-locked); it is the only
 *    browser-facing surface and authenticates via /api/v1/admin/session.
 */
export function buildServer(ctx: AppContext): FastifyInstance {
  // Cast away the pino-instance generic: fastify narrows its logger type
  // parameter when given a concrete pino logger, which makes the instance
  // incompatible with plugin signatures typed against FastifyBaseLogger.
  const app = Fastify({
    loggerInstance: ctx.log.child({ component: "api" }),
    bodyLimit: 1024 * 1024,
    genReqId: () => randomUUID(),
    // Exactly ONE hop is trusted (the tunnel/reverse proxy in front). `true`
    // would make req.ip the leftmost X-Forwarded-For entry, which is supplied by
    // the client — defeating every IP-keyed rate limit (login, admin-token
    // guessing, worker enrollment) and letting an attacker write arbitrary
    // source addresses into the audit trail.
    trustProxy: 1,
  }) as unknown as FastifyInstance;

  // Many admin actions take no body (resume, drain, revoke, skip, retry…).
  // Fastify's default JSON parser rejects an empty body outright when the
  // client sets `content-type: application/json`, which most HTTP clients do
  // by default — so a perfectly correct call would 400. Treat empty as {}.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const text = typeof body === "string" ? body.trim() : "";
      if (text.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        const failure = err as Error & { statusCode?: number };
        failure.statusCode = 400;
        done(failure, undefined);
      }
    },
  );

  // Raw-binary parsing for artifact/bundle uploads only.
  for (const type of ["application/zip", "application/octet-stream", "image/png", "image/jpeg", "image/gif", "image/webp"]) {
    app.addContentTypeParser(type, { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  }

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_req, reply) => {
    try {
      await ctx.prisma.$queryRawUnsafe("SELECT 1");
    } catch {
      // Bare boolean on the public port: the reason is available on the
      // internal metrics port, where the caller is already trusted.
      return reply.code(503).send({ ok: false });
    }
    return { ok: true };
  });


  registerWorkerRoutes(app, ctx);
  // Session login/logout and the OAuth dance are the authentication step, so
  // they register outside the admin scope and guard themselves with the
  // per-IP login limiter.
  registerSessionRoutes(app, ctx);
  registerMangadexLoginRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerTokenRoutes(app, ctx);
  registerOpsRoutes(app, ctx);
  registerQueueRoutes(app, ctx);
  registerSysopsRoutes(app, ctx);
  // Unauthenticated on purpose: the GitHub HMAC signature is the credential,
  // so this must NOT sit inside the admin scope.
  registerWebhookRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerDashboardRoutes(app);

  app.setErrorHandler((err: FastifyError, req, reply) => {
    req.log.error({ err }, "request failed");
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    // Never leak stack traces or internals to clients.
    reply.code(status).send({ error: status >= 500 ? "internal error" : err.message });
  });

  return app;
}
