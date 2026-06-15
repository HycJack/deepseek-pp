import type { BrowserDialogState } from './types';

type DebuggerApi = typeof chrome.debugger;
type DebuggerSession = chrome.debugger.DebuggerSession;

export class BrowserControlError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'BrowserControlError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class BrowserConnection {
  private readonly chromeApi: typeof chrome;
  private readonly dialogs = new Map<number, BrowserDialogState>();
  private attachedTabId: number | null = null;
  private detachListenerRegistered = false;
  private eventListenerRegistered = false;

  constructor(chromeApi: typeof chrome) {
    this.chromeApi = chromeApi;
  }

  get tabId(): number | null {
    return this.attachedTabId;
  }

  get attached(): boolean {
    return this.attachedTabId !== null;
  }

  getLatestDialog(tabId: number): BrowserDialogState | null {
    return this.dialogs.get(tabId) ?? null;
  }

  clearDialog(tabId: number): void {
    this.dialogs.delete(tabId);
  }

  async attach(tabId: number): Promise<void> {
    if (this.attachedTabId === tabId) return;
    if (this.attachedTabId !== null) await this.detach();

    const debuggerApi = this.getDebuggerApi();
    await debuggerApi.attach({ tabId }, '1.3');
    this.attachedTabId = tabId;
    this.registerListeners();

    await this.sendCommand('Runtime.enable');
    await this.sendCommand('Page.enable');
    await this.sendCommand('DOM.enable');
    await this.sendCommand('Accessibility.enable');
    await this.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  }

  async detach(): Promise<void> {
    if (this.attachedTabId === null) return;
    const tabId = this.attachedTabId;
    this.attachedTabId = null;
    try {
      await this.getDebuggerApi().detach({ tabId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('not attached') && !message.includes('No tab with id')) {
        throw error;
      }
    }
  }

  async sendCommand<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (this.attachedTabId === null) {
      throw new BrowserControlError('browser_control_not_attached', 'No browser tab is attached.', {
        retryable: true,
      });
    }
    const result = await this.getDebuggerApi().sendCommand(
      this.getSession(),
      method,
      params,
    );
    return (result ?? {}) as T;
  }

  private getSession(): DebuggerSession {
    if (this.attachedTabId === null) {
      throw new BrowserControlError('browser_control_not_attached', 'No browser tab is attached.', {
        retryable: true,
      });
    }
    return { tabId: this.attachedTabId };
  }

  private getDebuggerApi(): DebuggerApi {
    const debuggerApi = this.chromeApi.debugger;
    if (!debuggerApi?.attach || !debuggerApi.sendCommand || !debuggerApi.detach) {
      throw new BrowserControlError(
        'debugger_api_unavailable',
        'chrome.debugger is unavailable in this extension context.',
      );
    }
    return debuggerApi;
  }

  private registerListeners(): void {
    const debuggerApi = this.getDebuggerApi();
    if (!this.detachListenerRegistered) {
      debuggerApi.onDetach.addListener((source) => {
        if (source.tabId !== this.attachedTabId) return;
        this.attachedTabId = null;
      });
      this.detachListenerRegistered = true;
    }

    if (!this.eventListenerRegistered) {
      debuggerApi.onEvent.addListener((source, method, params) => {
        if (!source.tabId) return;
        if (method !== 'Page.javascriptDialogOpening') return;
        const payload = params as {
          type?: unknown;
          message?: unknown;
          defaultPrompt?: unknown;
        } | undefined;
        this.dialogs.set(source.tabId, {
          type: typeof payload?.type === 'string' ? payload.type : 'dialog',
          message: typeof payload?.message === 'string' ? payload.message : '',
          defaultPrompt: typeof payload?.defaultPrompt === 'string'
            ? payload.defaultPrompt
            : undefined,
          seenAt: Date.now(),
        });
      });
      this.eventListenerRegistered = true;
    }
  }
}

export function toBrowserControlError(error: unknown): BrowserControlError {
  if (error instanceof BrowserControlError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const retryable =
    message.includes('Cannot access') ||
    message.includes('No tab with id') ||
    message.includes('not attached') ||
    message.includes('detached') ||
    message.includes('target closed');
  return new BrowserControlError('browser_control_failed', message, { retryable });
}
