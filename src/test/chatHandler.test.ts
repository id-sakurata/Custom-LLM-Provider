import * as assert from 'assert';
import { ToolAdapter } from '../toolAdapter';

describe('ToolAdapter Unit Tests', () => {
    describe('repairJson', () => {
        it('should close unclosed braces', () => {
            const input = '{"name": "test", "arguments": {"foo": "bar"';
            const expected = '{"name": "test", "arguments": {"foo": "bar"}}';
            assert.strictEqual(ToolAdapter.repairJson(input), expected);
        });

        it('should close unclosed brackets', () => {
            const input = '{"list": [1, 2, 3';
            const expected = '{"list": [1, 2, 3]}';
            assert.strictEqual(ToolAdapter.repairJson(input), expected);
        });

        it('should remove trailing commas before closing braces', () => {
            const input = '{"foo": "bar",}';
            const expected = '{"foo": "bar"}';
            assert.strictEqual(ToolAdapter.repairJson(input), expected);
        });

        it('should ignore braces inside string literals', () => {
            const input = '{"val": "nested { brace"}';
            assert.strictEqual(ToolAdapter.repairJson(input), input);
        });
    });

    describe('detectToolCallInText', () => {
        it('should detect a valid tool call object in text', () => {
            const text = 'Here is the tool call: {"name": "get_weather", "arguments": "{\\"location\\": \\"Tokyo\\"}"} and some trailing text';
            const detected = ToolAdapter.detectToolCallInText(text);
            assert.ok(detected);
            assert.strictEqual(detected.name, 'get_weather');
            assert.deepStrictEqual(detected.args, { location: 'Tokyo' });
        });

        it('should return null if JSON is incomplete', () => {
            const text = 'Incomplete tool call: {"name": "get_weather", "arguments":';
            const detected = ToolAdapter.detectToolCallInText(text);
            assert.strictEqual(detected, null);
        });

        it('should return null if object is not a tool call structure', () => {
            const text = 'Normal JSON: {"greeting": "hello"}';
            const detected = ToolAdapter.detectToolCallInText(text);
            assert.strictEqual(detected, null);
        });
    });
});
