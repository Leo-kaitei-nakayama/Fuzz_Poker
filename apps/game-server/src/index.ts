import { createServer } from "./server.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const server = createServer(config);

void server.ready.then(() => {
  // eslint-disable-next-line no-console
  console.log(
    `🎴 Cute Poker game server listening on http://${config.host}:${server.port}` +
      ` (db: ${config.dbPath}, mode: ${config.fast ? "fast" : "normal"})`,
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    // eslint-disable-next-line no-console
    console.log(`\n${sig} received, shutting down...`);
    void server.close().then(() => process.exit(0));
  });
}
