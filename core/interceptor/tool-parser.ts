import type { ToolCall } from '../types';
import {
  createToolCallFromInvocation,
  createToolInvocationCatalog,
  createXmlToolCallRegex,
  getToolInvocationLabel,
  type ToolInvocationCatalog,
  type ToolParsingInput,
} from '../tool';

const LEGACY_TOOL_CALLS_BLOCK_REGEX = /<｜DSML｜tool_calls>\s*[\s\S]*?\s*<\/｜DSML｜tool_calls>/g;
const LEGACY_INVOKE_REGEX = /<｜DSML｜invoke name="([^"]+)">\s*([\s\S]*?)\s*<\/｜DSML｜invoke>/g;
const LEGACY_PARAMETER_REGEX = /<｜DSML｜parameter name="([^"]+)" string="(true|false)">([\s\S]*?)<\/｜DSML｜parameter>/g;

export function extractToolCalls(text: string, input?: ToolParsingInput): ToolCall[] {
  const catalog = createToolInvocationCatalog(input?.descriptors);
  return [
    ...extractXmlToolCalls(text, catalog),
    ...extractLegacyToolCalls(text, catalog),
  ];
}

function extractXmlToolCalls(text: string, catalog: ToolInvocationCatalog): ToolCall[] {
  const calls: ToolCall[] = [];
  const regex = createXmlToolCallRegex(catalog);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const invocationName = match[1];
    const body = match[2].trim();
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object') {
        payload = parsed;
      }
    } catch {
      // body wasn't JSON; skip
      continue;
    }
    calls.push(createToolCallFromInvocation(invocationName, payload, match[0], catalog));
  }

  return calls;
}

function extractLegacyToolCalls(text: string, catalog: ToolInvocationCatalog): ToolCall[] {
  const calls: ToolCall[] = [];
  const blockRegex = new RegExp(LEGACY_TOOL_CALLS_BLOCK_REGEX.source, 'g');
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const blockContent = blockMatch[0];
    const invokeRegex = new RegExp(LEGACY_INVOKE_REGEX.source, 'g');
    let invokeMatch: RegExpExecArray | null;

    while ((invokeMatch = invokeRegex.exec(blockContent)) !== null) {
      const invocationName = invokeMatch[1];
      const invokeContent = invokeMatch[2];
      const payload: Record<string, unknown> = {};
      const paramRegex = new RegExp(LEGACY_PARAMETER_REGEX.source, 'g');
      let paramMatch: RegExpExecArray | null;

      while ((paramMatch = paramRegex.exec(invokeContent)) !== null) {
        const paramName = paramMatch[1];
        const isString = paramMatch[2] === 'true';
        const value = paramMatch[3];
        if (isString) {
          payload[paramName] = value;
          continue;
        }
        try {
          payload[paramName] = JSON.parse(value);
        } catch {
          payload[paramName] = value;
        }
      }

      calls.push(createToolCallFromInvocation(invocationName, payload, invokeMatch[0], catalog));
    }
  }

  return calls;
}

export function stripToolCalls(text: string, input?: ToolParsingInput): string {
  const catalog = createToolInvocationCatalog(input?.descriptors);
  const regex = createXmlToolCallRegex(catalog);
  const legacyRegex = new RegExp(LEGACY_TOOL_CALLS_BLOCK_REGEX.source, 'g');
  return text.replace(regex, '').replace(legacyRegex, '').trim();
}

export function replaceToolCallsWithSummary(text: string, input?: ToolParsingInput): string {
  const catalog = createToolInvocationCatalog(input?.descriptors);
  const regex = createXmlToolCallRegex(catalog);
  const legacyRegex = new RegExp(LEGACY_TOOL_CALLS_BLOCK_REGEX.source, 'g');
  return text
    .replace(regex, (match) => replaceMatchWithSummary(match, catalog))
    .replace(legacyRegex, (match) => replaceMatchWithSummary(match, catalog));
}

function replaceMatchWithSummary(match: string, catalog: ToolInvocationCatalog): string {
  const calls = extractToolCalls(match, { descriptors: catalog.descriptors });
  if (calls.length === 0) return '';
  const lines = calls.map(call => {
    const name = call.name;
    const detail = (call.payload as any).name || (call.payload as any).content || (call.payload as any).id || '';
    return `• ${getToolInvocationLabel(name, catalog)}${detail ? '：' + detail : ''}`;
  });
  return '\n\n---\n🔧 已执行工具（' + calls.length + '次）\n' + lines.join('\n') + '\n---';
}
