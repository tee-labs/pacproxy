import * as dns from 'dns';
import * as os from 'os';
import { isIPv4 } from 'net';

export interface Nower {
  now(): Date;
}

export class TimeNower implements Nower {
  now(): Date {
    return new Date();
  }
}

export class StaticNower implements Nower {
  constructor(private readonly _now: Date) {}
  now(): Date {
    return this._now;
  }
}

export let defaultNower: Nower = new TimeNower();

export function setDefaultNower(nower: Nower): void {
  defaultNower = nower;
}

export function restoreDefaultNower(): void {
  defaultNower = new TimeNower();
}

const WEEKDAY_MAP: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const MONTH_MAP: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

export function convertAddr(ipaddr: string): number {
  if (!isIPv4(ipaddr)) return 0;
  const parts = ipaddr.split('.');
  if (parts.length !== 4) return 0;
  let result = 0;
  for (let i = 0; i < 4; i++) {
    result = (result << 8) + parseInt(parts[i], 10);
  }
  return result >>> 0;
}

export function dnsDomainIs(host: string, domain: string): boolean {
  if (host.length < domain.length) return false;
  return host.endsWith(domain);
}

export function shExpMatch(str: string, shexp: string): boolean {
  let pattern = shexp.replace(/\./g, '\\.');
  pattern = pattern.replace(/\?/g, '.');
  pattern = pattern.replace(/\*/g, '.*');
  const regex = new RegExp('^' + pattern + '$');
  return regex.test(str);
}

export function isInNet(host: string, netip: string, netmask: string): boolean {
  if (host.length === 0) return false;
  let ip = host;
  if (!isIPv4(ip)) {
    ip = dnsResolve(host);
    if (!ip) return false;
  }
  const hostAddr = convertAddr(ip);
  if (hostAddr === 0) return false;
  const netAddr = convertAddr(netip);
  const mask = convertAddr(netmask);
  return (hostAddr & mask) === (netAddr & mask);
}

export function myIPAddress(): string {
  const hostname = os.hostname();
  return dnsResolve(hostname);
}

export function dnsResolve(host: string): string {
  const interfaces = os.networkInterfaces();
  if (host === 'localhost') return '127.0.0.1';
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4') {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
}

export function isPlainHostName(host: string): boolean {
  return !host.includes('.');
}

export function localHostOrDomainIs(host: string, hostdom: string): boolean {
  if (host === hostdom) return true;
  return hostdom.startsWith(host + '.');
}

export function isResolvable(host: string): boolean {
  if (host.length === 0) return false;
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4') {
        return true;
      }
    }
  }
  return false;
}

export function dnsDomainLevels(host: string): number {
  let count = 0;
  for (let i = 0; i < host.length; i++) {
    if (host[i] === '.') count++;
  }
  return count;
}

export function weekdayRange(wd1: string, wd2: string, gmt: string): boolean {
  wd1 = wd1.toUpperCase();
  wd2 = wd2.toUpperCase();
  gmt = gmt.toUpperCase();

  if (wd2 === 'GMT') {
    wd2 = '';
    gmt = 'GMT';
  }
  if (wd2 === '') {
    wd2 = wd1;
  }

  let now = defaultNower.now();
  if (gmt === 'GMT') {
    now = new Date(now.toISOString());
  }
  const today = now.getDay();

  const weekday1 = WEEKDAY_MAP[wd1];
  const weekday2 = WEEKDAY_MAP[wd2];
  if (weekday1 === undefined || weekday2 === undefined) return false;

  if (weekday1 === weekday2 && weekday1 === today) return true;

  let lo = weekday1;
  let hi = weekday2;
  if (lo > hi) {
    [lo, hi] = [hi, lo];
  }
  return lo <= today && today <= hi;
}

