import * as pacfunc from '../src/pacfunc';
import { StaticNower, restoreDefaultNower } from '../src/pacfunc';

describe('convertAddr', () => {
  it('should convert IPv4 addresses to integers', () => {
    expect(pacfunc.convertAddr('127.0.0.1')).toBe(2130706433);
    expect(pacfunc.convertAddr('10.56.23.193')).toBe(171448257);
  });

  it('should return 0 for invalid IPs', () => {
    expect(pacfunc.convertAddr('this is not an ip')).toBe(0);
    expect(pacfunc.convertAddr('')).toBe(0);
    expect(pacfunc.convertAddr('999.999.999.999')).toBe(0);
  });
});

describe('dnsDomainIs', () => {
  it('should match domain suffixes', () => {
    expect(pacfunc.dnsDomainIs('www.netscape.com', '.netscape.com')).toBe(true);
  });

  it('should reject non-matching hosts', () => {
    expect(pacfunc.dnsDomainIs('www', '.netscape.com')).toBe(false);
    expect(pacfunc.dnsDomainIs('www.mcom.com', '.netscape.com')).toBe(false);
  });
});

describe('shExpMatch', () => {
  it('should match shell expressions', () => {
    expect(pacfunc.shExpMatch('http://home.netscape.com/people/ari/index.html', '*/ari/*')).toBe(true);
  });

  it('should reject non-matching patterns', () => {
    expect(pacfunc.shExpMatch('http://home.netscape.com/people/montulli/index.html', '*/ari/*')).toBe(false);
  });
});

describe('isInNet', () => {
  it('should return false for empty host', () => {
    expect(pacfunc.isInNet('', '172.16.0.0', '255.240.0.0')).toBe(false);
  });

  it('should return true for IPs within subnet', () => {
    expect(pacfunc.isInNet('172.16.0.1', '172.16.0.0', '255.240.0.0')).toBe(true);
  });

  it('should return false for IPs outside subnet', () => {
    expect(pacfunc.isInNet('172.1.0.1', '172.16.0.0', '255.240.0.0')).toBe(false);
  });

  it('should handle localhost', () => {
    expect(pacfunc.isInNet('127.0.0.1', '127.0.0.0', '255.0.0.0')).toBe(true);
    expect(pacfunc.isInNet('127.1.2.3', '127.0.0.0', '255.0.0.0')).toBe(true);
  });

  it('should handle CIDR-like subnet ranges', () => {
    expect(pacfunc.isInNet('192.168.1.23', '192.168.1.24', '255.255.255.248')).toBe(false);
    expect(pacfunc.isInNet('192.168.1.24', '192.168.1.24', '255.255.255.248')).toBe(true);
    expect(pacfunc.isInNet('192.168.1.25', '192.168.1.24', '255.255.255.248')).toBe(true);
    expect(pacfunc.isInNet('192.168.1.30', '192.168.1.24', '255.255.255.248')).toBe(true);
    expect(pacfunc.isInNet('192.168.1.31', '192.168.1.24', '255.255.255.248')).toBe(true);
    expect(pacfunc.isInNet('192.168.1.32', '192.168.1.24', '255.255.255.248')).toBe(false);
  });
});

describe('dnsResolve', () => {
  it('should resolve localhost', () => {
    const ip = pacfunc.dnsResolve('localhost');
    expect(ip).toBeTruthy();
  });
});

describe('isPlainHostName', () => {
  it('should return true for hostnames without dots', () => {
    expect(pacfunc.isPlainHostName('internet')).toBe(true);
  });

  it('should return false for hostnames with dots', () => {
    expect(pacfunc.isPlainHostName('inter.net')).toBe(false);
  });
});

describe('localHostOrDomainIs', () => {
  it('should match exact hostnames', () => {
    expect(pacfunc.localHostOrDomainIs('www.example.com', 'www.example.com')).toBe(true);
  });

  it('should match subdomain hosts', () => {
    expect(pacfunc.localHostOrDomainIs('www.example', 'www.example.com')).toBe(true);
    expect(pacfunc.localHostOrDomainIs('www', 'www.example.com')).toBe(true);
  });

  it('should reject non-matching hosts', () => {
    expect(pacfunc.localHostOrDomainIs('www', 'example.com')).toBe(false);
    expect(pacfunc.localHostOrDomainIs('ftp', 'www.example.com')).toBe(false);
  });
});

