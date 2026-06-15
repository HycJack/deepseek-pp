# Module Inventory

## Summary

This inventory focuses on the browser-control alignment slice: Chromium CDP / `chrome.debugger`, Accessibility Tree UID snapshots, controlled tabs and tab groups, browser action tools, shared tool-loop integration, sidepanel UI, permissions, and validation.

| Module | Responsibility | Files / Lines | Complexity | S.U.P.E.R Score | Browser-Control Role |
|:--|:--|--:|:--|:--|:--|
| `core/tool` | Tool descriptors, invocation catalog, local runtime dispatch, tool history | 12 / ~1,840 | High | S🟡 U🟡 P🟡 E🟡 R🟡 | Add browser-control local provider |
| `core/tool-loop` | Sequential execution and continuation-loop helpers | 1 / ~89 | Low | S🟢 U🟢 P🟡 E🟢 R🟢 | Reuse action execution ordering |
| `core/interceptor` | DeepSeek request/response hook, SSE parsing, tool call detection | 9 / ~2,768 | Critical | S🔴 U🟡 P🟡 E🔴 R🔴 | Inject descriptors only; no CDP logic |
| `core/inline-agent` | Multi-step inline agent loop, prompts, trace renderer | 5 / ~1,213 | High | S🟡 U🟡 P🟡 E🟡 R🟡 | Must support browser tool continuation |
| `core/mcp` | MCP configuration, discovery, policy, transports | 11 / ~2,114 | High | S🟡 U🟢 P🟢 E🟡 R🟢 | Pattern reference for limits/policy; not the implementation path |
| `core/platform` | Platform capability and service abstractions | 4 / ~247 | Medium | S🟢 U🟢 P🟡 E🟡 R🟡 | Add debugger/tabs/tabGroups/browserControl capabilities |
| `core/messaging` / `core/types.ts` | Runtime message and bridge types | 2 / ~88 plus central types | Medium | S🟡 U🟡 P🟡 E🟡 R🟡 | Add browser-control RPC types |
| `entrypoints/background.ts` | MV3 background runtime, RPC, tool execution, sidepanel chat, automation | 1 / ~1,915 | Critical | S🔴 U🟡 P🟡 E🔴 R🔴 | Own CDP/debugger and controlled tab registry |
| `entrypoints/content.ts` | DeepSeek page bridge, tool UI, inline agent UI, DOM integrations | 1 / ~5,202 | Critical | S🔴 U🟡 P🟡 E🔴 R🔴 | UI/renderer only; no global browser-control state |
| `entrypoints/sidepanel` | React management UI | 33 / ~8,805 | Critical | S🟡 U🟡 P🟡 E🔴 R🟡 | Add Browser Control page/status controls |
| `wxt.config.ts` | Manifest construction and build plugins | 1 / ~165 | Medium | S🟡 U🟢 P🟡 E🟡 R🟡 | Add Chromium permissions and gate unsupported builds |
| `tests/` | Vitest tests and fixtures | 35+ suites / ~4,271 | Medium | S🟢 U🟢 P🟡 E🟡 R🟡 | Add browser-control contract/mock/smoke tests |

## Module Details

### `core/tool`

- **Path**: `core/tool/`
- **Responsibility**: Defines tool contracts, descriptor catalogs, tool invocation parsing metadata, runtime execution dispatch, and tool execution history.
- **Public API**: `ToolDescriptor`, `ToolProvider`, `createToolInvocationCatalog`, `getRuntimeToolDescriptors`, `executeRuntimeToolCall`, `appendToolCallHistory`.
- **Internal Dependencies**: memory, web search, artifact, skill creator, memory import, MCP discovery, i18n, web-tool settings.
- **External Dependencies**: `chrome.storage.local`, `fetch`, host permissions.
- **Complexity Rating**: High.
- **Transformation Notes**: Browser-control tools should be a local provider with descriptors and execution dispatch. The current runtime dispatch is name-branch based; a provider registry is the cleaner long-term shape, but the first structural step can keep dispatch localized in `core/browser-control`.
- **S.U.P.E.R Assessment**:
  - **S**: Partial. Tool concepts are cohesive, but runtime dispatch knows every provider.
  - **U**: Partial. Descriptors flow inward, execution calls outward to concrete providers.
  - **P**: Partial. `ToolDescriptor` is a good port; some payload validation remains provider-specific.
  - **E**: Partial. Some tools assume extension APIs.
  - **R**: Partial. Adding providers is possible but still requires runtime edits.

### `core/tool-loop`

- **Path**: `core/tool-loop/engine.ts`
- **Responsibility**: Executes tool calls sequentially and supports generic continuation loops.
- **Public API**: `executeToolCallsSequentially`, `runToolContinuationLoop`, `createToolExecutionRecord`.
- **Internal Dependencies**: shared tool types.
- **External Dependencies**: none.
- **Complexity Rating**: Low.
- **Transformation Notes**: Good reuse point. Browser action tools need observation/result size budgets upstream, not a second loop.
- **S.U.P.E.R Assessment**:
  - **S**: Compliant.
  - **U**: Compliant.
  - **P**: Partial; contracts are typed but not schema-validated.
  - **E**: Compliant.
  - **R**: Compliant.

