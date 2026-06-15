export type PlatformKind = 'browser_extension' | 'android_webview' | 'unknown';

export type PlatformCapability =
  | 'storage'
  | 'runtimeMessaging'
  | 'downloads'
  | 'filePicker'
  | 'folderPicker'
  | 'assetUrl'
  | 'sidePanel'
  | 'nativeMessaging'
  | 'contextMenus'
  | 'alarms'
  | 'tabs'
  | 'tabGroups'
  | 'debugger'
  | 'browserControl'
  | 'accessibilityTree';

export type PlatformCapabilityMap = Record<PlatformCapability, boolean>;

export interface PlatformEnvironment {
  kind: PlatformKind;
  name: string;
  capabilities: PlatformCapabilityMap;
}

export interface PlatformStorage {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface PlatformRuntime {
  sendMessage<T = unknown>(message: unknown): Promise<T>;
}

export interface PlatformDownload {
  download(input: {
    filename: string;
    mimeType: string;
    content: string;
  }): Promise<void>;
}

export interface PlatformFilePicker {
  pickFiles(options?: { multiple?: boolean; accept?: string[] }): Promise<PlatformPickedFile[]>;
  pickFolder?(): Promise<PlatformPickedFile[]>;
}

export interface PlatformPickedFile {
  name: string;
  path: string;
  content: string;
  sizeBytes: number;
}

export interface PlatformServices {
  environment: PlatformEnvironment;
  storage: PlatformStorage;
  runtime: PlatformRuntime;
  download?: PlatformDownload;
  filePicker?: PlatformFilePicker;
  getAssetUrl(path: string): string;
}

export const EMPTY_PLATFORM_CAPABILITIES: PlatformCapabilityMap = {
  storage: false,
  runtimeMessaging: false,
  downloads: false,
  filePicker: false,
  folderPicker: false,
  assetUrl: false,
  sidePanel: false,
  nativeMessaging: false,
  contextMenus: false,
  alarms: false,
  tabs: false,
  tabGroups: false,
  debugger: false,
  browserControl: false,
  accessibilityTree: false,
};

export function createCapabilityMap(
  capabilities: Partial<PlatformCapabilityMap>,
): PlatformCapabilityMap {
  return { ...EMPTY_PLATFORM_CAPABILITIES, ...capabilities };
}

export function isCapabilitySupported(
  environment: PlatformEnvironment,
  capability: PlatformCapability,
): boolean {
  return environment.capabilities[capability] === true;
}

export function getCurrentBrowserExtensionEnvironment(): PlatformEnvironment {
  const runtime = safeChromeRuntime();
  const chromeApi = safeChrome();
  const debuggerSupported = Boolean(chromeApi?.debugger?.attach && chromeApi.debugger.sendCommand);
  const tabsSupported = Boolean(chromeApi?.tabs?.query && chromeApi.tabs.get);
  return {
    kind: 'browser_extension',
    name: 'WebExtension',
    capabilities: createCapabilityMap({
      storage: Boolean(chromeApi?.storage?.local),
      runtimeMessaging: Boolean(runtime?.sendMessage),
      downloads: Boolean(chromeApi?.downloads?.download),
      filePicker: typeof document !== 'undefined',
      folderPicker: typeof document !== 'undefined',
      assetUrl: Boolean(runtime?.getURL),
      sidePanel: Boolean(chromeApi?.sidePanel),
      nativeMessaging: Boolean(runtime?.connectNative || runtime?.sendNativeMessage),
      contextMenus: Boolean(chromeApi?.contextMenus),
      alarms: Boolean(chromeApi?.alarms),
      tabs: tabsSupported,
      tabGroups: Boolean(chromeApi?.tabGroups),
      debugger: debuggerSupported,
      browserControl: debuggerSupported && tabsSupported,
      accessibilityTree: debuggerSupported,
    }),
  };
}

export function getCurrentPlatformEnvironment(): PlatformEnvironment {
  const androidBridge = typeof window !== 'undefined'
    ? (window as typeof window & { AndroidBridge?: unknown }).AndroidBridge
    : undefined;
  if (androidBridge) {
    return {
      kind: 'android_webview',
      name: 'Android WebView',
      capabilities: createCapabilityMap({
        storage: true,
        runtimeMessaging: true,
        downloads: true,
        filePicker: true,
        folderPicker: true,
        assetUrl: true,
        sidePanel: false,
        nativeMessaging: false,
        contextMenus: false,
        alarms: false,
        tabs: false,
        tabGroups: false,
        debugger: false,
        browserControl: false,
        accessibilityTree: false,
      }),
    };
  }
  if (safeChromeRuntime()) return getCurrentBrowserExtensionEnvironment();
  return {
    kind: 'unknown',
    name: 'Unknown',
    capabilities: createCapabilityMap({}),
  };
}

function safeChrome(): typeof chrome | null {
  try {
    return typeof chrome !== 'undefined' ? chrome : null;
  } catch {
    return null;
  }
}

function safeChromeRuntime(): typeof chrome.runtime | null {
  try {
    return typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime : null;
  } catch {
    return null;
  }
}
