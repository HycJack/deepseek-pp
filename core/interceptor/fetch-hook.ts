import { DEEPSEEK_API_URL, DPP_MANAGED_AGENT_PROMPT_MARKER, PRESET_REINJECTION_INTERVAL } from '../constants';
import type { Memory, ModelType, SystemPromptPreset, ToolCall, ToolCallRestoreRecord, ToolDescriptor } from '../types';
import { buildPromptAugmentation } from '../prompt';
import { parseSkillCommand } from '../skill/parser';
import { SHELL_TOOL_NAMES } from '../shell/contracts';
import {
  DEFAULT_TOOL_DESCRIPTORS,
  createToolInvocationCatalog,
  getToolCloseTag,
  getToolOpenTag,
  hasXmlToolMarker,
  type ToolInvocationCatalog,
} from '../tool';
import { estimateTokenUnits } from '../token/estimator';
import { extractTextFromParsed, isResponseTextPatchPath, isStreamFinishedFromParsed, isThinkingPatchPath, parseSSEChunk, parseSSEData } from './sse-parser';
import { extractToolCalls, stripToolCalls } from './tool-parser';

const COMPLETION_PATH = new URL(DEEPSEEK_API_URL).pathname;
const REGENERATE_PATH = '/api/v0/chat/regenerate';
const CHAT_STREAM_PATHS = [COMPLETION_PATH, REGENERATE_PATH];
const HISTORY_PATH = '/api/v0/chat/history_messages';
const BYPASS_HOOK_HEADER = 'X-DPP-Bypass-Hook';
const TOKEN_SPEED_EMIT_INTERVAL_MS = 250;

let originalFetch: typeof window.fetch;

interface HookState {
  memories: Memory[];
  skills: Array<{ name: string; instructions: string; memoryEnabled: boolean }>;
  activePreset: SystemPromptPreset | null;
  modelType: ModelType;
  toolDescriptors: ToolDescriptor[];
  messageCount: number;
  onToolCall: (call: ToolCall) => void;
  onToolCallExecuted: (call: ToolCall) => Promise<{ ok: boolean; summary: string; detail?: string }>;
  onToolCallsRestored: (records: ToolCallRestoreRecord[]) => void;
  onResponseTokenSpeed: (progress: ResponseTokenSpeedPayload) => void;
  onResponseComplete: (complete: ResponseCompletePayload) => void;
  onMemoriesUsed: (ids: number[]) => void;
}

let hookState: HookState = {
  memories: [],
  skills: [],
  activePreset: null,
  modelType: null,
  toolDescriptors: [...DEFAULT_TOOL_DESCRIPTORS],
  messageCount: 0,
  onToolCall: () => {},
  onToolCallExecuted: async () => ({ ok: true, summary: '' }),
  onToolCallsRestored: () => {},
  onResponseTokenSpeed: () => {},
  onResponseComplete: () => {},
  onMemoriesUsed: () => {},
};

export function updateHookState(partial: Partial<HookState>) {
  hookState = { ...hookState, ...partial };
}

export function installFetchHook() {
  hookFetch();
  hookXHR();
  hookIndexedDB();
}

export interface ResponseCompletePayload {
  text: string;
  originalPrompt: string;
  agentTaskPrompt: string;
  chatSessionId: string | null;
  parentMessageId: number | null;
  assistantMessageId: number | null;
  promptOptions: {
    modelType: string | null;
    searchEnabled: boolean;
    thinkingEnabled: boolean;
    refFileIds: string[];
  };
}

export interface ResponseTokenSpeedPayload {
  active: boolean;
  estimatedTokens: number;
  tokensPerSecond: number;
  elapsedMs: number;
  textLength: number;
}

interface RequestContext {
  originalPrompt: string;
  agentTaskPrompt: string;
  chatSessionId: string | null;
  parentMessageId: number | null;
  promptOptions: ResponseCompletePayload['promptOptions'];
}

interface RequestContextOverrides {
  originalPrompt?: string;
  agentTaskPrompt?: string;
}

interface RequestBodyModification {
  body: string;
  agentTaskPrompt: string;
}

function hookFetch() {
  originalFetch = window.fetch;

  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (url.includes(HISTORY_PATH)) {
      return interceptHistoryResponse(originalFetch.call(this, input, init));
    }

    if (!isChatStreamURL(url) || typeof init?.body !== 'string') {
      return originalFetch.call(this, input, init);
    }

    if (hasBypassHookHeader(init.headers)) {
      return originalFetch.call(this, input, { ...init, headers: stripBypassHookHeader(init.headers) });
    }

    const originalContext = createRequestContext(init.body);
    const modified = modifyRequestBody(init.body);
    const requestBody = modified?.body ?? init.body;
    const requestContext = createRequestContext(requestBody, {
      originalPrompt: originalContext.originalPrompt,
      agentTaskPrompt: modified?.agentTaskPrompt ?? originalContext.agentTaskPrompt,
    });
    const requestInit = modified ? { ...init, body: modified.body } : init;
    return interceptFetchResponse(originalFetch.call(this, input, requestInit), requestContext);
  };
}

