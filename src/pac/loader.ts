import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { Loader } from './types';
import { parseFindProxyString } from './parse';
import { Logger } from '../logger';

export function smartLoader(thing: string, logger?: Logger): Loader {
  const log = logger ?? new Logger(false);
  return (): string => {
    // Try as inline PAC result string
    try {
      parseFindProxyString(thing);
      log.info('Loaded PAC as inline proxy string');
      return `function FindProxyForURL(url, host){ return ${JSON.stringify(thing)}; }`;
    } catch {
    }

    // Try as raw JavaScript
    if (thing.includes('FindProxyForURL') && thing.includes('{')) {
      log.info('Loaded PAC as inline JavaScript');
      return thing;
    }

    // Try as URL
    try {
      const parsed = new URL(thing);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        log.info('Loading PAC from URL:', thing);
        return httpLoader(parsed, logger)();
      }
    } catch {
    }

    // Fallback to file
    log.info('Loading PAC from file:', thing);
    return fileLoader(thing)();
  };
}

export function fileLoader(file: string): Loader {
  return (): string => {
    return fs.readFileSync(file, 'utf-8');
  };
}

export function httpLoader(u: URL, logger?: Logger): Loader {
  const log = logger ?? new Logger(false);
  return (): string => {
    const client = u.protocol === 'https:' ? https : http;
    const chunks: Buffer[] = [];
    let done = false;
    let err: Error | null = null;
    let statusCode = 0;

    const req = client.get(u.toString(), (res) => {
      statusCode = res.statusCode || 0;
      log.debug(`HTTP response status: ${statusCode} from ${u.toString()}`);
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => { done = true; });
    });
    req.on('error', (e) => { err = e; done = true; });
    req.end();

    const start = Date.now();
    while (!done) {
      if (Date.now() - start > 30000) {
        const msg = `Timeout loading PAC from URL ${u}`;
        log.error(msg);
        throw new Error(msg);
      }
    }

    if (err) {
      log.error('Failed to load PAC from URL:', err);
      throw err;
    }

    const content = Buffer.concat(chunks).toString('utf-8');
    const elapsed = Date.now() - start;
    log.info(`Loaded PAC from ${u.toString()} (${content.length} bytes, ${elapsed}ms, status ${statusCode})`);
    return content;
  };
}

export function stringLoader(pac: string): Loader {
  return (): string => pac;
}
