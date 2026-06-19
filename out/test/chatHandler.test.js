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
const assert = __importStar(require("assert"));
const toolAdapter_1 = require("../toolAdapter");
describe('ToolAdapter Unit Tests', () => {
    describe('repairJson', () => {
        it('should close unclosed braces', () => {
            const input = '{"name": "test", "arguments": {"foo": "bar"';
            const expected = '{"name": "test", "arguments": {"foo": "bar"}}';
            assert.strictEqual(toolAdapter_1.ToolAdapter.repairJson(input), expected);
        });
        it('should close unclosed brackets', () => {
            const input = '{"list": [1, 2, 3';
            const expected = '{"list": [1, 2, 3]}';
            assert.strictEqual(toolAdapter_1.ToolAdapter.repairJson(input), expected);
        });
        it('should remove trailing commas before closing braces', () => {
            const input = '{"foo": "bar",}';
            const expected = '{"foo": "bar"}';
            assert.strictEqual(toolAdapter_1.ToolAdapter.repairJson(input), expected);
        });
        it('should ignore braces inside string literals', () => {
            const input = '{"val": "nested { brace"}';
            assert.strictEqual(toolAdapter_1.ToolAdapter.repairJson(input), input);
        });
    });
    describe('detectToolCallInText', () => {
        it('should detect a valid tool call object in text', () => {
            const text = 'Here is the tool call: {"name": "get_weather", "arguments": "{\\"location\\": \\"Tokyo\\"}"} and some trailing text';
            const detected = toolAdapter_1.ToolAdapter.detectToolCallInText(text);
            assert.ok(detected);
            assert.strictEqual(detected.name, 'get_weather');
            assert.deepStrictEqual(detected.args, { location: 'Tokyo' });
        });
        it('should return null if JSON is incomplete', () => {
            const text = 'Incomplete tool call: {"name": "get_weather", "arguments":';
            const detected = toolAdapter_1.ToolAdapter.detectToolCallInText(text);
            assert.strictEqual(detected, null);
        });
        it('should return null if object is not a tool call structure', () => {
            const text = 'Normal JSON: {"greeting": "hello"}';
            const detected = toolAdapter_1.ToolAdapter.detectToolCallInText(text);
            assert.strictEqual(detected, null);
        });
    });
});
