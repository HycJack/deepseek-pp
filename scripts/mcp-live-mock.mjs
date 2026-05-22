import http from 'node:http';
import assert from 'node:assert/strict';

const TOOL_NAME = 'echo';
const INVOCATION_NAME = 'mcp_mock_echo';

const serverConfig = {
  id: 'mock',
  displayName: 'Mock MCP',
  enabled: true,
  transport: {
    kind: 'streamable_http',
    url: '',
  },
  execution: {
    mode: 'auto',
    enabled: true,
  },
};

const descriptor = {
  id: `mcp:${serverConfig.id}:${TOOL_NAME}`,
  provider: {
    kind: 'mcp',
    id: serverConfig.id,
    displayName: serverConfig.displayName,
    transport: serverConfig.transport.kind,
  },
  name: TOOL_NAME,
  invocationName: INVOCATION_NAME,
  title: 'Echo',
  description: 'Return the text argument.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
    },
    required: ['text'],
  },
  execution: {
    mode: 'auto',
    enabled: true,
    risk: 'medium',
  },
};

const { server, url } = await startMockMcpServer();
serverConfig.transport.url = url;

if (process.argv.includes('--serve')) {
  console.log(`mock MCP server: ${url}`);
  console.log('Press Ctrl+C to stop.');
  await new Promise((resolve) => {
    const done = () => {
      server.close(resolve);
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
} else {
  try {
    await verifyManualContinuation();
    await verifyAutomationContinuation();
    console.log('mcp live mock: manual continuation ok');
    console.log('mcp live mock: automation continuation/history ok');
    console.log(`mcp live mock: server ${url}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function verifyManualContinuation() {
  const assistantText = `Need data.\n<${INVOCATION_NAME}>{"text":"manual"}</${INVOCATION_NAME}>`;
  const executions = await executeToolCalls(assistantText, 'manual_chat');
  assert.equal(executions.length, 1);
  assert.equal(executions[0].result.ok, true);
  assert.equal(executions[0].result.output.echoed, 'manual');

  const continuation = buildToolResultsPrompt(executions);
  assert.match(continuation, /<tool_results>/);
  assert.match(continuation, /manual/);
  assert.match(continuation, /不要再调用任何工具/);
  assert.equal(executeToolCallsInManualContinuation(
    '<memory_save>{"type":"topic","name":"n","content":"c","tags":[]}</memory_save>',
  ).length, 0);
  assert.equal(stripToolCalls(assistantText).trim(), 'Need data.');
}

async function verifyAutomationContinuation() {
  const history = [];
  let assistantText = `Run automation tool.\n<${INVOCATION_NAME}>{"text":"automation"}</${INVOCATION_NAME}>`;
  const allExecutions = [];

  for (let depth = 0; depth < 3; depth++) {
    const executions = await executeToolCalls(assistantText, 'automation');
    if (executions.length === 0) break;
    allExecutions.push(...executions);
    history.push(...executions.map((execution) => ({
      source: 'automation',
      call: execution.call,
      result: execution.result,
    })));

    const continuation = buildToolResultsPrompt(executions);
    assert.match(continuation, /automation/);
    assistantText = 'Final answer after tool results.';
  }

  assert.equal(allExecutions.length, 1);
  assert.equal(history.length, 1);
  assert.equal(history[0].source, 'automation');
  assert.equal(history[0].call.provider.kind, 'mcp');
  assert.equal(history[0].result.output.echoed, 'automation');
}

async function executeToolCalls(text, trigger) {
  const calls = extractToolCalls(text);
  const executions = [];
  for (const call of calls) {
    const result = await callMcpTool(call);
    executions.push({ call: { ...call, source: { trigger } }, result });
  }
  return executions;
}

function executeToolCallsInManualContinuation(_text) {
  return [];
}

function extractToolCalls(text) {
  const regex = new RegExp(`<${INVOCATION_NAME}>\\s*([\\s\\S]*?)\\s*<\\/${INVOCATION_NAME}>`, 'g');
  const calls = [];
  let match;
  while ((match = regex.exec(text))) {
    calls.push({
      descriptorId: descriptor.id,
      provider: descriptor.provider,
      name: descriptor.name,
      invocationName: descriptor.invocationName,
      payload: JSON.parse(match[1]),
      raw: match[0],
    });
  }
  return calls;
}

function stripToolCalls(text) {
  return text.replace(new RegExp(`<${INVOCATION_NAME}>\\s*[\\s\\S]*?\\s*<\\/${INVOCATION_NAME}>`, 'g'), '');
}

async function callMcpTool(call) {
  const result = await requestJsonRpc('tools/call', {
    name: call.name,
    arguments: call.payload,
  });
  const output = result.structuredContent ?? null;
  return {
    ok: result.isError !== true,
    summary: result.isError ? 'MCP 工具返回错误' : 'MCP 工具已执行',
    detail: JSON.stringify(output, null, 2),
    output,
    provider: call.provider,
    descriptorId: call.descriptorId,
    name: call.name,
  };
}

function buildToolResultsPrompt(executions) {
  const lines = executions.map((execution, index) => JSON.stringify({
    index: index + 1,
    tool: execution.call.name,
    provider: execution.call.provider.displayName,
    ok: execution.result.ok,
    summary: execution.result.summary,
    output: execution.result.output,
  }));
  return [
    '以下是刚才自动执行的 MCP 工具结果。请基于这些结果继续回答用户。',
    '这是最终回答续写轮次：不要再调用任何工具，不要输出任何 XML 工具标签，不要保存或更新记忆。',
    '如果结果已经足够，请直接给出最终回答；如果结果不足，请说明缺少什么信息。',
    '',
    '<tool_results>',
    lines.join('\n'),
    '</tool_results>',
  ].join('\n');
}

function startMockMcpServer() {
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }

    const message = JSON.parse(await readBody(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: routeJsonRpc(message),
    }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address === 'object');
      resolve({ server, url: `http://127.0.0.1:${address.port}/mcp` });
    });
  });
}

function routeJsonRpc(message) {
  if (message.method === 'initialize') {
    return {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-mcp', version: '1.0.0' },
    };
  }
  if (message.method === 'tools/list') {
    return {
      tools: [{
        name: TOOL_NAME,
        title: 'Echo',
        description: 'Return the text argument.',
        inputSchema: descriptor.inputSchema,
      }],
    };
  }
  if (message.method === 'tools/call') {
    return {
      content: [{ type: 'text', text: `echo:${message.params?.arguments?.text ?? ''}` }],
      structuredContent: { echoed: message.params?.arguments?.text ?? '' },
      isError: false,
    };
  }
  return {};
}

async function requestJsonRpc(method, params) {
  const response = await fetch(serverConfig.transport.url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });
  assert.equal(response.ok, true);
  const data = await response.json();
  return data.result;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
