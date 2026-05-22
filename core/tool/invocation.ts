import { MEMORY_TOOL_DESCRIPTORS } from './memory';
import type { ToolCall, ToolDescriptor, ToolPayload } from './types';

export const DEFAULT_TOOL_DESCRIPTORS: readonly ToolDescriptor[] = MEMORY_TOOL_DESCRIPTORS;

export interface ToolInvocationCatalog {
  descriptors: readonly ToolDescriptor[];
  invocationNames: string[];
  descriptorByInvocationName: Map<string, ToolDescriptor>;
  descriptorByName: Map<string, ToolDescriptor>;
}

export interface ToolParsingInput {
  descriptors?: readonly ToolDescriptor[];
}

export function createToolInvocationCatalog(
  descriptors: readonly ToolDescriptor[] = DEFAULT_TOOL_DESCRIPTORS,
): ToolInvocationCatalog {
  const descriptorByInvocationName = new Map<string, ToolDescriptor>();
  const descriptorByName = new Map<string, ToolDescriptor>();

  for (const descriptor of descriptors) {
    const invocationName = descriptor.invocationName.trim();
    if (invocationName && !descriptorByInvocationName.has(invocationName)) {
      descriptorByInvocationName.set(invocationName, descriptor);
    }

    const name = descriptor.name.trim();
    if (name && !descriptorByName.has(name)) {
      descriptorByName.set(name, descriptor);
    }
  }

  return {
    descriptors,
    invocationNames: [...descriptorByInvocationName.keys()],
    descriptorByInvocationName,
    descriptorByName,
  };
}

export function createXmlToolCallRegex(catalog: ToolInvocationCatalog): RegExp {
  if (catalog.invocationNames.length === 0) return /$a/g;
  const names = catalog.invocationNames.map(escapeRegExp).join('|');
  return new RegExp(`<(${names})>\\s*([\\s\\S]*?)\\s*<\\/\\1>`, 'g');
}

export function createToolCallFromInvocation(
  invocationName: string,
  payload: ToolPayload,
  raw: string,
  catalog: ToolInvocationCatalog,
): ToolCall {
  const descriptor =
    catalog.descriptorByInvocationName.get(invocationName) ||
    catalog.descriptorByName.get(invocationName);

  return {
    name: descriptor?.name ?? invocationName,
    invocationName: descriptor?.invocationName ?? invocationName,
    payload,
    raw,
    descriptorId: descriptor?.id,
    provider: descriptor?.provider,
  };
}

export function getToolInvocationLabel(
  name: string,
  catalog: ToolInvocationCatalog = createToolInvocationCatalog(),
): string {
  const descriptor =
    catalog.descriptorByInvocationName.get(name) ||
    catalog.descriptorByName.get(name);
  return descriptor?.title || name;
}

export function getToolOpenTag(invocationName: string): string {
  return `<${invocationName}>`;
}

export function getToolCloseTag(invocationName: string): string {
  return `</${invocationName}>`;
}

export function hasXmlToolMarker(text: string, catalog: ToolInvocationCatalog): boolean {
  for (const name of catalog.invocationNames) {
    if (text.includes(getToolOpenTag(name)) || text.includes(getToolCloseTag(name))) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