describe('isResolvable', () => {
  it('should return false for empty host', () => {
    expect(pacfunc.isResolvable('')).toBe(false);
  });

  it('should return true for resolvable hosts', () => {
    expect(pacfunc.isResolvable('localhost')).toBe(true);
  });
});

describe('dnsDomainLevels', () => {
  it('should count dots in hostname', () => {
    expect(pacfunc.dnsDomainLevels('localhost')).toBe(0);
    expect(pacfunc.dnsDomainLevels('local.host')).toBe(1);
    expect(pacfunc.dnsDomainLevels('www.example.org')).toBe(2);
    expect(pacfunc.dnsDomainLevels('a.b.c.d.example.org')).toBe(5);
  });
});

const ny = 'America/New_York';

function makeSunday(): Date { return new Date(Date.UTC(2017, 11, 31, 0, 0, 0, 0)); }
function makeMonday(): Date { return new Date(Date.UTC(2018, 0, 1, 0, 0, 0, 0)); }
function makeTuesday(): Date { return new Date(Date.UTC(2018, 0, 2, 0, 0, 0, 0)); }
function makeWednesday(): Date { return new Date(Date.UTC(2018, 0, 3, 0, 0, 0, 0)); }
function makeThursday(): Date { return new Date(Date.UTC(2018, 0, 4, 0, 0, 0, 0)); }
function makeFriday(): Date { return new Date(Date.UTC(2018, 0, 5, 0, 0, 0, 0)); }
function makeSaturday(): Date { return new Date(Date.UTC(2018, 0, 6, 0, 0, 0, 0)); }

const weekdayRangeTests = [
  { now: makeSunday(), wd1: 'SUN', wd2: '', gmt: '', result: true },
  { now: makeMonday(), wd1: 'MON', wd2: '', gmt: '', result: true },
  { now: makeTuesday(), wd1: 'TUE', wd2: '', gmt: '', result: true },
  { now: makeWednesday(), wd1: 'WED', wd2: '', gmt: '', result: true },
  { now: makeThursday(), wd1: 'THU', wd2: '', gmt: '', result: true },
  { now: makeFriday(), wd1: 'FRI', wd2: '', gmt: '', result: true },
  { now: makeSaturday(), wd1: 'SAT', wd2: '', gmt: '', result: true },
  { now: makeMonday(), wd1: 'x', wd2: '', gmt: '', result: false },
  { now: makeMonday(), wd1: 'x', wd2: 'y', gmt: '', result: false },
  { now: makeMonday(), wd1: 'x', wd2: 'y', gmt: 'z', result: false },
  { now: makeMonday(), wd1: '', wd2: '', gmt: '', result: false },
  { now: makeMonday(), wd1: 'SUN', wd2: '', gmt: '', result: false },
  { now: makeMonday(), wd1: 'SUN', wd2: 'MON', gmt: '', result: true },
  { now: makeMonday(), wd1: 'MON', wd2: 'SUN', gmt: '', result: true },
  { now: makeWednesday(), wd1: 'SUN', wd2: 'WED', gmt: '', result: true },
  { now: makeWednesday(), wd1: 'MON', wd2: 'WED', gmt: '', result: true },
  { now: makeWednesday(), wd1: 'WED', wd2: 'SAT', gmt: '', result: true },
  { now: makeWednesday(), wd1: 'WED', wd2: 'SUN', gmt: '', result: true },
  { now: makeWednesday(), wd1: 'SUN', wd2: 'TUE', gmt: '', result: false },
  { now: makeWednesday(), wd1: 'MON', wd2: 'TUE', gmt: '', result: false },
  { now: makeWednesday(), wd1: 'TUE', wd2: 'SAT', gmt: '', result: true },
  { now: makeWednesday(), wd1: 'TUE', wd2: 'SUN', gmt: '', result: false },
];

describe('weekdayRange', () => {
  afterEach(() => { restoreDefaultNower(); });

  it.each(weekdayRangeTests)(
    'weekdayRange($wd1, $wd2, $gmt) at $now should be $result',
    ({ now, wd1, wd2, gmt, result }) => {
      pacfunc.setDefaultNower(new StaticNower(now));
      expect(pacfunc.weekdayRange(wd1, wd2, gmt)).toBe(result);
    }
  );
});

function atTime(h: number, m: number, s: number): Date {
  return new Date(2018, 0, 1, h, m, s, 0);
}

