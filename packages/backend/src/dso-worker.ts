import 'dotenv/config';
import { startDsoWorkerLoop } from './dso/worker/index.js';
import { logger } from './utils/logger.js';
import { hydrateDsoOnly } from './utils/storage/mirror-runtime.js';

async function main(): Promise<void> {
  // With a bucket mirror configured, restore dso/ from it first when this disk lacks it
  // (the ephemeris of a finished mission may not be re-fetchable). A no-op otherwise.
  await hydrateDsoOnly();

  const worker = startDsoWorkerLoop();

  function requestStop(signal: NodeJS.Signals): void {
    logger.info(`Received ${signal}; stopping DSO worker`);
    worker.stop();
  }

  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);

  worker.run.catch((error) => {
    logger.error('DSO worker exited with an unrecoverable error:', error);
    process.exitCode = 1;
  });
}

main().catch((error) => {
  logger.error('DSO worker could not start:', error);
  process.exitCode = 1;
});
