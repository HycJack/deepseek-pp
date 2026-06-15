export {
  browserControlService,
  createBrowserControlToolDescriptors,
  executeBrowserControlToolCall,
  getBrowserControlState,
  isBrowserControlToolName,
} from './tool';

export {
  DEFAULT_BROWSER_CONTROL_SETTINGS,
  getBrowserControlSettings,
  normalizeBrowserControlSettings,
  saveBrowserControlSettings,
  setBrowserControlEnabled,
} from './settings';

export type {
  BrowserActionResult,
  BrowserControlSettings,
  BrowserControlState,
  BrowserControlTarget,
  BrowserControlToolName,
  BrowserSnapshotNode,
  BrowserSnapshotResult,
} from './types';
