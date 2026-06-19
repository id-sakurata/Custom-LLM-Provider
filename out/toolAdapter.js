"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolAdapter = void 0;
/**
 * Adapter to translate VS Code tools into various API formats and detect
 * tool calls within text streams.
 */
class ToolAdapter {
    /**
     * Translates VS Code tools to the requested flavor.
     */
    static translate(tools, flavor) {
        if (flavor === 'openai-tools') {
            return {
                tools: tools.map(t => ({
                    type: 'function',
                    function: {
                        name: t.name,
                        description: t.description,
                        parameters: t.inputSchema
                    }
                }))
            };
        }
        else if (flavor === 'openai-functions') {
            return {
                functions: tools.map(t => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.inputSchema
                }))
            };
        }
        // 'text-based' flavor: do not send functions/tools to the API
        // The model is expected to output tool calls as text, detected by detectToolCallInText
        return {};
    }
    /**
     * Detects potential JSON tool calls within a raw text chunk.
     * This is useful for 'text-based' flavor where the model doesn't use the dedicated field.
     */
    static detectToolCallInText(text) {
        try {
            // Use lastIndexOf for both to target the most recent JSON object
            const end = text.lastIndexOf('}');
            if (end === -1) {
                return null;
            }
            // Find the matching opening brace by scanning backwards
            let depth = 0;
            let start = -1;
            for (let i = end; i >= 0; i--) {
                if (text[i] === '}') {
                    depth++;
                }
                else if (text[i] === '{') {
                    depth--;
                }
                if (depth === 0) {
                    start = i;
                    break;
                }
            }
            if (start === -1 || start >= end) {
                return null;
            }
            const jsonStr = text.substring(start, end + 1);
            const obj = JSON.parse(jsonStr);
            if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
                return null;
            }
            const record = obj;
            if (typeof record.name === 'string' && record.name.length > 0 && record.arguments !== undefined) {
                const args = typeof record.arguments === 'string' ? JSON.parse(record.arguments) : record.arguments;
                return { name: record.name, args: args };
            }
            if (typeof record.function === 'string' && record.function.length > 0 && record.parameters !== undefined) {
                return { name: record.function, args: record.parameters };
            }
            if (typeof record.tool === 'string' && record.tool.length > 0 && record.parameters !== undefined) {
                return { name: record.tool, args: record.parameters };
            }
        }
        catch {
            // Not a valid or complete JSON yet
        }
        return null;
    }
    /**
     * Attempts to repair common JSON errors made by LLMs.
     */
    static repairJson(jsonStr) {
        let repaired = jsonStr.trim();
        // Count braces/brackets outside of string literals
        let openBraces = 0, closeBraces = 0;
        let openBrackets = 0, closeBrackets = 0;
        let inString = false;
        let escaped = false;
        for (const ch of repaired) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = !inString;
                continue;
            }
            if (inString) {
                continue;
            }
            if (ch === '{') {
                openBraces++;
            }
            else if (ch === '}') {
                closeBraces++;
            }
            else if (ch === '[') {
                openBrackets++;
            }
            else if (ch === ']') {
                closeBrackets++;
            }
        }
        if (openBraces > closeBraces) {
            repaired += '}'.repeat(openBraces - closeBraces);
        }
        if (openBrackets > closeBrackets) {
            repaired += ']'.repeat(openBrackets - closeBrackets);
        }
        // Remove trailing commas before closing braces/brackets
        repaired = repaired.replace(/,\s*([\}\]])/g, '$1');
        return repaired;
    }
}
exports.ToolAdapter = ToolAdapter;
