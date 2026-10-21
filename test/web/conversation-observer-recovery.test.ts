import { expect, it } from 'vitest';
import { startConversationStack } from './fixtures/conversation-stack.js';
import { ConversationStreamDecoder } from '../../src/web/conversation-stream-codec.js';

// Break caught: default split-config observer failure is incorrectly advertised as permanent incapability.
for (const nativeWatch of [false, true]) it(`real default-path observer exposes retryable failure and repaired fresh ready (native watch: ${nativeWatch})`, async () => {
  const stack = await startConversationStack({}, 'acp', 'allow', {realRoleObserver: true, nativeWatch});
  const abort = new AbortController();
  try {
    const page = stack.session.conversationPage({limit:1});
    const url = `${stack.origin}/api/v1/roles/Alpha/conversation/events?expectedGeneration=${page.snapshot.sessionGeneration}&after=${page.nextCursor || 0}`;
    async function open() {
      const attempt = new AbortController();
      const response = await fetch(url, {headers:stack.jsonHeaders, signal:AbortSignal.any([abort.signal, attempt.signal, AbortSignal.timeout(25_000)])});
      const reader = response.body!.getReader();
      const records: any[] = [];
      const decoder = new ConversationStreamDecoder(record => records.push(record));
      return {reader,records,close: () => attempt.abort(),async through(type:string) {
        while (!records.some(record => record.type === type)) {
          const value = await reader.read();
          expect(value.done).toBe(false); decoder.push(value.value!);
          if (type === 'ready' && records.some(record => record.type === 'resync')) throw Error(JSON.stringify(records));
        }
        return records.find(record => record.type === type);
      }};
    }
    const first = await open(); await first.through('ready');
    stack.setMalformedRole(true);
    const failed = await first.through('resync');
    await first.through('keepalive');
    expect(first.records.filter(record => record.type === 'resync').every(record => record.payload.retry === true)).toBe(true);
    expect(failed.payload).toMatchObject({reason:'role-read-failed',retry:true,capability:'degraded'});
    first.close();
    stack.setMalformedRole(false);
    const repaired = await open();
    expect((await repaired.through('ready')).payload).toMatchObject({capability:'complete'});
    expect(repaired.records.find(record => record.type === 'role').payload.health).toBe('healthy');
    repaired.close();
    expect((stack.session as any).controllerCount).toBe(0);
  } finally {abort.abort(); stack.server.app.server.closeAllConnections(); await stack.dispose();}
}, 35_000);
