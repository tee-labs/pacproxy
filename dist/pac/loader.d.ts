import { URL } from 'url';
import { Loader } from './types';
export declare function smartLoader(thing: string): Loader;
export declare function fileLoader(file: string): Loader;
export declare function httpLoader(u: URL): Loader;
export declare function stringLoader(pac: string): Loader;
//# sourceMappingURL=loader.d.ts.map