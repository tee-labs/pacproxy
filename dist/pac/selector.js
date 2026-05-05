"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FirstItemSelector = void 0;
const types_1 = require("./types");
class FirstItemSelector {
    selectProxy(from) {
        if (from.length < 1)
            return types_1.DirectProxy;
        return from.get(0);
    }
}
exports.FirstItemSelector = FirstItemSelector;
//# sourceMappingURL=selector.js.map