const dateRangeTests = [
  { now: makeMonday(), args: [], result: false },
  { now: makeMonday(), args: ['FOO'], result: false },
  { now: makeMonday(), args: ['FOO', 'BAR'], result: false },
  { now: makeMonday(), args: ['1', 'BAR'], result: false },
  { now: makeMonday(), args: ['1'], result: true },
  { now: makeMonday(), args: ['JAN'], result: true },
  { now: makeMonday(), args: ['2018'], result: true },
  { now: makeMonday(), args: ['2'], result: false },
  { now: makeMonday(), args: ['FEB'], result: false },
  { now: makeMonday(), args: ['2019'], result: false },
  { now: makeWednesday(), args: ['3'], result: true },
  { now: makeWednesday(), args: ['3', 'JAN'], result: true },
  { now: makeWednesday(), args: ['JAN', '3'], result: true },
  { now: makeWednesday(), args: ['JAN', '2018'], result: true },
  { now: makeWednesday(), args: ['2018', 'JAN'], result: true },
  { now: makeWednesday(), args: ['2018', 'JAN', '3'], result: true },
  { now: makeWednesday(), args: ['3', 'JAN', '2018'], result: true },
  { now: makeWednesday(), args: ['JAN', '3', '2018'], result: true },
  { now: makeThursday(), args: ['1', '3'], result: false },
  { now: makeThursday(), args: ['1', '4'], result: true },
  { now: makeThursday(), args: ['4', '31'], result: true },
  { now: makeThursday(), args: ['5', '31'], result: false },
  { now: makeThursday(), args: ['1', 'JAN', '3', 'JAN'], result: false },
  { now: makeThursday(), args: ['1', 'JAN', '4', 'JAN'], result: true },
  { now: makeThursday(), args: ['4', 'JAN', '31', 'JAN'], result: true },
  { now: makeThursday(), args: ['5', 'JAN', '31', 'JAN'], result: false },
  { now: makeThursday(), args: ['1', 'JAN', '2018', '3', 'JAN'], result: false },
  { now: makeThursday(), args: ['1', 'JAN', '2018', '4', 'JAN'], result: true },
  { now: makeThursday(), args: ['4', 'JAN', '2018', '31', 'JAN'], result: true },
  { now: makeThursday(), args: ['5', 'JAN', '2018', '31', 'JAN'], result: false },
  { now: makeThursday(), args: ['1', 'JAN', '2018', '3', 'JAN', '2018'], result: false },
  { now: makeThursday(), args: ['1', 'JAN', '2018', '4', 'JAN', '2018'], result: true },
  { now: makeThursday(), args: ['4', 'JAN', '2018', '31', 'JAN', '2018'], result: true },
  { now: makeThursday(), args: ['5', 'JAN', '2018', '31', 'JAN', '2018'], result: false },
];

describe('dateRange', () => {
  afterEach(() => { restoreDefaultNower(); });

  it.each(dateRangeTests)(
    'dateRange(%o) at %j should be $result',
    ({ now, args, result }) => {
      pacfunc.setDefaultNower(new StaticNower(now));
      expect(pacfunc.dateRange(...args)).toBe(result);
    }
  );
});

const timeRangeTests = [
  { now: atTime(0, 0, 0), args: ['0'], result: true },
  { now: atTime(0, 0, 0), args: ['0', '1'], result: true },
  { now: atTime(12, 0, 0), args: ['12'], result: true },
  { now: atTime(12, 30, 0), args: ['12'], result: true },
  { now: atTime(12, 0, 0), args: ['12', '13'], result: true },
  { now: atTime(12, 30, 0), args: ['12', '13'], result: true },
  { now: atTime(13, 0, 0), args: ['12', '13'], result: false },
  { now: atTime(0, 0, 0), args: ['0', '0', '0', '0', '0', '30'], result: true },
  { now: atTime(0, 0, 15), args: ['0', '0', '0', '0', '0', '30'], result: true },
  { now: atTime(0, 0, 30), args: ['0', '0', '0', '0', '0', '30'], result: false },
  { now: atTime(1, 2, 3), args: ['1'], result: true },
  { now: atTime(1, 2, 3), args: ['1', '2'], result: true },
  { now: atTime(1, 2, 3), args: ['1', '2', '3', '4'], result: true },
  { now: atTime(1, 2, 3), args: ['1', '2', '3', '4', '5', '6'], result: true },
];

describe('timeRange', () => {
  afterEach(() => { restoreDefaultNower(); });

  it.each(timeRangeTests)(
    'timeRange(%o) at %j should be $result',
    ({ now, args, result }) => {
      pacfunc.setDefaultNower(new StaticNower(now));
      expect(pacfunc.timeRange(...args)).toBe(result);
    }
  );
});