function hookXHR() {
  const xhrUrls = new WeakMap<XMLHttpRequest, string>();
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    xhrUrls.set(this, typeof url === 'string' ? url : url.href);
    return origOpen.apply(this, [method, url, ...rest] as any);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const url = xhrUrls.get(this);
    if (url && isChatStreamURL(url) && typeof body === 'string') {
      const originalContext = createRequestContext(body);
      const modified = modifyRequestBody(body);
      const requestBody = modified?.body ?? body;
      setupXHRResponseInterceptor(this, createRequestContext(requestBody, {
        originalPrompt: originalContext.originalPrompt,
        agentTaskPrompt: modified?.agentTaskPrompt ?? originalContext.agentTaskPrompt,
      }));
      return origSend.call(this, requestBody);
    }
    if (url && url.includes(HISTORY_PATH)) {
      setupXHRHistoryInterceptor(this);
    }
    return origSend.call(this, body);
  };
}

function createRequestContext(bodyStr: string, overrides: RequestContextOverrides = {}): RequestContext {
  try {
    const body = JSON.parse(bodyStr) as Record<string, unknown>;
    const bodyPrompt = typeof body.prompt === 'string' ? body.prompt : '';
    const originalPrompt = typeof overrides.originalPrompt === 'string'
      ? overrides.originalPrompt
      : typeof body.prompt === 'string'
        ? body.prompt
        : '';
    return {
      originalPrompt,
      agentTaskPrompt: overrides.agentTaskPrompt ?? bodyPrompt,
      chatSessionId: typeof body.chat_session_id === 'string' ? body.chat_session_id : null,
      parentMessageId: normalizeMessageId(body.parent_message_id),
      promptOptions: {
        modelType: typeof body.model_type === 'string' ? body.model_type : null,
        searchEnabled: body.search_enabled === true,
        thinkingEnabled: body.thinking_enabled === true,
        refFileIds: Array.isArray(body.ref_file_ids) ? body.ref_file_ids.filter((item): item is string => typeof item === 'string') : [],
      },
    };
  } catch {
    return {
      originalPrompt: overrides.originalPrompt ?? '',
      agentTaskPrompt: overrides.agentTaskPrompt ?? overrides.originalPrompt ?? '',
      chatSessionId: null,
      parentMessageId: null,
      promptOptions: {
        modelType: null,
        searchEnabled: false,
        thinkingEnabled: false,
        refFileIds: [],
      },
    };
  }
}

function isChatStreamURL(url: string): boolean {
  return CHAT_STREAM_PATHS.some((path) => url.includes(path));
}

function hasBypassHookHeader(headers: HeadersInit | undefined): boolean {
  if (!headers) return false;
  return new Headers(headers).has(BYPASS_HOOK_HEADER);
}

function stripBypassHookHeader(headers: HeadersInit | undefined): HeadersInit | undefined {
  if (!headers) return headers;
  const next = new Headers(headers);
  next.delete(BYPASS_HOOK_HEADER);
  return next;
}

function normalizeMessageId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function modifyRequestBody(bodyStr: string): RequestBodyModification | null {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyStr);
  } catch {
    return null;
  }

  const originalPrompt = (body.prompt as string) || '';
  if (!originalPrompt) return null;

  const thinkingEnabled = body.thinking_enabled === true;
  const effectiveToolDescriptors = thinkingEnabled ? [] : hookState.toolDescriptors;
  const isFirstMessage = body.parent_message_id === null || body.parent_message_id === undefined;

  if (isFirstMessage) {
    hookState.messageCount = 0;
  }
  hookState.messageCount++;

  const shouldInjectPreset =
    hookState.activePreset &&
    (isFirstMessage || hookState.messageCount % PRESET_REINJECTION_INTERVAL === 0);

  const presetContent = shouldInjectPreset ? hookState.activePreset!.content : null;

  if (hookState.modelType) {
    body.model_type = hookState.modelType;
  }

  const invocation = parseSkillCommand(originalPrompt);
  if (invocation) {
    const resolved = resolveSkills(invocation.skillName, invocation.args);
    if (resolved) {
      let prompt = resolved.combinedPrompt;
      const anyMemoryEnabled = resolved.memoryEnabled;

      if (anyMemoryEnabled) {
        const { augmented } = buildPromptAugmentation(prompt, {
          memories: hookState.memories,
          thinkingEnabled,
          presetContent,
          toolDescriptors: effectiveToolDescriptors,
        });
        prompt = augmented;
      } else if (hookState.memories.length > 0) {
        const { augmented } = buildPromptAugmentation(prompt, {
          memories: hookState.memories,
          thinkingEnabled,
          identityOnly: true,
          presetContent,
          toolDescriptors: effectiveToolDescriptors,
        });
        prompt = augmented;
      } else if (presetContent) {
        prompt = `${presetContent}\n\n---\n\n${prompt}`;
      }

      body.prompt = prompt;
      return { body: JSON.stringify(body), agentTaskPrompt: resolved.combinedPrompt };
    }
  }

  const { augmented, usedMemoryIds } = buildPromptAugmentation(originalPrompt, {
    memories: hookState.memories,
    thinkingEnabled,
    presetContent,
    toolDescriptors: effectiveToolDescriptors,
  });
  body.prompt = augmented;

  if (usedMemoryIds.length > 0) {
    hookState.onMemoriesUsed(usedMemoryIds);
  }

  return { body: JSON.stringify(body), agentTaskPrompt: originalPrompt };
}

