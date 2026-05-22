import { parseFindProxyString } from '../src/pac/parse';
import { DirectProxy, Proxies } from '../src/pac/types';

describe('parseFindProxyString', () => {
  const parsetests = [
    { in: 'DIRECT', proxies: [DirectProxy], err: null },
    { in: 'PROXY proxy.example.com:8080', proxies: [{ type: 'http', hostname: 'proxy.example.com', port: 8080 }], err: null },
    { in: 'PROXY proxy.example.com:8080;', proxies: [{ type: 'http', hostname: 'proxy.example.com', port: 8080 }], err: null },
    { in: 'PROXY proxy.example.com:8080; ; ;;', proxies: [{ type: 'http', hostname: 'proxy.example.com', port: 8080 }], err: null },
    {
      in: 'PROXY proxy.example.com:8080; DIRECT',
      proxies: [{ type: 'http', hostname: 'proxy.example.com', port: 8080 }, DirectProxy],
      err: null,
    },
    {
      in: 'PROXY proxy.example.com:8080; DIRECT; PROXY proxy.example.org:8888',
      proxies: [
        { type: 'http', hostname: 'proxy.example.com', port: 8080 },
        DirectProxy,
        { type: 'http', hostname: 'proxy.example.org', port: 8888 },
      ],
      err: null,
    },
    { in: 'FOO', proxies: [], err: 'unsupported PAC command "FOO"' },
    { in: 'PROXY', proxies: [], err: 'unable to parse proxy details from "PROXY"' },
    { in: 'PROXY proxy.example.com', proxies: [], err: 'unable to parse hostname and port from "proxy.example.com"' },
    {
      in: 'PROXY user:pass@proxy.example.com:8080',
      proxies: [{ type: 'http', hostname: 'proxy.example.com', port: 8080, username: 'user', password: 'pass' }],
      err: null,
    },
    {
      in: 'PROXY user%40domain:url_encoded%40pass@proxy.example.com:8080',
      proxies: [{ type: 'http', hostname: 'proxy.example.com', port: 8080, username: 'user@domain', password: 'url_encoded@pass' }],
      err: null,
    },
    // SOCKS5 tests
    { in: 'SOCKS5 socks.example.com:1080', proxies: [{ type: 'socks5', hostname: 'socks.example.com', port: 1080 }], err: null },
    {
      in: 'SOCKS5 user:pass@socks.example.com:1080',
      proxies: [{ type: 'socks5', hostname: 'socks.example.com', port: 1080, username: 'user', password: 'pass' }],
      err: null,
    },
    {
      in: 'SOCKS5 user%40domain:pass%40encoded@socks.example.com:1080',
      proxies: [{ type: 'socks5', hostname: 'socks.example.com', port: 1080, username: 'user@domain', password: 'pass@encoded' }],
      err: null,
    },
    { in: 'SOCKS5', proxies: [], err: 'unable to parse SOCKS5 details from "SOCKS5"' },
    // SOCKS4 tests
    { in: 'SOCKS socks.example.com:1080', proxies: [{ type: 'socks4', hostname: 'socks.example.com', port: 1080 }], err: null },
    { in: 'SOCKS4 socks.example.com:1080', proxies: [{ type: 'socks4', hostname: 'socks.example.com', port: 1080 }], err: null },
    { in: 'SOCKS', proxies: [], err: 'unable to parse SOCKS details from "SOCKS"' },
    // Mixed
    {
      in: 'DIRECT; SOCKS5 socks.example.com:1080',
      proxies: [DirectProxy, { type: 'socks5', hostname: 'socks.example.com', port: 1080 }],
      err: null,
    },
    {
      in: 'PROXY proxy.example.com:8080; SOCKS5 socks.example.com:1080',
      proxies: [
        { type: 'http', hostname: 'proxy.example.com', port: 8080 },
        { type: 'socks5', hostname: 'socks.example.com', port: 1080 },
      ],
      err: null,
    },
  ];

  it.each(parsetests)(
    'parsing "$in"',
    ({ in: input, proxies, err }) => {
      if (err) {
        expect(() => parseFindProxyString(input)).toThrow(err);
      } else {
        const result = parseFindProxyString(input);
        expect(result.length).toBe(proxies.length);
        for (let i = 0; i < proxies.length; i++) {
          expect(result.get(i).type).toBe(proxies[i].type);
          expect(result.get(i).hostname).toBe(proxies[i].hostname);
          expect(result.get(i).port).toBe(proxies[i].port);
          if ('username' in proxies[i]) {
            expect((result.get(i) as any).username).toBe((proxies[i] as any).username);
            expect((result.get(i) as any).password).toBe((proxies[i] as any).password);
          }
        }
      }
    }
  );

  describe('Proxies.toString roundtrip', () => {
    it('should roundtrip SOCKS5 proxy', () => {
      const proxies = new Proxies([{ type: 'socks5', hostname: 'socks.example.com', port: 1080 }]);
      expect(proxies.toString()).toBe('SOCKS5 socks.example.com:1080');
    });

    it('should roundtrip SOCKS5 proxy with auth', () => {
      const proxies = new Proxies([{ type: 'socks5', hostname: 'socks.example.com', port: 1080, username: 'user', password: 'pass' }]);
      expect(proxies.toString()).toBe('SOCKS5 user:pass@socks.example.com:1080');
    });

    it('should roundtrip SOCKS4 proxy', () => {
      const proxies = new Proxies([{ type: 'socks4', hostname: 'socks.example.com', port: 1080 }]);
      expect(proxies.toString()).toBe('SOCKS socks.example.com:1080');
    });

    it('should roundtrip mixed DIRECT and SOCKS5', () => {
      const proxies = new Proxies([DirectProxy, { type: 'socks5', hostname: 'socks.example.com', port: 1080 }]);
      expect(proxies.toString()).toBe('DIRECT; SOCKS5 socks.example.com:1080');
    });

    it('should roundtrip HTTP proxy', () => {
      const proxies = new Proxies([{ type: 'http', hostname: 'proxy.example.com', port: 8080 }]);
      expect(proxies.toString()).toBe('PROXY proxy.example.com:8080');
    });
  });
});
