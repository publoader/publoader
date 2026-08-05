import { loadConfig } from "../config.js";
import { createLogger } from "../logging.js";
import { getPrisma } from "../db.js";
import { buildContext } from "../core/api/context.js";
import { buildServer } from "../core/api/server.js";
import { MdClient } from "../core/md/client.js";
import { DiscordNotifier } from "../core/md/webhook.js";
import { TitleService } from "../core/md/titleService.js";
import { startMetricsServer } from "../core/observability/metricsServer.js";

const config = loadConfig();
const log = createLogger("core-api", config.logLevel);
const prisma = getPrisma(config.databaseUrl);
const ctx = buildContext(prisma, config, log);
// The API holds MD credentials in the same env as the uploader, so operator
// approvals of untracked series can create titles synchronously. Without
// credentials the endpoint reports 503 and auto-creation still runs in the
// uploader service.
if (config.mdUsername && config.mdPassword) {
  const md = new MdClient(config, prisma, log);
  const notifier = DiscordNotifier.fromConfig(config, log);
  ctx.titleService = new TitleService(prisma, md, notifier, log);
}
const server = buildServer(ctx);

/**
 * Make sure there is always a way in. A fresh database has no accounts, so
 * without this the dashboard would be reachable only with the break-glass
 * admin token forever.
 */
const seedOwner = async (): Promise<void> => {
  const owner = await ctx.adminUsers.ensureOwner(config.dashOwnerEmail);
  log.info(
    {
      email: owner.email,
      hasPassword: owner.passwordHash !== null,
      mangadexLinked: owner.mangadexId !== null,
    },
    owner.passwordHash === null && owner.mangadexId === null
      ? "owner account has no credentials yet: sign in with ADMIN_TOKEN and set a password from the Users view"
      : "owner account ready",
  );
};

/**
 * Metrics live on a SECOND, internal-only port — never on the public one.
 *
 * `config.port` is what the Cloudflare tunnel's Public Hostname points at, and
 * cloudflared forwards every path on that hostname. A /metrics route on that
 * port is therefore world-readable at https://<hostname>/metrics unless an edge
 * rule happens to block it, and it names every extension, queue depth, worker
 * and failure count. Edge rules are one forgotten click away from being absent;
 * a separate port that nothing routes to is not.
 *
 * /healthz and /readyz stay on both ports: they return a bare boolean, and the
 * container healthcheck plus compose `depends_on` already use the public one.
 */
const metricsServer = await startMetricsServer({
  service: "core-api",
  log,
  prisma,
  defaultPort: 8104,
});

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await server.close();
  await metricsServer.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

seedOwner()
  .then(() => server.listen({ port: config.port, host: config.host }))
  .then(() => log.info({ port: config.port }, "core-api listening"))
  .catch((err) => {
    log.error({ err }, "failed to start");
    process.exit(1);
  });