function hasExecutableMcpTools(descriptors: readonly ToolDescriptor[]): boolean {
  return descriptors.some((descriptor) =>
    descriptor.provider.kind === 'mcp' &&
    descriptor.execution.enabled &&
    descriptor.execution.mode !== 'disabled'
  );
}

interface ResolvedSkills {
  combinedPrompt: string;
  memoryEnabled: boolean;
}

function wrapUserInput(instructions: string, userInput: string): string {
  return `${instructions}\n\n---\n\n以下是用户本次的输入，请根据上述指令处理：\n\n${userInput}`;
}

function resolveSkills(skillName: string, args: string): ResolvedSkills | null {
  const primarySkill = hookState.skills.find((s) => s.name === skillName);
  if (!primarySkill) return null;

  const secondInvocation = parseSkillCommand('/' + args);
  if (secondInvocation) {
    const secondSkill = hookState.skills.find((s) => s.name === secondInvocation.skillName);
    if (secondSkill) {
      const userArgs = secondInvocation.args;
      const combinedInstructions = primarySkill.instructions + '\n\n---\n\n' + secondSkill.instructions;
      return {
        combinedPrompt: userArgs
          ? wrapUserInput(combinedInstructions, userArgs)
          : combinedInstructions,
        memoryEnabled: primarySkill.memoryEnabled || secondSkill.memoryEnabled,
      };
    }
  }

  return {
    combinedPrompt: args
      ? wrapUserInput(primarySkill.instructions, args)
      : primarySkill.instructions,
    memoryEnabled: primarySkill.memoryEnabled,
  };
}

function notifyNewToolCalls(
  fullText: string,
  alreadyNotified: number,
  descriptors: readonly ToolDescriptor[] = hookState.toolDescriptors,
): number {
  const calls = extractToolCalls(fullText, { descriptors });
  for (let i = alreadyNotified; i < calls.length; i++) {
    hookState.onToolCall(calls[i]);
  }
  return calls.length;
}

// --- SSE stream interception: strip XML tool-call blocks from text events ---

function isBatchPatch(parsed: any): boolean {
  return parsed?.o === 'BATCH' && Array.isArray(parsed.v);
}

function isFragmentCreationPatch(parsed: any): boolean {
  return parsed?.p === 'response/fragments' && parsed.o === 'APPEND' && Array.isArray(parsed.v);
}

function getDirectPatchText(parsed: any): string | null {
  if (!parsed?.p && typeof parsed?.v === 'string') return parsed.v;
  if (parsed?.p && parsed.o === 'APPEND' && typeof parsed.v === 'string') return parsed.v;
  if (isResponseTextPatchPath(parsed?.p) && typeof parsed.v === 'string' && !parsed.o) {
    return parsed.v;
  }
  if (isFragmentCreationPatch(parsed)) {
    const parts: string[] = [];
    for (const frag of parsed.v) {
      if (frag && typeof frag.content === 'string') parts.push(frag.content);
      else if (frag && typeof frag.text === 'string') parts.push(frag.text);
    }
    return parts.length > 0 ? parts.join('') : null;
  }
  return null;
}

function setDirectPatchText(parsed: any, value: string) {
  if (!parsed?.p && typeof parsed?.v === 'string') {
    parsed.v = value;
    return;
  }
  if (parsed?.p && parsed.o === 'APPEND' && typeof parsed.v === 'string') {
    parsed.v = value;
    return;
  }
  if (isResponseTextPatchPath(parsed?.p) && typeof parsed.v === 'string' && !parsed.o) {
    parsed.v = value;
    return;
  }
  if (isFragmentCreationPatch(parsed)) {
    let remaining = value;
    for (let i = 0; i < parsed.v.length; i++) {
      const frag = parsed.v[i];
      if (!frag) continue;
      if (typeof frag.content === 'string') {
        if (i === parsed.v.length - 1) {
          frag.content = remaining;
        } else {
          const portion = remaining.slice(0, frag.content.length);
          remaining = remaining.slice(frag.content.length);
          frag.content = portion;
        }
      } else if (typeof frag.text === 'string') {
        if (i === parsed.v.length - 1) {
          frag.text = remaining;
        } else {
          const portion = remaining.slice(0, frag.text.length);
          remaining = remaining.slice(frag.text.length);
          frag.text = portion;
        }
      }
    }
  }
}

function shouldEmitSanitizedTextPatch(parsed: any): boolean {
  return isBatchPatch(parsed) || isFragmentCreationPatch(parsed);
}

function collectAssistantMessageId(parsed: unknown, current: number | null): number | null {
  if (!parsed || typeof parsed !== 'object') return current;
  const value = parsed as Record<string, unknown>;
  const direct = normalizeMessageId(value.response_message_id) ?? normalizeMessageId(value.responseMessageId);
  if (direct !== null) return direct;

  if (typeof value.p === 'string' && value.p.includes('response_message_id')) {
    const id = normalizeMessageId(value.v);
    if (id !== null) return id;
  }

  if (value.o === 'BATCH' && Array.isArray(value.v)) {
    return value.v.reduce((next, item) => collectAssistantMessageId(item, next), current);
  }

  if (Array.isArray(value.v)) {
    return value.v.reduce((next, item) => collectAssistantMessageId(item, next), current);
  }

  if (value.v && typeof value.v === 'object') {
    return collectAssistantMessageId(value.v, current);
  }

  return current;
}

