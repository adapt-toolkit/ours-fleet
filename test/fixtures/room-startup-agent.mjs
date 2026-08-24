import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const sessionId = 'room-startup-fixture';
const scenario = JSON.parse(process.env.ROOM_STARTUP_SCENARIO);
const eventPath = process.env.ROOM_STARTUP_EVENTS;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const event = value => appendFileSync(eventPath, JSON.stringify(value) + '\n');
const update = text => send({
  jsonrpc: '2.0', method: 'session/update',
  params: {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  },
});
let started = false;

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  switch (message.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } },
      } });
      break;
    case 'session/new':
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
      break;
    case 'session/close':
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      break;
    case 'session/prompt': {
      const text = message.params.prompt.find(block => block.type === 'text')?.text ?? '';
      let output;
      if (!started) {
        started = true;
        const envelope = scenario.envelope;
        const hash = createHash('sha256').update(Buffer.from(envelope.text, 'utf8')).digest('hex');
        const metadataMatches = envelope.outer_sender_cid === scenario.room_identity_cid
          && envelope.author.identity === scenario.room_identity_cid
          && envelope.room_id === scenario.room_id
          && envelope.briefing_role === scenario.briefing_role
          && envelope.briefing_version === scenario.briefing_version
          && hash === scenario.briefing_sha256
          && text.includes(`Room identity CID: \`${scenario.room_identity_cid}\``)
          && text.indexOf('Call **get_messages**') < text.indexOf('Wakes arrive as [fleet-monitor]');
        if (!metadataMatches) throw new Error('generated startup gate or signed envelope mismatch');
        const bio = `${scenario.briefing_role} room member; applies the authenticated room Charter before readiness.`;
        event({ kind: 'envelope_verified', message_id: envelope.message_id });
        event({ kind: 'persona_set', value: envelope.text });
        event({ kind: 'bio_set', value: bio });
        event({ kind: 'profile_readback', persona: envelope.text, bio });
        const ack = {
          kind: 'fleet_room_briefing_ack', schema_version: 1,
          room_id: scenario.room_id, room_identity_cid: scenario.room_identity_cid,
          briefing_role: scenario.briefing_role,
          briefing_version: scenario.briefing_version,
          briefing_sha256: scenario.briefing_sha256,
          briefing_message_id: envelope.message_id,
          owner_seat_cid: scenario.owner_seat_cid,
          accepted: true, applied: true, profile_applied: true,
        };
        event({ kind: 'ack_sent', value: ack });
        output = JSON.stringify(ack);
      } else {
        const stimulus = JSON.parse(text);
        const authority = stimulus.author.identity === scenario.owner_seat_cid ? 'owner' : 'peer';
        event({
          kind: 'stimulus_handled', authority,
          author_cid: stimulus.author.identity, display_role: stimulus.author.role,
        });
        output = `${authority}:${stimulus.text}`;
      }
      update(output);
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      break;
    }
  }
});
