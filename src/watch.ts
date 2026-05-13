import * as fs from 'fs';
import { Logger } from './logger';
import { OttoEngine } from './pac/engine';

/**
 * Check if a string looks like a readable local file path.
 */
export function isLocalFile(pacPath: string): boolean {
  // Skip URLs
  if (pacPath.startsWith('http://') || pacPath.startsWith('https://')) {
    return false;
  }
  try {
    return fs.existsSync(pacPath);
  } catch {
    return false;
  }
}

/**
 * Watch a PAC file for changes, calling the engine reload on each change.
 *
 * @returns The FSWatcher instance, or null if the path couldn't be watched.
 */
export function setupFileWatcher(
  pacPath: string,
  engine: OttoEngine,
  logger: Logger,
): fs.FSWatcher | null {
  if (!isLocalFile(pacPath)) {
    logger.warn(`PAC file not found, cannot watch: ${pacPath}`);
    return null;
  }

  logger.info(`Watching PAC file for changes: ${pacPath}`);

  const watcher = fs.watch(pacPath, (eventType, filename) => {
    if (eventType === 'change') {
      logger.info(`PAC file changed${filename ? `: ${filename}` : ''}, reloading...`);
      try {
        engine.reload();
        logger.info('PAC reloaded successfully');
      } catch (err: any) {
        logger.error('Failed to reload PAC:', err);
      }
    }
  });

  return watcher;
}
