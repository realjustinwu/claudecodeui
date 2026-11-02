import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * Two sessions streaming at once: the one the user watches, and one running in
 * the background. Deltas of BOTH must fold into their own session's streaming
 * bubble (`updateStreaming`, keyed `__streaming_<sid>`).
 *
 * Regression: the background session's `stream_delta` frames used to be
 * appended one row per delta (`appendRealtime`), which rendered one token per
 * line the moment its transcript came into view; the accumulation buffer was
 * also shared, so concurrent streams stitched their texts together.
 */

const VIEWED = 'viewed-session';
const BACKGROUND = 'background-session';

type StreamingCall = { sessionId: string; text: string; provider: string };
type RealtimeAppend = { sessionId: string; kind: string };

const renderHandlers = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const streamingCalls: StreamingCall[] = [];
  const finalized: string[] = [];
  const realtimeAppends: RealtimeAppend[] = [];

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: VIEWED } as ProjectSession,
    currentSessionId: VIEWED,
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: new Map() },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    sessionStore: {
      appendRealtime: (sessionId: string, msg: NormalizedMessage) => {
        realtimeAppends.push({ sessionId, kind: String(msg.kind) });
      },
      getMessages: () => [],
      updateStreaming: (sessionId: string, text: string, provider: string) => {
        streamingCalls.push({ sessionId, text, provider });
      },
      finalizeStreaming: (sessionId: string) => { finalized.push(sessionId); },
    } as unknown as SessionStore,
  }));

  const dispatch = (event: ServerEvent) => listener?.(event);
  return { dispatch, streamingCalls, finalized, realtimeAppends };
};

const delta = (sessionId: string, text: string): ServerEvent => ({
  id: `delta-${sessionId}-${Math.random()}`,
  sessionId,
  provider: 'pi',
  kind: 'stream_delta',
  content: text,
  timestamp: '2026-11-02T01:00:00.000Z',
} as unknown as ServerEvent);

test('background session deltas fold into its own streaming bubble, never one row per delta', () => {
  const { dispatch, streamingCalls, realtimeAppends } = renderHandlers();

  // Interleave the two sessions' deltas the way two concurrent runs arrive.
  dispatch(delta(VIEWED, 'zero '));
  dispatch(delta(BACKGROUND, '零'));
  dispatch(delta(VIEWED, 'exposure'));
  dispatch(delta(BACKGROUND, '曝光'));

  // The viewed session paints through the throttle timer (not fired here), so
  // only the background session folds immediately — into ITS bubble, once per
  // delta, with the accumulated text of that session alone.
  const backgroundCalls = streamingCalls.filter((call) => call.sessionId === BACKGROUND);
  assert.equal(backgroundCalls.length, 2, 'each background delta folds into its bubble');
  assert.equal(backgroundCalls[0].text, '零');
  assert.equal(backgroundCalls[1].text, '零曝光', 'background text accumulates per session');
  assert.equal(backgroundCalls[1].provider, 'pi', 'the bubble carries the streaming session provider');

  // No stream_delta may ever become its own transcript row.
  assert.equal(
    realtimeAppends.filter((append) => append.kind === 'stream_delta').length,
    0,
    'stream deltas are never appended as transcript rows',
  );
});

test('concurrent streams never mix: stream_end finalizes only the ending session', async () => {
  const { dispatch, streamingCalls, finalized } = renderHandlers();

  dispatch(delta(VIEWED, 'hello '));
  dispatch(delta(BACKGROUND, '你好'));
  dispatch(delta(VIEWED, 'world'));

  // The background run finishes while the viewed one still streams.
  dispatch({
    id: 'end-background',
    sessionId: BACKGROUND,
    provider: 'pi',
    kind: 'stream_end',
    timestamp: '2026-11-02T01:00:01.000Z',
  } as unknown as ServerEvent);

  assert.ok(finalized.includes(BACKGROUND), 'the ending session is finalized');
  assert.ok(!finalized.includes(VIEWED), 'the still-streaming session is untouched');

  // The viewed session's flush on stream_end carries only its own words.
  dispatch({
    id: 'end-viewed',
    sessionId: VIEWED,
    provider: 'pi',
    kind: 'stream_end',
    timestamp: '2026-11-02T01:00:02.000Z',
  } as unknown as ServerEvent);

  const viewedFlush = streamingCalls
    .filter((call) => call.sessionId === VIEWED)
    .map((call) => call.text)
    .join('');
  assert.ok(viewedFlush.includes('hello world'));
  assert.ok(!viewedFlush.includes('你好'), 'no cross-session text leaks into the flush');
  assert.ok(finalized.includes(VIEWED));
});
