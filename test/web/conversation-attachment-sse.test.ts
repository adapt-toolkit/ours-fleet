import { expect, it } from 'vitest';
import { startConversationStack } from './fixtures/conversation-stack.js';
import { ConversationStreamDecoder } from '../../src/web/conversation-stream-codec.js';

it.each(['acp', 'codex'] as const)('preserves uploaded attachment presentation in %s replay and live SSE', async backend => {
  const stack = await startConversationStack({}, backend);
  const abort = new AbortController();
  try {
    const generation = stack.session.conversationSnapshot().sessionGeneration;
    const upload = await fetch(stack.origin + '/api/v1/roles/Alpha/attachments', {
      method: 'POST', headers: stack.jsonHeaders,
      body: JSON.stringify({ expectedSessionGeneration: generation, name: 'picture.png', mimeType: 'image/png', data: Buffer.from('isolated fixture bytes').toString('base64') }),
    });
    expect(upload.status).toBe(200);
    const attachment = await upload.json();
    const submit = async (commandId: string, text: string, attached = true) => {
      const response = await fetch(stack.origin + '/api/v1/roles/Alpha/input', {
        method: 'POST', headers: stack.jsonHeaders,
        body: JSON.stringify({ commandId, text, expectedSessionGeneration: generation, ...(attached ? { attachments: [attachment.id] } : {}) }),
      });
      expect(response.status).toBe(202);
      await response.json();
    };
    const history = async (commandId: string) => {
      const response = await fetch(stack.origin + '/api/v1/roles/Alpha/conversation?latest=1&limit=100', { headers: stack.jsonHeaders });
      expect(response.status).toBe(200);
      const page = await response.json();
      return [...page.context, ...page.events].find(event => event.kind === 'prompt.admitted' && event.commandId === commandId);
    };
    await submit('replay-upload', 'Inspect this upload');
    const expected = await history('replay-upload');
    expect(expected.payload.attachments).toMatchObject([{ id: attachment.id, name: 'picture.png', mimeType: 'image/png' }]);
    const response = await fetch(stack.origin + `/api/v1/roles/Alpha/conversation/events?expectedGeneration=${generation}&after=0`, {
      headers: stack.jsonHeaders, signal: abort.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(), records: any[] = [];
    const decoder = new ConversationStreamDecoder(record => records.push(record));
    const admitted = async (commandId: string) => {
      for (;;) {
        const found = records.find(record => record.type === 'ledger' && record.payload.kind === 'prompt.admitted' && record.payload.commandId === commandId);
        if (found) return found.payload;
        const step = await reader.read();
        expect(step.done).toBe(false);
        decoder.push(step.value!);
      }
    };
    const replay = await admitted('replay-upload');
    expect(replay.payload).toEqual(expected.payload);
    expect(JSON.stringify(replay)).not.toContain(stack.stateDir);
    await submit('live-upload', 'Inspect the second upload');
    const live = await admitted('live-upload');
    expect(live.payload).toEqual((await history('live-upload')).payload);
    expect(live.payload.displayText.text).toBe('Inspect the second upload');
    expect(JSON.stringify(live)).not.toContain(stack.stateDir);
    const literal = 'Attached files (available on this host): ordinary user text';
    await submit('plain-marker', literal, false);
    const plain = await admitted('plain-marker');
    expect(plain.payload.text.text).toBe(literal);
    expect(plain.payload.attachments).toBeUndefined();
  } finally {
    abort.abort();
    await stack.dispose();
  }
}, 20000);
