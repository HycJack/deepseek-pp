import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateTokenUnits, estimateTokens } from '../core/token/estimator';
import {
  createResponseTokenSpeedTracker,
  type ResponseTokenSpeedPayload,
} from '../core/interceptor/token-speed';
import {
  extractResponseUsageStatsFromParsed,
  parseSSEChunk,
  parseSSEData,
} from '../core/interceptor/sse-parser';

describe('estimateTokenUnits', () => {
  it('estimates ASCII text at ~0.3 token per character', () => {
    expect(estimateTokenUnits('abcd')).toBeCloseTo(1.2, 5);
  });

  it('estimates CJK text at ~0.6 token per character', () => {
    expect(estimateTokenUnits('你好世界')).toBeCloseTo(2.4, 5);
  });

  it('rounds up in estimateTokens', () => {
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('你好世界')).toBe(3);
  });
});

describe('createResponseTokenSpeedTracker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupTracker() {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const payloads: ResponseTokenSpeedPayload[] = [];
    const tracker = createResponseTokenSpeedTracker((p) => payloads.push(p), 250);
    return {
      tracker,
      payloads,
      advanceTo(ms: number) {
        now = ms;
      },
    };
  }

  it('reports zero speed before any chunk arrives', () => {
    const { tracker, payloads, advanceTo } = setupTracker();
    advanceTo(5000);
    tracker.finish();
    const final = payloads[payloads.length - 1];
    expect(final.tokensPerSecond).toBe(0);
    expect(final.estimatedTokens).toBe(0);
  });

  it('measures decode speed from the first streamed chunk, not tracker creation', () => {
    const { tracker, payloads, advanceTo } = setupTracker();
    // 3s of queueing/prefill before the stream produces the first chunk.
    advanceTo(3000);
    tracker.append('你好'); // 1.2 units, excluded from the rate (no elapsed time yet)
    advanceTo(4000);
    tracker.append('世界'); // 1.2 units decoded over 1s
    tracker.finish();
    const final = payloads[payloads.length - 1];
    expect(final.active).toBe(false);
    expect(final.estimatedTokens).toBe(2); // round(2.4)
    expect(final.textLength).toBe(4);
    // 1.2 token units over the 1s between first and second chunk.
    expect(final.tokensPerSecond).toBeCloseTo(1.2, 5);
  });

  it('does not spike on the first chunk', () => {
    const { tracker, payloads, advanceTo } = setupTracker();
    advanceTo(1000);
    tracker.append('hello world, this is a long first chunk');
    const afterFirst = payloads[payloads.length - 1];
    expect(afterFirst.tokensPerSecond).toBe(0);
    tracker.finish();
  });

  it('uses server token usage and server timestamps when available', () => {
    const { tracker, payloads, advanceTo } = setupTracker();
    advanceTo(100);
    tracker.updateServerStats({ modelType: 'vision', insertedAt: 1000 });
    tracker.append('hello world');
    tracker.updateServerStats({ accumulatedTokenUsage: 3302 });
    tracker.finish();
    tracker.updateServerStats({ updatedAt: 1003.11 });

    const final = payloads[payloads.length - 1];
    expect(final.active).toBe(false);
    expect(final.modelType).toBe('vision');
    expect(final.accumulatedTokens).toBe(3302);
    expect(final.tokenSource).toBe('server');
    expect(final.speedSource).toBe('server');
    expect(final.elapsedMs).toBe(3110);
    expect(final.tokensPerSecond).toBeCloseTo(3302 / 3.11, 5);
  });

  it('keeps estimated TPS until the server time window is complete', () => {
    const { tracker, payloads, advanceTo } = setupTracker();
    tracker.updateServerStats({ insertedAt: 1000 });
    tracker.updateServerStats({ updatedAt: 1000.01 });
    advanceTo(1000);
    tracker.append('你好');
    advanceTo(2000);
    tracker.append('世界');
    tracker.updateServerStats({ accumulatedTokenUsage: 99 });
    tracker.finish();

    const final = payloads[payloads.length - 1];
    expect(final.accumulatedTokens).toBe(99);
    expect(final.tokenSource).toBe('server');
    expect(final.speedSource).toBe('estimated');
    expect(final.tokensPerSecond).toBeCloseTo(1.2, 5);
  });

  it('handles server token usage and completion time from the same stats patch', () => {
    const { tracker, payloads } = setupTracker();
    tracker.updateServerStats({ insertedAt: 2000 });
    tracker.finish();
    tracker.updateServerStats({ accumulatedTokenUsage: 120, updatedAt: 2002 });

    const final = payloads[payloads.length - 1];
    expect(final.accumulatedTokens).toBe(120);
    expect(final.speedSource).toBe('server');
    expect(final.tokensPerSecond).toBe(60);
  });
});

describe('extractResponseUsageStatsFromParsed', () => {
  function parseOne(block: string) {
    const event = parseSSEChunk(block)[0];
    if (!event) throw new Error('missing SSE event');
    return {
      event,
      parsed: parseSSEData(event.data),
    };
  }

  it('extracts ready model type and update_session timestamps', () => {
    const ready = parseOne('event: ready\ndata: {"request_message_id":1,"response_message_id":2,"model_type":"vision"}\n\n');
    const update = parseOne('event: update_session\ndata: {"updated_at":1781763676.655633}\n\n');

    expect(extractResponseUsageStatsFromParsed(ready.parsed, ready.event.type)).toEqual({
      modelType: 'vision',
    });
    expect(extractResponseUsageStatsFromParsed(update.parsed, update.event.type)).toEqual({
      updatedAt: 1781763676.655633,
    });
  });

  it('extracts inserted_at and accumulated_token_usage from response payloads and batches', () => {
    const start = parseOne('data: {"v":{"response":{"inserted_at":1781763673.5456538,"accumulated_token_usage":0}}}\n\n');
    const batch = parseOne('data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":3302},{"p":"quasi_status","v":"FINISHED"}]}\n\n');

    expect(extractResponseUsageStatsFromParsed(start.parsed, start.event.type)).toEqual({
      insertedAt: 1781763673.5456538,
      accumulatedTokenUsage: 0,
    });
    expect(extractResponseUsageStatsFromParsed(batch.parsed, batch.event.type)).toEqual({
      accumulatedTokenUsage: 3302,
    });
  });
});
