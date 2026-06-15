export interface RuntimeBroadcastTab {
  id?: number | null;
}

export interface RuntimeBroadcastDependencies {
  tabUrlPattern: string;
  sendRuntimeMessage(payload: Record<string, unknown>): Promise<unknown>;
  queryTabsByUrl(urlPattern: string): Promise<readonly RuntimeBroadcastTab[]>;
  sendTabMessage(tabId: number, payload: Record<string, unknown>): Promise<unknown>;
  reportError(code: string, error: unknown): void;
}

export async function broadcastRuntimeUpdate(
  payload: Record<string, unknown>,
  excludeTabId: number | undefined,
  dependencies: RuntimeBroadcastDependencies,
): Promise<void> {
  dependencies.sendRuntimeMessage(payload).catch(() => {});

  let tabs: readonly RuntimeBroadcastTab[] = [];
  try {
    tabs = await dependencies.queryTabsByUrl(dependencies.tabUrlPattern);
  } catch (error) {
    dependencies.reportError('broadcast_tabs_query_failed', error);
    if (excludeTabId) {
      dependencies.sendTabMessage(excludeTabId, payload).catch(() => {});
    }
    return;
  }

  for (const tab of tabs) {
    if (tab.id && tab.id !== excludeTabId) {
      dependencies.sendTabMessage(tab.id, payload).catch(() => {});
    }
  }
  if (excludeTabId) {
    dependencies.sendTabMessage(excludeTabId, payload).catch(() => {});
  }
}
