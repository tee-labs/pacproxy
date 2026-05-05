"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseFindProxyString = parseFindProxyString;
const types_1 = require("./types");
const PAC_STATEMENT_SPLIT = /\s*;\s*/;
const PAC_ITEM_SPLIT = /\s+/;
function parseFindProxyString(s) {
    const proxies = [];
    const statements = s.split(PAC_STATEMENT_SPLIT);
    for (const statement of statements) {
        if (statement === '')
            continue;
        const part = statement.split(PAC_ITEM_SPLIT).slice(0, 2);
        const cmd = part[0].toUpperCase();
        switch (cmd) {
            case 'DIRECT':
                proxies.push(types_1.DirectProxy);
                break;
            case 'PROXY': {
                if (part.length !== 2) {
                    throw new Error(`unable to parse proxy details from "${statement}"`);
                }
                const addr = part[1];
                const colonIdx = addr.lastIndexOf(':');
                if (colonIdx < 0) {
                    throw new Error(`unable to parse hostname and port from "${addr}"`);
                }
                const hostname = addr.substring(0, colonIdx);
                const portStr = addr.substring(colonIdx + 1);
                const port = parseInt(portStr, 10);
                if (hostname === '' || portStr === '' || isNaN(port)) {
                    throw new Error(`unable to parse hostname and port from "${addr}"`);
                }
                proxies.push({ hostname, port });
                break;
            }
            default:
                throw new Error(`unsupported PAC command "${cmd}"`);
        }
    }
    return new types_1.Proxies(proxies);
}
//# sourceMappingURL=parse.js.map