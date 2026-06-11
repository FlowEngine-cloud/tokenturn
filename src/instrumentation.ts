/**
 * Runs once when the server boots (after migrations, which the entrypoint
 * runs first). Ensures the secrets-at-rest key exists in the data volume on
 * first boot, so encryption never lazily fails mid-request.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { loadOrCreateSecretKey, secretKeyPath } = await import("./lib/secrets");
  const { logger } = await import("./lib/logger");
  loadOrCreateSecretKey();
  logger.info("secrets key ready", { file: secretKeyPath() });
}