function createResponseTokenSpeedTracker() {
  const startedAt = performance.now();
  let lastEmitAt = 0;
  let totalTokenUnits = 0;
  let textLength = 0;
  let finished = false;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  const getAverageTokensPerSecond = (now: number): number => {
    const elapsedMs = Math.max(now - startedAt, 1);
    return totalTokenUnits / (elapsedMs / 1000);
  };

  const emit = (active: boolean, force = false) => {
    if (finished && active) return;

    const now = performance.now();
    if (!force && now - lastEmitAt < TOKEN_SPEED_EMIT_INTERVAL_MS) return;
    lastEmitAt = now;

    const elapsedMs = Math.max(now - startedAt, 1);
    hookState.onResponseTokenSpeed({
      active,
      estimatedTokens: Math.round(totalTokenUnits),
      tokensPerSecond: getAverageTokensPerSecond(now),
      elapsedMs: Math.round(elapsedMs),
      textLength,
    });
  };

  emit(true, true);
  tickTimer = setInterval(() => emit(true, true), TOKEN_SPEED_EMIT_INTERVAL_MS);

  return {
    append(text: string) {
      if (!text) return;
      const tokenUnits = estimateTokenUnits(text);
      textLength += text.length;
      totalTokenUnits += tokenUnits;
      emit(true);
    },
    finish() {
      if (finished) return;
      finished = true;
      if (tickTimer !== null) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      emit(false, true);
    },
  };
}

function cloneParsedWithTextPrefix(parsed: any, keepChars: number): any | null {
  const cloned = JSON.parse(JSON.stringify(parsed));
  let remaining = Math.max(0, keepChars);
  let touchedText = false;

  const apply = (node: any) => {
    if (!node || typeof node !== 'object') return;

    if (isBatchPatch(node)) {
      for (const item of node.v) {
        apply(item);
      }
      return;
    }

    const text = getDirectPatchText(node);
    if (text === null) return;

    touchedText = true;
    const nextText = remaining > 0 ? text.slice(0, remaining) : '';
    remaining = Math.max(0, remaining - text.length);
    setDirectPatchText(node, nextText);
  };

  apply(cloned);

  if (!touchedText) return null;
  if (keepChars <= 0 && !shouldEmitSanitizedTextPatch(cloned)) return null;
  return cloned;
}

function cloneParsedWithTextSuffix(parsed: any, skipChars: number): any | null {
  const cloned = JSON.parse(JSON.stringify(parsed));
  let remainingSkip = Math.max(0, skipChars);
  let touchedText = false;
  let keptText = false;

  const apply = (node: any) => {
    if (!node || typeof node !== 'object') return;

    if (isBatchPatch(node)) {
      for (const item of node.v) {
        apply(item);
      }
      return;
    }

    const text = getDirectPatchText(node);
    if (text === null) return;

    touchedText = true;
    if (remainingSkip >= text.length) {
      remainingSkip -= text.length;
      setDirectPatchText(node, '');
      return;
    }

    const nextText = text.slice(remainingSkip);
    remainingSkip = 0;
    if (nextText.length > 0) keptText = true;
    setDirectPatchText(node, nextText);
  };

  apply(cloned);

  if (!touchedText || !keptText) return null;
  return cloned;
}

class XmlToolStreamFilter {
  private catalog: ToolInvocationCatalog;
  private toolOpenTags: string[];
  private state: 'NORMAL' | 'SUPPRESSING' = 'NORMAL';
  private currentTool: string | null = null;
  private pendingText = '';
  private pendingBlocks: Array<{ block: string; isFragmentCreation: boolean; parsed: any }> = [];
  private chunkBuffer = '';
  private encoder = new TextEncoder();

  constructor(descriptors: readonly ToolDescriptor[] = DEFAULT_TOOL_DESCRIPTORS) {
    this.catalog = createToolInvocationCatalog(descriptors);
    // Always recognize shell tool names for filtering, even if not in descriptors
    for (const name of SHELL_TOOL_NAMES) {
      if (!this.catalog.invocationNames.includes(name)) {
        this.catalog.invocationNames.push(name);
      }
    }
    this.toolOpenTags = this.catalog.invocationNames.map(getToolOpenTag);
  }

  processChunk(chunk: string, controller: ReadableStreamDefaultController<Uint8Array>) {
    this.chunkBuffer += chunk;

    // Find last complete event boundary
    const lastBoundary = this.chunkBuffer.lastIndexOf('\n\n');
    if (lastBoundary === -1) {
      // No complete events yet — buffer until we have one
      return;
    }

    // Extract complete events; keep partial remainder for next chunk
    const completePart = this.chunkBuffer.slice(0, lastBoundary);
    this.chunkBuffer = this.chunkBuffer.slice(lastBoundary + 2);

    this.processBlocks(completePart, controller);
  }

