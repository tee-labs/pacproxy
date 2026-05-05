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
exports.defaultNower = exports.StaticNower = exports.TimeNower = void 0;
exports.setDefaultNower = setDefaultNower;
exports.restoreDefaultNower = restoreDefaultNower;
exports.convertAddr = convertAddr;
exports.dnsDomainIs = dnsDomainIs;
exports.shExpMatch = shExpMatch;
exports.isInNet = isInNet;
exports.myIPAddress = myIPAddress;
exports.dnsResolve = dnsResolve;
exports.isPlainHostName = isPlainHostName;
exports.localHostOrDomainIs = localHostOrDomainIs;
exports.isResolvable = isResolvable;
exports.dnsDomainLevels = dnsDomainLevels;
exports.weekdayRange = weekdayRange;
exports.dateRange = dateRange;
exports.timeRange = timeRange;
const os = __importStar(require("os"));
const net_1 = require("net");
class TimeNower {
    now() {
        return new Date();
    }
}
exports.TimeNower = TimeNower;
class StaticNower {
    _now;
    constructor(_now) {
        this._now = _now;
    }
    now() {
        return this._now;
    }
}
exports.StaticNower = StaticNower;
exports.defaultNower = new TimeNower();
function setDefaultNower(nower) {
    exports.defaultNower = nower;
}
function restoreDefaultNower() {
    exports.defaultNower = new TimeNower();
}
const WEEKDAY_MAP = {
    SUN: 0,
    MON: 1,
    TUE: 2,
    WED: 3,
    THU: 4,
    FRI: 5,
    SAT: 6,
};
const MONTH_MAP = {
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
function convertAddr(ipaddr) {
    if (!(0, net_1.isIPv4)(ipaddr))
        return 0;
    const parts = ipaddr.split('.');
    if (parts.length !== 4)
        return 0;
    let result = 0;
    for (let i = 0; i < 4; i++) {
        result = (result << 8) + parseInt(parts[i], 10);
    }
    return result >>> 0;
}
function dnsDomainIs(host, domain) {
    if (host.length < domain.length)
        return false;
    return host.endsWith(domain);
}
function shExpMatch(str, shexp) {
    let pattern = shexp.replace(/\./g, '\\.');
    pattern = pattern.replace(/\?/g, '.');
    pattern = pattern.replace(/\*/g, '.*');
    const regex = new RegExp('^' + pattern + '$');
    return regex.test(str);
}
function isInNet(host, netip, netmask) {
    if (host.length === 0)
        return false;
    let ip = host;
    if (!(0, net_1.isIPv4)(ip)) {
        ip = dnsResolve(host);
        if (!ip)
            return false;
    }
    const hostAddr = convertAddr(ip);
    if (hostAddr === 0)
        return false;
    const netAddr = convertAddr(netip);
    const mask = convertAddr(netmask);
    return (hostAddr & mask) === (netAddr & mask);
}
function myIPAddress() {
    const hostname = os.hostname();
    return dnsResolve(hostname);
}
function dnsResolve(host) {
    const interfaces = os.networkInterfaces();
    if (host === 'localhost')
        return '127.0.0.1';
    for (const name of Object.keys(interfaces)) {
        const iface = interfaces[name];
        if (!iface)
            continue;
        for (const addr of iface) {
            if (addr.family === 'IPv4' && !addr.internal) {
                return addr.address;
            }
        }
    }
    for (const name of Object.keys(interfaces)) {
        const iface = interfaces[name];
        if (!iface)
            continue;
        for (const addr of iface) {
            if (addr.family === 'IPv4') {
                return addr.address;
            }
        }
    }
    return '127.0.0.1';
}
function isPlainHostName(host) {
    return !host.includes('.');
}
function localHostOrDomainIs(host, hostdom) {
    if (host === hostdom)
        return true;
    return hostdom.startsWith(host + '.');
}
function isResolvable(host) {
    if (host.length === 0)
        return false;
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        const iface = interfaces[name];
        if (!iface)
            continue;
        for (const addr of iface) {
            if (addr.family === 'IPv4') {
                return true;
            }
        }
    }
    return false;
}
function dnsDomainLevels(host) {
    let count = 0;
    for (let i = 0; i < host.length; i++) {
        if (host[i] === '.')
            count++;
    }
    return count;
}
function weekdayRange(wd1, wd2, gmt) {
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
    let now = exports.defaultNower.now();
    if (gmt === 'GMT') {
        now = new Date(now.toISOString());
    }
    const today = now.getDay();
    const weekday1 = WEEKDAY_MAP[wd1];
    const weekday2 = WEEKDAY_MAP[wd2];
    if (weekday1 === undefined || weekday2 === undefined)
        return false;
    if (weekday1 === weekday2 && weekday1 === today)
        return true;
    let lo = weekday1;
    let hi = weekday2;
    if (lo > hi) {
        [lo, hi] = [hi, lo];
    }
    return lo <= today && today <= hi;
}
function dateRange(...args) {
    let argc = args.length;
    if (argc < 1)
        return false;
    for (let k = 0; k < argc; k++) {
        args[k] = args[k].toUpperCase();
    }
    let now = exports.defaultNower.now();
    const isGMT = args[argc - 1] === 'GMT';
    if (isGMT) {
        argc--;
        now = new Date(now.toISOString());
    }
    if (argc === 1) {
        const tmp = parseInt(args[0], 10);
        if (isNaN(tmp)) {
            return now.getMonth() === MONTH_MAP[args[0]];
        }
        else if (tmp <= 31) {
            return now.getDate() === tmp;
        }
        else {
            return now.getFullYear() === tmp;
        }
    }
    const getMonth = (name) => {
        return MONTH_MAP[name] ?? -1;
    };
    let date1 = new Date(now.getTime());
    for (let i = 0; i < Math.floor(argc / 2); i++) {
        const tmp = parseInt(args[i], 10);
        if (isNaN(tmp)) {
            const m = getMonth(args[i]);
            if (m === -1)
                return false;
            date1 = new Date(date1.getFullYear(), m, date1.getDate(), date1.getHours(), date1.getMinutes(), date1.getSeconds(), date1.getMilliseconds());
        }
        else if (tmp <= 31) {
            date1 = new Date(date1.getFullYear(), date1.getMonth(), tmp, date1.getHours(), date1.getMinutes(), date1.getSeconds(), date1.getMilliseconds());
        }
        else {
            date1 = new Date(tmp, date1.getMonth(), date1.getDate(), date1.getHours(), date1.getMinutes(), date1.getSeconds(), date1.getMilliseconds());
        }
    }
    let date2 = new Date(now.getTime());
    for (let i = Math.floor(argc / 2); i < argc; i++) {
        const tmp = parseInt(args[i], 10);
        if (isNaN(tmp)) {
            const m = getMonth(args[i]);
            if (m === -1)
                return false;
            date2 = new Date(date2.getFullYear(), m, date2.getDate(), date2.getHours(), date2.getMinutes(), date2.getSeconds(), date2.getMilliseconds());
        }
        else if (tmp <= 31) {
            date2 = new Date(date2.getFullYear(), date2.getMonth(), tmp, date2.getHours(), date2.getMinutes(), date2.getSeconds(), date2.getMilliseconds());
        }
        else {
            date2 = new Date(tmp, date2.getMonth(), date2.getDate(), date2.getHours(), date2.getMinutes(), date2.getSeconds(), date2.getMilliseconds());
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
function timeRange(...args) {
    let argc = args.length;
    if (argc < 1)
        return false;
    for (let k = 0; k < argc; k++) {
        args[k] = args[k].toUpperCase();
    }
    let now = exports.defaultNower.now();
    const isGMT = args[argc - 1] === 'GMT';
    if (isGMT) {
        argc--;
        now = new Date(now.toISOString());
    }
    let date1 = new Date(now.getTime());
    let date2 = new Date(now.getTime());
    if (argc === 1) {
        const tmp = parseInt(args[0], 10);
        if (isNaN(tmp))
            return false;
        return now.getHours() === tmp;
    }
    if (argc === 2) {
        const tmp1 = parseInt(args[0], 10);
        const tmp2 = parseInt(args[1], 10);
        if (isNaN(tmp1) || isNaN(tmp2))
            return false;
        let lo = tmp1;
        let hi = tmp2;
        if (hi < lo)
            [lo, hi] = [hi, lo];
        return lo <= now.getHours() && now.getHours() < hi;
    }
    if (argc === 6) {
        const s1 = parseInt(args[2], 10);
        const s2 = parseInt(args[5], 10);
        if (isNaN(s1) || isNaN(s2))
            return false;
        date1 = new Date(date1.getFullYear(), date1.getMonth(), date1.getDate(), date1.getHours(), date1.getMinutes(), s1, date1.getMilliseconds());
        date2 = new Date(date2.getFullYear(), date2.getMonth(), date2.getDate(), date2.getHours(), date2.getMinutes(), s2, date2.getMilliseconds());
    }
    if (argc === 4 || argc === 6) {
        const middle = Math.floor(argc / 2);
        const h1 = parseInt(args[0], 10);
        const m1 = parseInt(args[1], 10);
        const h2 = parseInt(args[middle], 10);
        const m2 = parseInt(args[middle + 1], 10);
        if (isNaN(h1) || isNaN(m1) || isNaN(h2) || isNaN(m2))
            return false;
        const sec1 = argc === 6 ? date1.getSeconds() : 0;
        const sec2 = argc === 6 ? date2.getSeconds() : 0;
        date1 = new Date(date1.getFullYear(), date1.getMonth(), date1.getDate(), h1, m1, sec1, date1.getMilliseconds());
        date2 = new Date(date2.getFullYear(), date2.getMonth(), date2.getDate(), h2, m2, sec2, date2.getMilliseconds());
    }
    else {
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
//# sourceMappingURL=index.js.map