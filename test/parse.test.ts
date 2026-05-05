import { parseFindProxyString } from '../src/pac/parse';
import { DirectProxy } from '../src/pac/types';

describe('parseFindProxyString', () => {
  const parsetests = [
    { in: 'DIRECT', proxies: [DirectProxy], err: null },
    { in: 'PROXY proxy.example.com:8080', proxies: [{ hostname: 'proxy.example.com', port: 8080 }], err: null },
    { in: 'PROXY proxy.example.com:8080;', proxies: [{ hostname: 'proxy.example.com', port: 8080 }], err: null },
    { in: 'PROXY proxy.example.com:8080;  ; ;;', proxies: [{ hostname: 'proxy.example.com', port: 8080 }], err: null },
    {
      in: 'PROXY proxy.example.com:8080; DIRECT',
      proxies: [{ hostname: 'proxy.example.com', port: 8080 }, DirectProxy],
      err: null,
    },
    {
      in: 'PROXY proxy.example.com:8080; DIRECT; PROXY proxy.example.org:8888',
      proxies: [
        { hostname: 'proxy.example.com', port: 8080 },
        DirectProxy,
        { hostname: 'proxy.example.org', port: 8888 },
      ],
      err: null,
    },
    { in: 'FOO', proxies: [], err: 'unsupported PAC command "FOO"' },
    { in: 'PROXY', proxies: [], err: 'unable to parse proxy details from "PROXY"' },
    { in: 'PROXY proxy.example.com', proxies: [], err: 'unable to parse hostname and port from "proxy.example.com"' },
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
          expect(result.get(i).hostname).toBe(proxies[i].hostname);
          expect(result.get(i).port).toBe(proxies[i].port);
        }
      }
    }
  );
});