  private processBlocks(text: string, controller: ReadableStreamDefaultController<Uint8Array>) {
    const blocks = text.split('\n\n');

    for (const block of blocks) {
      if (!block.trim()) continue;

      const dataLine = block.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) {
        this.emit(controller, block);
        continue;
      }

      const jsonStr = dataLine.slice(5).trim();
      const parsed = parseSSEData(jsonStr);
      if (!parsed) {
        this.emit(controller, block);
        continue;
      }

      const text = extractTextFromParsed(parsed);
      if (text === null) {
        // Non-text event — always pass through
        this.emit(controller, block);
        continue;
      }

      // Determine if this event is a "structural" one (fragment creation) that must pass through
      const isFragmentCreation = isFragmentCreationPatch(parsed);

      // Text event — apply state machine
      if (this.state === 'SUPPRESSING') {
        const previousPendingLength = this.pendingText.length;
        this.pendingText += text;
        const closeTag = getToolCloseTag(this.currentTool!);
        const closeIdx = this.pendingText.indexOf(closeTag);
        if (closeIdx !== -1) {
          const tailStart = closeIdx + closeTag.length;
          const tailOffsetInCurrentText = tailStart - previousPendingLength;
          const toolTail = this.getCurrentToolTail(parsed, text, isFragmentCreation, tailOffsetInCurrentText);
          this.state = 'NORMAL';
          this.pendingText = '';
          this.currentTool = null;
          if (toolTail) {
            this.processNormalTextBlock(controller, toolTail.block, toolTail.parsed, toolTail.text, toolTail.isFragmentCreation);
          }
          continue;
        }
        if (isFragmentCreation || isBatchPatch(parsed)) {
          const modified = cloneParsedWithTextPrefix(parsed, 0);
          if (modified) {
            this.emit(controller, 'data: ' + JSON.stringify(modified));
          }
        }
        continue;
      }

      // State: NORMAL
      this.processNormalTextBlock(controller, block, parsed, text, isFragmentCreation);
    }
  }

  private processNormalTextBlock(
    controller: ReadableStreamDefaultController<Uint8Array>,
    block: string,
    parsed: any,
    text: string,
    isFragmentCreation: boolean,
  ) {
    const previousPendingLength = this.pendingText.length;
    this.pendingText += text;
    this.pendingBlocks.push({ block, isFragmentCreation, parsed });

    const found = this.findFirstToolOpen(this.pendingText);
    if (found) {
      const closeTag = getToolCloseTag(found.tool);
      const closeIdx = this.pendingText.indexOf(closeTag, found.idx + getToolOpenTag(found.tool).length);
      const tailStart = closeIdx === -1 ? -1 : closeIdx + closeTag.length;
      const tailOffsetInCurrentText = tailStart - previousPendingLength;

      this.emitBlocksBeforeOpen(controller, found.idx);
      this.pendingBlocks = [];

      if (closeIdx === -1) {
        this.state = 'SUPPRESSING';
        this.currentTool = found.tool;
        this.pendingText = this.pendingText.slice(found.idx);
        return;
      }

      this.state = 'NORMAL';
      this.currentTool = null;
      this.pendingText = '';
      const toolTail = this.getCurrentToolTail(parsed, text, isFragmentCreation, tailOffsetInCurrentText);
      if (toolTail) {
        this.processNormalTextBlock(controller, toolTail.block, toolTail.parsed, toolTail.text, toolTail.isFragmentCreation);
      }
      return;
    }

    if (this.couldBePartialToolOpen(this.pendingText)) {
      return;
    }

    // Safe — flush all pending
    for (const b of this.pendingBlocks) {
      this.emit(controller, b.block);
    }
    this.pendingBlocks = [];
    this.pendingText = '';
  }

  private getCurrentToolTail(
    parsed: any,
    text: string,
    isFragmentCreation: boolean,
    tailOffsetInCurrentText: number,
  ): { block: string; parsed: any; text: string; isFragmentCreation: boolean } | null {
    if (tailOffsetInCurrentText >= text.length) return null;

    const modified = cloneParsedWithTextSuffix(parsed, Math.max(0, tailOffsetInCurrentText));
    if (!modified) return null;

    const modifiedText = extractTextFromParsed(modified);
    if (!modifiedText) return null;

    return {
      block: 'data: ' + JSON.stringify(modified),
      parsed: modified,
      text: modifiedText,
      isFragmentCreation: isFragmentCreation || isFragmentCreationPatch(modified),
    };
  }

  flush(controller: ReadableStreamDefaultController<Uint8Array>) {
    // Process any remaining buffered chunk data
    if (this.chunkBuffer.trim()) {
      this.processBlocks(this.chunkBuffer, controller);
      this.chunkBuffer = '';
    }
    // Flush any unsent pending blocks (they were buffered as potential tool start but never confirmed)
    for (const b of this.pendingBlocks) {
      this.emit(controller, b.block);
    }
    this.pendingBlocks = [];
    this.pendingText = '';
  }

  private emit(controller: ReadableStreamDefaultController<Uint8Array>, block: string) {
    controller.enqueue(this.encoder.encode(block + '\n\n'));
  }

  private findFirstToolOpen(text: string): { idx: number; tool: string } | null {
    let best: { idx: number; tool: string } | null = null;
    for (const tool of this.catalog.invocationNames) {
      const open = getToolOpenTag(tool);
      const idx = text.indexOf(open);
      if (idx >= 0 && (best === null || idx < best.idx)) {
        best = { idx, tool };
      }
    }
    return best;
  }

  private couldBePartialToolOpen(text: string): boolean {
    for (const open of this.toolOpenTags) {
      const maxLen = Math.min(text.length, open.length - 1);
      for (let len = maxLen; len > 0; len--) {
        if (open.startsWith(text.slice(-len))) {
          return true;
        }
      }
    }
    return false;
  }

  private emitBlocksBeforeOpen(controller: ReadableStreamDefaultController<Uint8Array>, idx: number) {
    let charsSeen = 0;

    for (const entry of this.pendingBlocks) {
      const text = extractTextFromParsed(entry.parsed);
      if (text === null) {
        this.emit(controller, entry.block);
        continue;
      }
      if (charsSeen + text.length <= idx) {
        this.emit(controller, entry.block);
        charsSeen += text.length;
      } else {
        const keepChars = idx - charsSeen;
        if (keepChars > 0 || entry.isFragmentCreation || isBatchPatch(entry.parsed)) {
          const modified = cloneParsedWithTextPrefix(entry.parsed, keepChars);
          if (modified) {
            this.emit(controller, 'data: ' + JSON.stringify(modified));
          }
        }
        break;
      }
    }
  }
}

