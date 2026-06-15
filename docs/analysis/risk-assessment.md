# Risk Assessment

## S.U.P.E.R Architecture Health Summary

| Principle | Status | Key Findings | Transformation Priority |
|:--|:--|:--|:--|
| **S** Single Purpose | 🔴 | `entrypoints/content.ts`, `entrypoints/background.ts`, and `core/interceptor/fetch-hook.ts` are large coordination hubs. Browser control would make them worse if implemented inline. | Critical |
| **U** Unidirectional Flow | 🔴 | Manual chat, inline agent, sidepanel chat, and automation each have tool paths. Browser-control must converge through the existing runtime provider contract. | Critical |
| **P** Ports over Implementation | 🟡 | `ToolDescriptor` is usable, but CDP session, controlled tab, AX UID snapshot, browser action result, and permission state schemas do not exist yet. | High |
| **E** Environment-Agnostic | 🔴 | `chrome.debugger` and CDP are Chromium-specific. Firefox and Android must be explicit unsupported states, not hidden fallbacks. | Critical |
| **R** Replaceable Parts | 🟡 | `core/platform` is a useful capability layer, but it lacks `browserControl`, `debugger`, `tabs`, `tabGroups`, and `accessibilityTree` capabilities. | High |

**Overall Health**: 0/5 principles healthy for this transformation. This is a technical-debt alert unless the implementation first establishes clean contracts and a dedicated browser-control service.

## S.U.P.E.R Violation Hotspots

| Hotspot | Evidence | Required Mitigation |
|:--|:--|:--|
| `entrypoints/content.ts` | Handles page bridge, tool card UI, export, inline agent, theme, pet, local artifact fast path | Do not add CDP/session state here. Limit content changes to rendering and existing tool-call forwarding. |
| `entrypoints/background.ts` | Handles runtime RPC, automation, sidepanel chat, MCP, offscreen sandbox, sync, broadcasts | Own the service instance, but delegate implementation to `core/browser-control/*`. |
| `core/interceptor/fetch-hook.ts` | Streaming parser previously had large-payload freeze risk | Only expose descriptors and parse calls. No full snapshot injection into streamed visible text. |
| `core/inline-agent/loop.ts` + content gating | Existing inline agent continuation policy does not automatically include browser tools | Add explicit browser-control provider eligibility and tests across all trigger sources. |
| `scripts/manifest-policy-check.mjs` | Permission list is hard-coded | Update manifest policy checks, CWS docs checks, and platform compatibility expectations together. |

## Risk Matrix

| Risk | Impact | Likelihood | Severity | Mitigation |
|:--|:--|:--|:--|:--|
| `debugger` permission trust and Web Store review risk | High | High | Critical | Make Browser Control explicit, user-visible, auditable, and documented; consider channel gating if CWS posture requires it. |
| Firefox / Android incompatibility | High | Certain | Critical | Capability-gate descriptors and UI; return explicit unsupported errors. |
| Snapshot payload freezes or history pollution | High | High | Critical | Hard node/byte/time budgets; store or return pruned snapshot observations; never persist massive AX trees in history. |
| Multiple tool-loop behavior divergence | High | High | Critical | One local provider used by manual chat, sidepanel chat, inline agent, and automation. |
| Controlled tab target confusion | Medium | High | High | Background-owned controlled tab registry with owner/run id and tab group metadata. |
| CDP detach and restricted URL errors | Medium | High | High | Structured errors; no silent success; user-visible detach state. |
| Action tools mutate unintended pages | High | Medium | High | Scope every action to locked tab/group; require fresh snapshot UID; stale UID errors. |
| Weak validation surface | Medium | High | High | Add unit tests, manifest policy tests, and a real Chrome smoke fixture. |

## High-Severity Risks

### Sensitive Browser Permissions

Official Chrome documentation confirms `chrome.debugger` requires the `debugger` manifest permission, and `chrome.tabGroups` requires `tabGroups` in MV3. This is not a normal optional cosmetic permission; it is central to user trust and review posture.

