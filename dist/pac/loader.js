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
exports.smartLoader = smartLoader;
exports.fileLoader = fileLoader;
exports.httpLoader = httpLoader;
exports.stringLoader = stringLoader;
const fs = __importStar(require("fs"));
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const url_1 = require("url");
const parse_1 = require("./parse");
function smartLoader(thing) {
    return () => {
        try {
            (0, parse_1.parseFindProxyString)(thing);
            return `function FindProxyForURL(url, host){ return ${JSON.stringify(thing)}; }`;
        }
        catch {
        }
        if (thing.includes('FindProxyForURL') && thing.includes('{')) {
            return thing;
        }
        try {
            const parsed = new url_1.URL(thing);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                return httpLoader(parsed)();
            }
        }
        catch {
        }
        return fileLoader(thing)();
    };
}
function fileLoader(file) {
    return () => {
        return fs.readFileSync(file, 'utf-8');
    };
}
function httpLoader(u) {
    return () => {
        const client = u.protocol === 'https:' ? https : http;
        const chunks = [];
        let done = false;
        let err = null;
        const req = client.get(u.toString(), (res) => {
            res.on('data', (chunk) => chunks.push(chunk));
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
        if (err)
            throw err;
        return Buffer.concat(chunks).toString('utf-8');
    };
}
function stringLoader(pac) {
    return () => pac;
}
//# sourceMappingURL=loader.js.map