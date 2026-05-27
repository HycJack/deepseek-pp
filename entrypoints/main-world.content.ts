import {
  installFetchHook,
  updateHookState,
  type ResponseCompletePayload,
  type ResponseTokenSpeedPayload,
} from '../core/interceptor/fetch-hook';
import { initSkillPopup } from '../core/ui/skill-popup';
import type {
  Memory,
  ModelType,
  Skill,
  SystemPromptPreset,
  ToolCall,
  ToolCallRestoreRecord,
  ToolDescriptor,
  ToolResult,
} from '../core/types';
import {
  AGENT_WINDOW_RUN_RESULT,
  AGENT_BRIDGE_TIMEOUT_MS,
  MAIN_WORLD_WINDOW_SOURCE,
  createAgentRunFailure,
  isAgentWindowRunRequestMessage,
} from '../core/agent/messages';
import { runDeepSeekAgentRun } from '../core/agent/deepseek-runner';
import type { AgentRunRequest, AgentRunResult } from '../core/agent/types';

export default defineContentScript({
  matches: ['*://chat.deepseek.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installFetchHook();

    updateHookState({
      onToolCall(call: ToolCall) {
        window.postMessage({
          source: 'deepseek-pp-main',
          type: 'TOOL_CALL',
          data: call,
        });
      },
      async onToolCallExecuted(call: ToolCall) {
        return new Promise((resolve) => {
          const id = Math.random().toString(36).slice(2);
          const timeout = setTimeout(() => {
            window.removeEventListener('message', handler);
            resolve({ ok: false, summary: 'Tool execution timed out (bridge timeout)' });
          }, AGENT_BRIDGE_TIMEOUT_MS);
          const handler = (event: MessageEvent) => {
            if (event.data?.source !== 'deepseek-pp-content') return;
            if (event.data.type !== 'TOOL_CALL_RESULT' || event.data.id !== id) return;
            clearTimeout(timeout);
            window.removeEventListener('message', handler);
            resolve(event.data.result);
          };
          window.addEventListener('message', handler);
          window.postMessage({
            source: 'deepseek-pp-main',
            type: 'EXECUTE_TOOL_CALL',
            data: call,
            id,
          });
        });
      },
      onToolCallsRestored(records: ToolCallRestoreRecord[]) {
        window.postMessage({
          source: 'deepseek-pp-main',
          type: 'RESTORE_TOOL_CALLS',
          records,
        });
      },
      onResponseComplete(complete: ResponseCompletePayload) {
        window.postMessage({
          source: 'deepseek-pp-main',
          type: 'RESPONSE_COMPLETE',
          payload: complete,
        });
      },
      onResponseTokenSpeed(progress: ResponseTokenSpeedPayload) {
        window.postMessage({
          source: 'deepseek-pp-main',
          type: 'RESPONSE_TOKEN_SPEED',
          payload: progress,
        });
      },
      onMemoriesUsed(ids: number[]) {
        window.postMessage({
          source: 'deepseek-pp-main',
          type: 'MEMORIES_USED',
          ids,
        });
      },
    });

    window.addEventListener('message', (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.source !== 'deepseek-pp-content') return;

      if (isAgentWindowRunRequestMessage(event.data)) {
        void handleAgentRunRequest(event.data.id, event.data.payload);
        return;
      }

      switch (event.data.type) {
        case 'SYNC_STATE': {
          const { memories, skills, activePreset, modelType, toolDescriptors } = event.data as {
            memories: Memory[];
            skills: Skill[];
            activePreset: SystemPromptPreset | null;
            modelType: ModelType;
            toolDescriptors?: ToolDescriptor[];
          };
          updateHookState({ memories, skills, activePreset, modelType, ...(toolDescriptors ? { toolDescriptors } : {}) });
          initSkillPopup(skills);
          break;
        }
        case 'CONTINUE_WITH_TOOL_RESULTS': {
          void handleManualToolContinuation(event.data.id, event.data.payload);
          break;
        }
      }
    });
  },
});

async function handleAgentRunRequest(id: string, request: AgentRunRequest) {
  const result = await runAgentInMainWorld(request).catch((err): AgentRunResult =>
    createAgentRunFailure(
      request,
      'agent_main_world_failed',
      err instanceof Error ? err.message : String(err),
      'runner',
      true,
    ),
  );

  window.postMessage({
    source: MAIN_WORLD_WINDOW_SOURCE,
    type: AGENT_WINDOW_RUN_RESULT,
    id,
    result,
  });
}

async function handleManualToolContinuation(id: string, request: AgentRunRequest) {
  const result = await runDeepSeekAgentRun(request, {
    executeToolCall: executeToolCallViaContent,
  }).catch((err): AgentRunResult =>
    createAgentRunFailure(
      request,
      'manual_tool_continuation_failed',
      err instanceof Error ? err.message : String(err),
      'runner',
      true,
    ),
  );

  window.postMessage({
    source: MAIN_WORLD_WINDOW_SOURCE,
    type: 'MANUAL_TOOL_CONTINUATION_RESULT',
    id,
    result,
  });
}

async function runAgentInMainWorld(request: AgentRunRequest): Promise<AgentRunResult> {
  return runDeepSeekAgentRun(request, {
    executeToolCall: executeToolCallViaContent,
  });
}

function executeToolCallViaContent(call: ToolCall): Promise<ToolResult> {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ ok: false, summary: 'Tool execution timed out (bridge timeout)' });
    }, AGENT_BRIDGE_TIMEOUT_MS);
    const handler = (event: MessageEvent) => {
      if (event.data?.source !== 'deepseek-pp-content') return;
      if (event.data.type !== 'TOOL_CALL_RESULT' || event.data.id !== id) return;
      clearTimeout(timeout);
      window.removeEventListener('message', handler);
      resolve(event.data.result as ToolResult);
    };
    window.addEventListener('message', handler);
    window.postMessage({
      source: 'deepseek-pp-main',
      type: 'EXECUTE_TOOL_CALL',
      data: call,
      id,
    });
  });
}
