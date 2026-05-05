"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Proxies = exports.DirectProxy = void 0;
exports.isDirectProxy = isDirectProxy;
exports.DirectProxy = { hostname: '', port: 0 };
function isDirectProxy(p) {
    return p.hostname === '' && p.port === 0;
}
class Proxies {
    items;
    constructor(items = []) {
        this.items = items;
    }
    get length() {
        return this.items.length;
    }
    get(index) {
        return this.items[index];
    }
    toString() {
        return this.items
            .map(p => {
            if (isDirectProxy(p))
                return 'DIRECT';
            return `PROXY ${p.hostname}:${p.port}`;
        })
            .join('; ');
    }
    toArray() {
        return [...this.items];
    }
}
exports.Proxies = Proxies;
//# sourceMappingURL=types.js.map