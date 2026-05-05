import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { Loader } from './types';
import { parseFindProxyString } from './parse';

export function smartLoader(thing: string): Loader {
  return (): string => {
    try {
      parseFindProxyString(thing);
      return `function FindProxyForURL(url, host){ return ${JSON.stringify(thing)}; }`;
    } catch {
    }

    if (thing.includes('FindProxyForURL') && thing.includes('{')) {
      return thing;
    }

    try {
      const parsed = new URL(thing);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return httpLoader(parsed)();
      }
    } catch {
    }

    return fileLoader(thing)();
  };
}

export function fileLoader(file: string): Loader {
  return (): string => {
    return fs.readFileSync(file, 'utf-8');
  };
}

export function httpLoader(u: URL): Loader {
  return (): string => {
    const client = u.protocol === 'https:' ? https : http;
    const chunks: Buffer[] = [];
    let done = false;
    let err: Error | null = null;

    const req = client.get(u.toString(), (res) => {
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => { done = true; });
    });
    req.on('error', (e) => { err = e; done = true; });
    req.end();

    const start = Date.now();
    while (!done) {
      if (Date.now() - start > 30000) {
        throw new Error(`Timeout loading PAC from URL ${u}`);
      }
    }

    if (err) throw err;
    return Buffer.concat(chunks).toString('utf-8');
  };
}

export function stringLoader(pac: string): Loader {
  return (): string => pac;
}
