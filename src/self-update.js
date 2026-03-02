import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BINARY_PATH = join(__dirname, '..', 'tools', 'self-update', 'target', 'release', 'temper-self-update');

/**
 * Spawns the compiled self-update binary as a detached process, then returns
 * immediately so the webhook response can complete before the process restarts.
 *
 * @param {object} logger - Pino-compatible logger
 */
export function triggerSelfUpdate(logger) {
  logger.info('Spawning self-update binary');

  const child = spawn(BINARY_PATH, [], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TEMPER_PID: String(process.pid),
      TEMPER_REPO_DIR: join(__dirname, '..')
    }
  });

  child.unref();
}