async function interceptFetchResponse(
  responsePromise: Promise<Response>,
  requestContext: RequestContext,
): Promise<Response> {
  const response = await responsePromise;
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toolDescriptors = hookState.toolDescriptors;
  const filter = new XmlToolStreamFilter(toolDescriptors);
  let fullText = '';
  let notifiedCount = 0;
  let textAccBuffer = '';
  let assistantMessageId: number | null = null;
  const speedTracker = createResponseTokenSpeedTracker();

  const processForFullText = (text: string) => {
    textAccBuffer += text;
    const lastBoundary = textAccBuffer.lastIndexOf('\n\n');
    if (lastBoundary === -1) return;
    const completePart = textAccBuffer.slice(0, lastBoundary + 2);
    textAccBuffer = textAccBuffer.slice(lastBoundary + 2);

    const events = parseSSEChunk(completePart);
    for (const event of events) {
      const parsed = parseSSEData(event.data);
      if (!parsed) continue;
      const eventText = extractTextFromParsed(parsed);
      if (eventText) {
        fullText += eventText;
        speedTracker.append(eventText);
        notifiedCount = notifyNewToolCalls(fullText, notifiedCount, toolDescriptors);
      } else if (isThinkingPatchPath((parsed as any)?.p) && typeof (parsed as any)?.v === 'string') {
        speedTracker.append((parsed as any).v);
      }
      if (isStreamFinishedFromParsed(parsed)) {
        speedTracker.finish();
      }
      assistantMessageId = collectAssistantMessageId(parsed, assistantMessageId);
    }
  };

  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Drain any remaining buffered events for fullText
            if (textAccBuffer.trim()) {
              const events = parseSSEChunk(textAccBuffer);
              for (const event of events) {
                const parsed = parseSSEData(event.data);
                if (!parsed) continue;
                const eventText = extractTextFromParsed(parsed);
                if (eventText) {
                  fullText += eventText;
                  speedTracker.append(eventText);
                  notifiedCount = notifyNewToolCalls(fullText, notifiedCount, toolDescriptors);
                } else if (isThinkingPatchPath((parsed as any)?.p) && typeof (parsed as any)?.v === 'string') {
                  speedTracker.append((parsed as any).v);
                }
                assistantMessageId = collectAssistantMessageId(parsed, assistantMessageId);
              }
              textAccBuffer = '';
            }
            filter.flush(controller);
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          processForFullText(chunk);
          filter.processChunk(chunk, controller);
        }
      } finally {
        speedTracker.finish();
      }

      if (cancelled) return;

      // Stream ended — execute any detected tool calls
      try {
        const calls = extractToolCalls(fullText, { descriptors: toolDescriptors });
        if (calls.length > 0) {
          for (const call of calls.slice(notifiedCount)) {
            if (cancelled) break;
            await hookState.onToolCallExecuted(call);
          }
        }

        if (!cancelled) {
          hookState.onResponseComplete({
            text: fullText,
            originalPrompt: requestContext.originalPrompt,
            agentTaskPrompt: requestContext.agentTaskPrompt,
            chatSessionId: requestContext.chatSessionId,
            parentMessageId: requestContext.parentMessageId,
            assistantMessageId,
            promptOptions: requestContext.promptOptions,
          });
        }
      } finally {
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      speedTracker.finish();
      reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function setupXHRResponseInterceptor(xhr: XMLHttpRequest, requestContext: RequestContext) {
  let fullText = '';
  let lastLen = 0;
  let notifiedCount = 0;
  let completed = false;
  let filteredResponse = '';
  let assistantMessageId: number | null = null;
  const toolDescriptors = hookState.toolDescriptors;
  const filter = new XmlToolStreamFilter(toolDescriptors);
  const speedTracker = createResponseTokenSpeedTracker();

  const finalizeIfNeeded = () => {
    if (completed) return;
    completed = true;
    notifiedCount = notifyNewToolCalls(fullText, notifiedCount, toolDescriptors);
    speedTracker.finish();
    hookState.onResponseComplete({
      text: fullText,
      originalPrompt: requestContext.originalPrompt,
      agentTaskPrompt: requestContext.agentTaskPrompt,
      chatSessionId: requestContext.chatSessionId,
      parentMessageId: requestContext.parentMessageId,
      assistantMessageId,
      promptOptions: requestContext.promptOptions,
    });
  };

  const origResponseTextDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText') ||
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(XMLHttpRequest.prototype), 'responseText');

  // Create a fake controller that accumulates filtered text
  const fakeController = {
    enqueue(data: Uint8Array) {
      filteredResponse += new TextDecoder().decode(data);
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;

  xhr.addEventListener('readystatechange', function () {
    if (xhr.readyState === 3 || xhr.readyState === 4) {
      const raw = origResponseTextDesc?.get?.call(xhr) || '';
      const newData = raw.slice(lastLen);
      lastLen = raw.length;
      if (newData) {
        // Track full text
        const events = parseSSEChunk(newData);
        for (const event of events) {
          const parsed = parseSSEData(event.data);
          if (!parsed) continue;
          const text = extractTextFromParsed(parsed);
          if (text) {
            fullText += text;
            speedTracker.append(text);
            notifiedCount = notifyNewToolCalls(fullText, notifiedCount, toolDescriptors);
          }
          if (isStreamFinishedFromParsed(parsed)) {
            speedTracker.finish();
          }
          assistantMessageId = collectAssistantMessageId(parsed, assistantMessageId);
        }
        // Filter for frontend
        filter.processChunk(newData, fakeController);
      }
    }
    if (xhr.readyState === 4) {
      filter.flush(fakeController);
      finalizeIfNeeded();
    }
  });

  Object.defineProperty(xhr, 'responseText', {
    get() { return filteredResponse; },
    configurable: true,
  });
  Object.defineProperty(xhr, 'response', {
    get() {
      if (xhr.responseType === '' || xhr.responseType === 'text') {
        return filteredResponse;
      }
      return undefined;
    },
    configurable: true,
  });
}

// --- History API interception: strip tool-call blocks from saved messages ---

async function interceptHistoryResponse(responsePromise: Promise<Response>): Promise<Response> {
  const response = await responsePromise;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('json')) return response;

  try {
    const json = await response.json();
    stripToolCallsFromHistory(json);
    return new Response(JSON.stringify(json), {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  } catch {
    return response;
  }
}

function setupXHRHistoryInterceptor(xhr: XMLHttpRequest) {
  const origResponseTextDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText') ||
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(XMLHttpRequest.prototype), 'responseText');

  let cachedFiltered: string | null = null;

  Object.defineProperty(xhr, 'responseText', {
    get() {
      const raw = origResponseTextDesc?.get?.call(xhr) || '';
      if (xhr.readyState < 4) return raw;
      if (cachedFiltered !== null) return cachedFiltered;
      try {
        const json = JSON.parse(raw);
        stripToolCallsFromHistory(json);
        cachedFiltered = JSON.stringify(json);
      } catch {
        cachedFiltered = raw;
      }
      return cachedFiltered;
    },
  });

  // Also override response for XHR response getter
  Object.defineProperty(xhr, 'response', {
    get() {
      if (xhr.responseType === '' || xhr.responseType === 'text') {
        const raw = origResponseTextDesc?.get?.call(xhr) || '';
        if (xhr.readyState < 4) return raw;
        if (cachedFiltered !== null) return cachedFiltered;
        try {
          const json = JSON.parse(raw);
          stripToolCallsFromHistory(json);
          cachedFiltered = JSON.stringify(json);
        } catch {
          cachedFiltered = raw;
        }
        return cachedFiltered;
      }
      return xhr.response;
    },
  });
}

function hasToolCallMarker(text: string): boolean {
  const catalog = createToolInvocationCatalog(hookState.toolDescriptors);
  if (hasXmlToolMarker(text, catalog)) return true;
  // Legacy: also detect old DSML markers in historical data
  return text.includes('｜DSML｜');
}

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function getMessageRestoreKey(msg: any, index: number): string {
  return String(msg?.id ?? msg?.message_id ?? msg?.uuid ?? msg?.parent_message_id ?? index);
}

function collectToolCallRestoreRecord(text: string, key: string): ToolCallRestoreRecord | null {
  if (!hasToolCallMarker(text)) return null;

  const calls = extractToolCalls(text, { descriptors: hookState.toolDescriptors });
  if (calls.length === 0) return null;

  const content = stripToolCalls(text, { descriptors: hookState.toolDescriptors });
  const id = hashString(`${key}\n${content}\n${calls.map((call) => call.raw).join('\n')}`);
  return {
    id,
    calls,
    content,
    source: 'history',
  };
}

function stripToolCallsFromHistory(json: any) {
  if (!json || !json.data) return;
  const data = json.data.biz_data || json.data;
  const messages = data.chat_messages;
  if (!Array.isArray(messages)) return;

  const restoredRecords: ToolCallRestoreRecord[] = [];
  const visibleMessages = messages.filter((msg: any) => !isInternalManagedAgentMessage(msg));
  if (visibleMessages.length !== messages.length) {
    data.chat_messages = visibleMessages;
  }

  visibleMessages.forEach((msg: any, index: number) => {
    const messageKey = getMessageRestoreKey(msg, index);
    if (typeof msg.content === 'string' && hasToolCallMarker(msg.content)) {
      const record = collectToolCallRestoreRecord(msg.content, `${messageKey}:content`);
      if (record) restoredRecords.push(record);
      msg.content = stripToolCalls(msg.content, { descriptors: hookState.toolDescriptors });
    }
    if (msg.fragments && Array.isArray(msg.fragments)) {
      msg.fragments.forEach((frag: any, fragIndex: number) => {
        if (typeof frag.content === 'string' && hasToolCallMarker(frag.content)) {
          const record = collectToolCallRestoreRecord(frag.content, `${messageKey}:fragment:${fragIndex}`);
          if (record) restoredRecords.push(record);
          frag.content = stripToolCalls(frag.content, { descriptors: hookState.toolDescriptors });
        }
      });
    }
  });

  if (restoredRecords.length > 0) {
    hookState.onToolCallsRestored(restoredRecords);
  }
}

function isInternalManagedAgentMessage(msg: any): boolean {
  if (!msg || typeof msg !== 'object') return false;
  if (typeof msg.content === 'string' && isInternalManagedAgentContent(msg.content)) return true;
  if (!Array.isArray(msg.fragments)) return false;
  return msg.fragments.some((frag: any) => typeof frag?.content === 'string' && isInternalManagedAgentContent(frag.content));
}

function isInternalManagedAgentContent(content: string): boolean {
  if (content.includes(DPP_MANAGED_AGENT_PROMPT_MARKER)) return true;
  if (content.includes('DeepSeek++ 托管 Agent Runner') && content.includes('<tool_results>')) return true;
  return content.includes('Tool call format reminder:') &&
    content.includes('Available tool tag names:') &&
    content.includes('<original_user_task>') &&
    content.includes('</original_user_task>');
}

// --- IndexedDB interception: strip tool-call blocks from cached messages ---

function hookIndexedDB() {
  const origGet = IDBObjectStore.prototype.get;
  const origGetAll = IDBObjectStore.prototype.getAll;

  IDBObjectStore.prototype.get = function (...args) {
    const request = origGet.apply(this, args);
    if (this.name === 'history-message') {
      patchIDBRequest(request);
    }
    return request;
  };

  IDBObjectStore.prototype.getAll = function (...args) {
    const request = origGetAll.apply(this, args);
    if (this.name === 'history-message') {
      patchIDBRequest(request);
    }
    return request;
  };
}

function patchIDBRequest(request: IDBRequest) {
  const origResultDesc = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result');
  if (!origResultDesc) return;

  let cleaned = false;

  Object.defineProperty(request, 'result', {
    get() {
      const result = origResultDesc.get!.call(this);
      if (result && !cleaned) {
        cleaned = true;
        stripToolCallsFromIDBResult(result);
      }
      return result;
    },
  });
}

function stripToolCallsFromIDBResult(result: any) {
  const restoredRecords: ToolCallRestoreRecord[] = [];

  if (Array.isArray(result)) {
    for (const item of result) {
      stripSingleIDBRecord(item, restoredRecords);
    }
  } else {
    stripSingleIDBRecord(result, restoredRecords);
  }

  if (restoredRecords.length > 0) {
    hookState.onToolCallsRestored(restoredRecords);
  }
}

function stripSingleIDBRecord(record: any, restoredRecords: ToolCallRestoreRecord[]) {
  if (!record || !record.data) return;
  const data = record.data;
  const messages = data.chat_messages;
  if (!Array.isArray(messages)) return;

  const visibleMessages = messages.filter((msg: any) => !isInternalManagedAgentMessage(msg));
  if (visibleMessages.length !== messages.length) {
    data.chat_messages = visibleMessages;
  }

  visibleMessages.forEach((msg: any, index: number) => {
    const messageKey = getMessageRestoreKey(msg, index);
    if (typeof msg.content === 'string' && hasToolCallMarker(msg.content)) {
      const record = collectToolCallRestoreRecord(msg.content, `${messageKey}:content`);
      if (record) restoredRecords.push(record);
      msg.content = stripToolCalls(msg.content, { descriptors: hookState.toolDescriptors });
    }
    if (msg.fragments && Array.isArray(msg.fragments)) {
      msg.fragments.forEach((frag: any, fragIndex: number) => {
        if (typeof frag.content === 'string' && hasToolCallMarker(frag.content)) {
          const record = collectToolCallRestoreRecord(frag.content, `${messageKey}:fragment:${fragIndex}`);
          if (record) restoredRecords.push(record);
          frag.content = stripToolCalls(frag.content, { descriptors: hookState.toolDescriptors });
        }
      });
    }
  });
}
