import { describe, expect, it, vi } from 'vitest';
import { broadcastRuntimeUpdate } from '../core/messaging/broadcast';

describe('runtime update broadcasting', () => {
  it('does not reject the caller when tab discovery fails', async () => {
    const payload = { type: 'SAVED_ITEMS_UPDATED' };
    const sendRuntimeMessage = vi.fn(async () => undefined);
    const sendTabMessage = vi.fn(async () => undefined);
    const reportError = vi.fn();

    await expect(broadcastRuntimeUpdate(payload, undefined, {
      tabUrlPattern: '*://chat.deepseek.com/*',
      sendRuntimeMessage,
      queryTabsByUrl: vi.fn(async () => {
        throw new Error('tabs permission unavailable');
      }),
      sendTabMessage,
      reportError,
    })).resolves.toBeUndefined();

    expect(sendRuntimeMessage).toHaveBeenCalledWith(payload);
    expect(reportError).toHaveBeenCalledWith('broadcast_tabs_query_failed', expect.any(Error));
    expect(sendTabMessage).not.toHaveBeenCalled();
  });

  it('still notifies the sender tab directly when query fails and a sender tab exists', async () => {
    const payload = { type: 'PROJECT_CONTEXT_UPDATED' };
    const sendTabMessage = vi.fn(async () => undefined);

    await broadcastRuntimeUpdate(payload, 12, {
      tabUrlPattern: '*://chat.deepseek.com/*',
      sendRuntimeMessage: vi.fn(async () => undefined),
      queryTabsByUrl: vi.fn(async () => {
        throw new Error('query failed');
      }),
      sendTabMessage,
      reportError: vi.fn(),
    });

    expect(sendTabMessage).toHaveBeenCalledWith(12, payload);
  });
});
