import 'dotenv/config';
import { createApp } from './app.js';
import { runBootTasks } from './boot.js';
import { logger } from './utils/logger.js';
import { port } from './utils/config.js';

const app = createApp();
const PORT = port();

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  logger.info(`OrbitWatch backend listening on port ${PORT}`);
  await runBootTasks();
});

export default app;
