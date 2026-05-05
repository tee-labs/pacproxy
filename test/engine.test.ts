import { OttoEngine } from '../src/pac/engine';
import { DirectProxy } from '../src/pac/types';

function assertOtto(pac: string, url: string, expectedProxies: { hostname: string; port: number }[], expectedError: string): void {
  const engine = OttoEngine.withStringLoader(pac);
  engine.start();

  if (expectedError) {
    expect(() => engine.findProxyForURL(new URL(url))).toThrow(expectedError);
  } else {
    const proxies = engine.findProxyForURL(new URL(url));
    expect(proxies.length).toBe(expectedProxies.length);
    for (let i = 0; i < expectedProxies.length; i++) {
      expect(proxies.get(i).hostname).toBe(expectedProxies[i].hostname);
      expect(proxies.get(i).port).toBe(expectedProxies[i].port);
    }
  }

  engine.stop();
}

describe('OttoEngine', () => {
  it('should fail without PAC loader', () => {
    const engine = new OttoEngine();
    expect(() => engine.start()).toThrow('PAC loader has not been configured');
  });

  it('should handle FindProxyForURL returning invalid value', () => {
    assertOtto(
      'function FindProxyForURL(url, host){ return 1234; }',
      'http://www.example.com/page.html',
      [],
      'unsupported PAC command "1234"',
    );
  });

  it('should handle undefined FindProxyForURL', () => {
    const engine = OttoEngine.withStringLoader('1 + 1');
    expect(() => engine.start()).toThrow("ReferenceError: 'FindProxyForURL' is not defined");
  });

  it('should handle non-function FindProxyForURL', () => {
    const engine = OttoEngine.withStringLoader('FindProxyForURL = 1234');
    expect(() => engine.start()).toThrow('TypeError: "FindProxyForURL" is not a function');
  });

  it('should handle DirectPAC', () => {
    assertOtto(
      "function FindProxyForURL(url, host){ return 'DIRECT'; }",
      'http://www.example.com/page.html',
      [DirectProxy],
      '',
    );
  });

  it('should handle multiple proxy values', () => {
    assertOtto(
      "function FindProxyForURL(url, host){ return 'PROXY proxy.example.com:8080; DIRECT'; }",
      'http://www.example.com/page.html',
      [{ hostname: 'proxy.example.com', port: 8080 }, DirectProxy],
      '',
    );
  });

  it('should handle dnsDomainIs PAC function', () => {
    assertOtto(
      `function FindProxyForURL(url, host){
        if (dnsDomainIs(host, '.example.com')) return 'DIRECT';
        return 'PROXY proxy.example.com:8080';
      }`,
      'http://www.example.com/page.html',
      [DirectProxy],
      '',
    );
  });

  it('should handle shExpMatch PAC function', () => {
    assertOtto(
      `function FindProxyForURL(url, host){
        if (shExpMatch(host, '*.example.com')) return 'DIRECT';
        return 'PROXY proxy.example.com:8080';
      }`,
      'http://www.example.com/page.html',
      [DirectProxy],
      '',
    );
  });

  it('should handle isPlainHostName PAC function', () => {
    assertOtto(
      `function FindProxyForURL(url, host){
        if (isPlainHostName(host)) return 'DIRECT';
        return 'PROXY proxy.example.com:8080';
      }`,
      'http://intranet/page.html',
      [DirectProxy],
      '',
    );
  });

  it('should handle isInNet PAC function', () => {
    assertOtto(
      `function FindProxyForURL(url, host){
        if (isInNet(host, '127.0.0.0', '255.0.0.0')) return 'DIRECT';
        return 'PROXY proxy.example.com:8080';
      }`,
      'http://localhost/page.html',
      [DirectProxy],
      '',
    );
  });

  it('should handle myIpAddress PAC function', () => {
    assertOtto(
      `function FindProxyForURL(url, host){
        var myIp = myIpAddress();
        return 'DIRECT';
      }`,
      'http://www.example.com/page.html',
      [DirectProxy],
      '',
    );
  });

  it('should handle dnsResolve PAC function', () => {
    assertOtto(
      `function FindProxyForURL(url, host){
        var ip = dnsResolve(host);
        return 'DIRECT';
      }`,
      'http://localhost/page.html',
      [DirectProxy],
      '',
    );
  });

  it('should handle dnsDomainLevels PAC function', () => {
    assertOtto(
      `function FindProxyForURL(url, host){
        if (dnsDomainLevels(host) > 2) return 'DIRECT';
        return 'PROXY proxy.example.com:8080';
      }`,
      'http://www.example.com/page.html',
      [{ hostname: 'proxy.example.com', port: 8080 }],
      '',
    );
  });

  it('should handle localHostOrDomainIs PAC function', () => {
    assertOtto(
      `function FindProxyForURL(url, host){
        if (localHostOrDomainIs(host, 'www.example.com')) return 'DIRECT';
        return 'PROXY proxy.example.com:8080';
      }`,
      'http://www.example.com/page.html',
      [DirectProxy],
      '',
    );
  });

  it('should handle isResolvable PAC function', () => {
    assertOtto(
      `function FindProxyForURL(url, host){
        if (isResolvable(host)) return 'DIRECT';
        return 'PROXY proxy.example.com:8080';
      }`,
      'http://localhost/page.html',
      [DirectProxy],
      '',
    );
  });

  it('should handle convert_addr PAC function', () => {
    assertOtto(
      `function FindProxyForURL(url, host){
        var addr = convert_addr('127.0.0.1');
        return 'DIRECT';
      }`,
      'http://www.example.com/page.html',
      [DirectProxy],
      '',
    );
  });

  it('should handle weekdayRange PAC function', () => {
    assertOtto(
      `function FindProxyForURL(url, host){
        if (weekdayRange('MON', 'FRI', 'GMT')) return 'DIRECT';
        return 'PROXY proxy.example.com:8080';
      }`,
      'http://www.example.com/page.html',
      [DirectProxy],
      '',
    );
  });

  it('should handle dateRange PAC function', () => {
    assertOtto(
      `function FindProxyForURL(url, host){
        if (dateRange('JAN', 'DEC', 'GMT')) return 'DIRECT';
        return 'PROXY proxy.example.com:8080';
      }`,
      'http://www.example.com/page.html',
      [DirectProxy],
      '',
    );
  });

  it('should handle timeRange PAC function', () => {
    assertOtto(
      `function FindProxyForURL(url, host){
        if (timeRange('9', '17', 'GMT')) return 'DIRECT';
        return 'PROXY proxy.example.com:8080';
      }`,
      'http://www.example.com/page.html',
      [DirectProxy],
      '',
    );
  });

  it('should support reload', () => {
    const engine = OttoEngine.withStringLoader(
      "function FindProxyForURL(url, host){ return 'DIRECT'; }"
    );
    engine.start();
    const result1 = engine.findProxyForURL(new URL('http://www.example.com'));
    expect(result1.length).toBe(1);
    expect(result1.get(0)).toEqual(DirectProxy);

    engine.reload();
    const result2 = engine.findProxyForURL(new URL('http://www.example.com'));
    expect(result2.length).toBe(1);
    expect(result2.get(0)).toEqual(DirectProxy);
  });
});