export function dateRange(...args: string[]): boolean {
  let argc = args.length;
  if (argc < 1) return false;

  for (let k = 0; k < argc; k++) {
    args[k] = args[k].toUpperCase();
  }

  let now = defaultNower.now();
  const isGMT = args[argc - 1] === 'GMT';
  if (isGMT) {
    argc--;
    now = new Date(now.toISOString());
  }

  if (argc === 1) {
    const tmp = parseInt(args[0], 10);
    if (isNaN(tmp)) {
      return now.getMonth() === MONTH_MAP[args[0]];
    } else if (tmp <= 31) {
      return now.getDate() === tmp;
    } else {
      return now.getFullYear() === tmp;
    }
  }

  const getMonth = (name: string): number => {
    return MONTH_MAP[name] ?? -1;
  };

  let date1 = new Date(now.getTime());
  for (let i = 0; i < Math.floor(argc / 2); i++) {
    const tmp = parseInt(args[i], 10);
    if (isNaN(tmp)) {
      const m = getMonth(args[i]);
      if (m === -1) return false;
      date1 = new Date(date1.getFullYear(), m, date1.getDate(),
        date1.getHours(), date1.getMinutes(), date1.getSeconds(), date1.getMilliseconds());
    } else if (tmp <= 31) {
      date1 = new Date(date1.getFullYear(), date1.getMonth(), tmp,
        date1.getHours(), date1.getMinutes(), date1.getSeconds(), date1.getMilliseconds());
    } else {
      date1 = new Date(tmp, date1.getMonth(), date1.getDate(),
        date1.getHours(), date1.getMinutes(), date1.getSeconds(), date1.getMilliseconds());
    }
  }

  let date2 = new Date(now.getTime());
  for (let i = Math.floor(argc / 2); i < argc; i++) {
    const tmp = parseInt(args[i], 10);
    if (isNaN(tmp)) {
      const m = getMonth(args[i]);
      if (m === -1) return false;
      date2 = new Date(date2.getFullYear(), m, date2.getDate(),
        date2.getHours(), date2.getMinutes(), date2.getSeconds(), date2.getMilliseconds());
    } else if (tmp <= 31) {
      date2 = new Date(date2.getFullYear(), date2.getMonth(), tmp,
        date2.getHours(), date2.getMinutes(), date2.getSeconds(), date2.getMilliseconds());
    } else {
      date2 = new Date(tmp, date2.getMonth(), date2.getDate(),
        date2.getHours(), date2.getMinutes(), date2.getSeconds(), date2.getMilliseconds());
    }
  }

  const nano = now.getTime();
  let nano1 = date1.getTime();
  let nano2 = date2.getTime();
  if (nano2 < nano1) {
    [nano1, nano2] = [nano2, nano1];
  }
  return nano1 <= nano && nano <= nano2;
}

export function timeRange(...args: string[]): boolean {
  let argc = args.length;
  if (argc < 1) return false;

  for (let k = 0; k < argc; k++) {
    args[k] = args[k].toUpperCase();
  }

  let now = defaultNower.now();
  const isGMT = args[argc - 1] === 'GMT';
  if (isGMT) {
    argc--;
    now = new Date(now.toISOString());
  }

  let date1 = new Date(now.getTime());
  let date2 = new Date(now.getTime());

  if (argc === 1) {
    const tmp = parseInt(args[0], 10);
    if (isNaN(tmp)) return false;
    return now.getHours() === tmp;
  }

  if (argc === 2) {
    const tmp1 = parseInt(args[0], 10);
    const tmp2 = parseInt(args[1], 10);
    if (isNaN(tmp1) || isNaN(tmp2)) return false;
    let lo = tmp1;
    let hi = tmp2;
    if (hi < lo) [lo, hi] = [hi, lo];
    return lo <= now.getHours() && now.getHours() < hi;
  }

  if (argc === 6) {
    const s1 = parseInt(args[2], 10);
    const s2 = parseInt(args[5], 10);
    if (isNaN(s1) || isNaN(s2)) return false;
    date1 = new Date(date1.getFullYear(), date1.getMonth(), date1.getDate(),
      date1.getHours(), date1.getMinutes(), s1, date1.getMilliseconds());
    date2 = new Date(date2.getFullYear(), date2.getMonth(), date2.getDate(),
      date2.getHours(), date2.getMinutes(), s2, date2.getMilliseconds());
  }

  if (argc === 4 || argc === 6) {
    const middle = Math.floor(argc / 2);
    const h1 = parseInt(args[0], 10);
    const m1 = parseInt(args[1], 10);
    const h2 = parseInt(args[middle], 10);
    const m2 = parseInt(args[middle + 1], 10);
    if (isNaN(h1) || isNaN(m1) || isNaN(h2) || isNaN(m2)) return false;

    const sec1 = argc === 6 ? date1.getSeconds() : 0;
    const sec2 = argc === 6 ? date2.getSeconds() : 0;

    date1 = new Date(date1.getFullYear(), date1.getMonth(), date1.getDate(),
      h1, m1, sec1, date1.getMilliseconds());
    date2 = new Date(date2.getFullYear(), date2.getMonth(), date2.getDate(),
      h2, m2, sec2, date2.getMilliseconds());
  } else {
    return false;
  }

  const nano = now.getTime();
  let nano1 = date1.getTime();
  let nano2 = date2.getTime();
  if (nano2 < nano1) {
    [nano1, nano2] = [nano2, nano1];
  }
  return nano1 <= nano && nano < nano2;
}
