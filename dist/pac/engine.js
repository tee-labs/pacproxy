"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.OttoEngine = void 0;
const vm = __importStar(require("vm"));
const parse_1 = require("./parse");
const pacfunc = __importStar(require("../pacfunc"));
class OttoEngine {
    loader;
    isStarted = false;
    vmContext = null;
    findProxyFn = null;
    constructor(loader) {
        this.loader = loader;
    }
    static withStringLoader(pac) {
        return new OttoEngine(() => pac);
    }
    start() {
        if (this.isStarted)
            return;
        const loader = this.loader;
        if (!loader) {
            throw new Error('PAC loader has not been configured');
        }
        const pac = loader();
        const sandbox = {
            console: {
                log: (..._args) => { },
            },
            convert_addr: (ipaddr) => pacfunc.convertAddr(ipaddr),
            dnsDomainIs: (host, domain) => pacfunc.dnsDomainIs(host, domain),
            shExpMatch: (str, shexp) => pacfunc.shExpMatch(str, shexp),
            isInNet: (host, netip, netmask) => pacfunc.isInNet(host, netip, netmask),
            myIpAddress: () => pacfunc.myIPAddress(),
            dnsResolve: (host) => pacfunc.dnsResolve(host),
            isPlainHostName: (host) => pacfunc.isPlainHostName(host),
            localHostOrDomainIs: (host, hostdom) => pacfunc.localHostOrDomainIs(host, hostdom),
            isResolvable: (host) => pacfunc.isResolvable(host),
            dnsDomainLevels: (host) => pacfunc.dnsDomainLevels(host),
            weekdayRange: function (...args) {
                const wd1 = String(args[0] ?? '');
                const wd2 = String(args[1] ?? '');
                const gmt = String(args[2] ?? '');
                return pacfunc.weekdayRange(wd1, wd2, gmt);
            },
            dateRange: function (...args) {
                const strArgs = args.map(a => String(a));
                return pacfunc.dateRange(...strArgs);
            },
            timeRange: function (...args) {
                const strArgs = args.map(a => String(a));
                return pacfunc.timeRange(...strArgs);
            },
        };
        this.vmContext = vm.createContext(sandbox);
        vm.runInContext(pac, this.vmContext);
        const fn = this.vmContext.FindProxyForURL;
        if (typeof fn !== 'function') {
            this.vmContext = null;
            if (fn === undefined) {
                throw new Error("ReferenceError: 'FindProxyForURL' is not defined");
            }
            throw new Error('TypeError: "FindProxyForURL" is not a function');
        }
        this.findProxyFn = fn;
        this.isStarted = true;
    }
    stop() {
        this.vmContext = null;
        this.findProxyFn = null;
        this.isStarted = false;
    }
    reload() {
        this.stop();
        this.start();
    }
    findProxyForURL(u) {
        if (!this.findProxyFn) {
            throw new Error('PAC engine not started');
        }
        const result = String(this.findProxyFn(u.toString(), u.hostname));
        return (0, parse_1.parseFindProxyString)(result);
    }
}
exports.OttoEngine = OttoEngine;
//# sourceMappingURL=engine.js.map