Mitigation:

- Add only to Chromium targets.
- Document every new permission in privacy policy and submission notes.
- Provide a sidepanel Browser Control page with state, explicit detach, and action history.
- Keep unsupported Firefox/Android states explicit.

### Snapshot Size, Privacy, And Freeze Regression

Browser control depends on page observation. Accessibility Tree and DOM-related snapshots can be large and may contain sensitive page text. The project already has memory of severe artifact-heavy freeze risk caused by large tool payload streaming and cross-boundary copying.

Mitigation:

- Define `BrowserSnapshot` with `snapshotId`, `nodes`, `truncated`, `budget`, and `summary`.
- Hard-limit default node count and serialized bytes.
- Keep full debug snapshots out of `ToolResult.output` unless explicitly requested and budgeted.
- Add large snapshot tests before shipping.

### Tool-Loop Fragmentation

Browser-control tools must be reachable consistently from:

- manual DeepSeek page chat
- inline agent continuation
- sidepanel chat
- automation runner

Mitigation:

- Add browser-control as a local provider under `core/tool/runtime.ts`.
- Use `ToolDescriptor.annotations.capability = "browser_control"` for policy.
- Add trigger-source behavior tests.

### Platform Compatibility

Firefox and Android WebView cannot be treated as degraded browser-control platforms. Android bridge currently does not expose extension APIs; Firefox does not provide Chrome CDP debugger parity in this project.

Mitigation:

- Add platform capabilities: `tabs`, `tabGroups`, `debugger`, `browserControl`, `accessibilityTree`.
- Do not include browser-control descriptors on unsupported platforms.
- Surface unavailable state in sidepanel.

## Technical Debt

- Background and content entrypoints are already large. Browser control must not add another large inline block.
- `MessageAction` is a broad central union with little runtime validation.
- Tool execution history truncates outputs, which is incompatible with raw AX snapshot storage.
- Existing active spec files were stale relative to archived completion; this run replaces active spec surfaces with browser-control parity artifacts.

## Testing Risks

Existing quality gates are strong for packaging and current feature behavior:

- `npm test`
- `npm run compile`
- `npm run prompt:freeze`
- `npm run verify:i18n`
- `npm run verify:manifest-policy`
- `npm run ci:quality`

Required additions:

- CDP connection tests with stubbed `chrome.debugger`
- tab lifecycle and tab group tests
- AX snapshot formatter and stale UID tests
- input action tests for click, hover, fill, key, file attach
- unsupported platform tests
- manifest policy tests for new permissions/docs
- real Chrome smoke test on a fixture page

## Project Governance Risks

| Risk | Status | Mitigation |
|:--|:--|:--|
| Active old spec docs were stale | `docs/archives/better-deepseek-capability-adoption/` has archive copy | Replace active `docs/analysis`, `docs/plan`, `docs/progress` with this run |
| `AGENTS.md` is generated | Root file warns to edit Claude project memory instead | Do not hand-edit for this run unless a rule must become shared |
| Durable memory surface | Codex native memory exists | Use native memory for durable lessons; do not create repo fallback |
| GitHub mode | `gh` authenticated with repo scope; project scope missing | Use `GITHUB_STANDARD` |

## Compatibility Concerns

- Chromium: target platform for full browser control.
- Edge: likely shares Chromium extension APIs, but still validate build and API availability.
- Firefox: build must omit or hard-disable browser control.
- Android WebView: build must show unsupported; no fake tool success.
- Chrome Web Store: permission documentation and privacy policy must be updated before release.

## Verified External Baseline

Current official docs checked on 2026-06-14:

- Chrome `debugger` API requires declaring `debugger` in the manifest.
- Chrome optional permissions are recommended for optional features when possible.
- Chrome `tabGroups` is Chrome 89+ / MV3+ and requires `tabGroups`.
- Chrome Web Store program policies emphasize trustworthy, safe extensions and review of permissions.