### `core/interceptor`

- **Path**: `core/interceptor/`
- **Responsibility**: Hooks DeepSeek requests/responses, augments prompts, parses streaming responses, detects and hides tool calls.
- **Public API**: `installFetchHook`, `updateHookState`, `augmentRequestBody`, `extractToolCalls`, `createStreamingToolCallParser`.
- **Internal Dependencies**: prompt augmentation, tool descriptors, token speed, history cleanup.
- **External Dependencies**: DeepSeek web request shapes, SSE/XHR/IDB, browser fetch.
- **Complexity Rating**: Critical.
- **Transformation Notes**: Browser-control implementation must not live here. The interceptor should only receive browser-control descriptors and parse model tool calls.
- **S.U.P.E.R Assessment**:
  - **S**: Violation; hook state, stream parsing, history cleanup, and tool notification are tightly packed.
  - **U**: Partial; data generally flows from network to content/background.
  - **P**: Partial; parser contracts exist but DeepSeek response shapes leak through.
  - **E**: Violation; tightly coupled to DeepSeek web internals.
  - **R**: Violation; replacement cost is high.

### `core/inline-agent`

- **Path**: `core/inline-agent/`
- **Responsibility**: Runs multi-step agent continuations after manual chat, including nudge and finalization prompts.
- **Public API**: `runInlineAgentLoop`, prompt builders, renderer helpers, `InlineAgentStartPayload`.
- **Internal Dependencies**: DeepSeek adapter, tool-loop engine, interceptor parsers, i18n.
- **External Dependencies**: DeepSeek web API headers/PoW and content DOM renderer.
- **Complexity Rating**: High.
- **Transformation Notes**: Browser-control tools must be allowed in this loop, and their observations should be structured and budgeted so snapshots do not pollute visible text/history.
- **S.U.P.E.R Assessment**:
  - **S**: Partial; loop and stream parsing are cohesive but carry DeepSeek specifics.
  - **U**: Partial; execution is injected, but prompt building and model submission are coupled.
  - **P**: Partial; payload is typed but not schema-validated.
  - **E**: Partial; depends on DeepSeek web adapter.
  - **R**: Partial; swappable with effort.

### `core/mcp`

- **Path**: `core/mcp/`
- **Responsibility**: Stores MCP servers, discovers tools, applies policy, and executes MCP JSON-RPC over multiple transports.
- **Public API**: `getMcpToolDescriptors`, `refreshMcpServerDiscovery`, `executeMcpToolCall`, `createMcpTransport`.
- **Internal Dependencies**: tool types, shell preset, platform gating.
- **External Dependencies**: `chrome.storage`, `chrome.permissions`, `chrome.runtime.connectNative`, fetch transports.
- **Complexity Rating**: High.
- **Transformation Notes**: Useful design reference for cache TTLs, policy, limits, and errors. Browser control is built-in extension capability and must not be represented as external MCP.
- **S.U.P.E.R Assessment**:
  - **S**: Partial; several responsibilities but grouped around MCP.
  - **U**: Compliant.
  - **P**: Compliant; explicit MCP server/tool contracts.
  - **E**: Partial; native transport is platform-bound.
  - **R**: Compliant; transports are replaceable.

### `core/platform`

- **Path**: `core/platform/`
- **Responsibility**: Detects platform capabilities and exposes platform services.
- **Public API**: `PlatformEnvironment`, `PlatformServices`, `getCurrentPlatformEnvironment`, `createBrowserExtensionPlatformServices`.
- **Internal Dependencies**: MCP gating.
- **External Dependencies**: Chrome APIs and Android bridge detection.
- **Complexity Rating**: Medium.
- **Transformation Notes**: Add explicit capabilities for `tabs`, `tabGroups`, `debugger`, `scripting`, and `browserControl`; unsupported Firefox/Android states must be visible here.
- **S.U.P.E.R Assessment**:
  - **S**: Compliant.
  - **U**: Compliant.
  - **P**: Partial; capability map is typed but coarse.
  - **E**: Partial; Chrome APIs are directly probed.
  - **R**: Partial; good start, needs richer ports.

### `core/messaging` and `core/types.ts`

- **Path**: `core/messaging.ts`, `core/messaging/schema.ts`, `core/types.ts`
- **Responsibility**: Runtime messaging helpers and central message/action types.
- **Public API**: `sendToBackground`, `sendToContentScript`, `onMessage`, `validateBridgeMessage`, `MessageAction`.
- **Internal Dependencies**: shared project types.
- **External Dependencies**: `chrome.runtime`, `chrome.tabs`.
- **Complexity Rating**: Medium.
- **Transformation Notes**: Browser-control RPC payloads require typed contracts for target tab, action name, UID, snapshot handle, debugger state, and error details. Runtime validation should be stronger than the current shallow bridge schema.
- **S.U.P.E.R Assessment**:
  - **S**: Partial; central `MessageAction` is broad.
  - **U**: Partial.
  - **P**: Partial; compile-time types exist, runtime validation is sparse.
  - **E**: Partial.
  - **R**: Partial.

### `entrypoints/background.ts`

- **Path**: `entrypoints/background.ts`
- **Responsibility**: MV3 background runtime, message router, stores, MCP, local tool execution, sidepanel chat, automation, permissions, broadcasts.
- **Public API**: `defineBackground`, runtime `handleMessage`, `EXECUTE_TOOL_CALL`, `GET_TOOL_DESCRIPTORS`, `REQUEST_HOST_PERMISSION`, broadcast helpers.
- **Internal Dependencies**: nearly all core services.
- **External Dependencies**: `chrome.runtime`, `chrome.tabs`, `chrome.permissions`, `chrome.sidePanel`, `chrome.contextMenus`, `chrome.alarms`, `chrome.offscreen`.
- **Complexity Rating**: Critical.
- **Transformation Notes**: It should own the browser-control service instance, but not the implementation details. Add narrow message cases and delegate to `core/browser-control`.
- **S.U.P.E.R Assessment**:
  - **S**: Violation; too many responsibilities.
  - **U**: Partial.
  - **P**: Partial.
  - **E**: Violation; Chrome API assumptions are broad.
  - **R**: Violation; replacement is expensive.

### `entrypoints/content.ts`

- **Path**: `entrypoints/content.ts`
- **Responsibility**: DeepSeek page content script, main-world bridge, tool card rendering, inline agent trace, DOM integrations, exports, theme, pet UI.
- **Public API**: WXT content script entry, bridge handlers, `runToolExecution`, inline agent render handlers.
- **Internal Dependencies**: inline agent, artifact, tool renderer, interceptor types, i18n.
- **External Dependencies**: DeepSeek DOM, `MutationObserver`, `chrome.runtime`, `chrome.storage`.
- **Complexity Rating**: Critical.
- **Transformation Notes**: Browser-control UI feedback may appear here through tool cards, but no CDP session state should be held in content.
- **S.U.P.E.R Assessment**:
  - **S**: Violation.
  - **U**: Partial.
  - **P**: Partial.
  - **E**: Violation.
  - **R**: Violation.

### `entrypoints/sidepanel`

- **Path**: `entrypoints/sidepanel/`
- **Responsibility**: React management UI for chat, capabilities, tools, MCP, automation, settings, projects, memory, saved items.
- **Public API**: `App`, `CapabilitiesPage`, `ToolsPage`, `McpPage`, `ChatPage`, i18n provider.
- **Internal Dependencies**: core types, i18n, platform, shell, chat, voice, settings stores.
- **External Dependencies**: React, `chrome.runtime`, `chrome.permissions`, `chrome.tabs`.
- **Complexity Rating**: Critical.
- **Transformation Notes**: Add a dedicated Browser Control page under Capabilities. Do not hide this inside existing Tools/MCP pages.
- **S.U.P.E.R Assessment**:
  - **S**: Partial.
  - **U**: Partial.
  - **P**: Partial.
  - **E**: Violation; browser APIs are common in UI.
  - **R**: Partial.

### `wxt.config.ts`

- **Path**: `wxt.config.ts`
- **Responsibility**: WXT manifest and Vite build configuration.
- **Public API**: `defineConfig`, `createManifest`.
- **Internal Dependencies**: package version and safe WXT browser alias.
- **External Dependencies**: WXT, Vite, Tailwind, Node fs/path/url.
- **Complexity Rating**: Medium.
- **Transformation Notes**: This is the manifest truth source. Browser-control parity requires a deliberate Chromium-only permission set and policy checks.
- **S.U.P.E.R Assessment**:
  - **S**: Partial.
  - **U**: Compliant.
  - **P**: Partial.
  - **E**: Partial.
  - **R**: Partial.

### `tests/`

- **Path**: `tests/`
- **Responsibility**: Vitest unit/component/contract tests and fixtures.
- **Public API**: `npm test`, per-suite tests.
- **Internal Dependencies**: core modules, sidepanel React components, content adapters.
- **External Dependencies**: Vitest, jsdom, React test rendering, stubbed Chrome APIs.
- **Complexity Rating**: Medium.
- **Transformation Notes**: Add focused tests before browser-control implementation hardens.
- **S.U.P.E.R Assessment**:
  - **S**: Compliant.
  - **U**: Compliant.
  - **P**: Partial.
  - **E**: Partial.
  - **R**: Partial.

## Current Gaps

| Gap | Evidence | Required Design Work |
|:--|:--|:--|
| CDP/debugger | no `chrome.debugger` or CDP service; manifest lacks `debugger` | background-owned debugger session service |
| Accessibility Tree UID snapshot | no AX snapshot schema/cache/formatter | UID mapping, snapshot budget, stale UID errors |
| Controlled tabs/groups | only ad hoc tab queries/creates | controlled tab registry, group title/color/lifecycle |
| Browser action tools | no descriptors or runtime branch | browser-control local provider |
| Tool-loop coverage | multiple loops exist | one provider across manual, sidepanel, inline agent, automation |
| UI/permissions | no debugger/tabs UI | Browser Control sidepanel page and policy docs |
| Validation | no CDP tests | mock Chrome API tests plus real smoke fixture |
