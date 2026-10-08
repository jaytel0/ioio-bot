import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createIdentity, fingerprint, trustPeer, trustRoom, encryptMessage, decryptMessage, keyRegistration } from '../bin/e2ee.mjs';

const server = 'https://ioio.example', aliceId = 'A-000-000-001', bobId = 'A-000-000-002', eveId = 'A-000-000-003';
function fixture() {
  const alice = createIdentity(), bob = createIdentity(), eve = createIdentity();
  trustPeer(alice, bobId, bob.public_key, fingerprint(bob.public_key));
  trustPeer(bob, aliceId, alice.public_key, fingerprint(alice.public_key));
  return { alice, bob, eve };
}
function message(envelope, from = aliceId) {
  return { ...envelope, id: 1, from, to: envelope.to ?? null, room: envelope.room ?? null, reply_to: envelope.reply_to ?? null };
}
test('only intended verified endpoints recover text and exact JSON; relay has no private keys or content', () => {
  const { alice, bob, eve } = fixture(), text = 'private fixture: not a relay-readable conversation';
  const data = { cost: 0, available: false, nested: { list: [null, 'booking'] } };
  const wire = encryptMessage(alice, server, aliceId, { to: bobId, text, data, client_message_id: randomUUID() }, [{ id: bobId, encryption_key: bob.public_key }]);
  assert(!JSON.stringify(wire).includes(text)); assert(!JSON.stringify(wire).includes('booking'));
  assert(!JSON.stringify(wire).includes(alice.private_key)); assert(!JSON.stringify(wire).includes(bob.private_key));
  const received = decryptMessage(bob, server, bobId, message(wire));
  assert.equal(received.text, text); assert.deepEqual(received.data, data); assert.equal(received.encrypted, undefined);
  assert.equal(decryptMessage(alice, server, aliceId, message(wire)).text, text);
  trustPeer(eve, aliceId, alice.public_key, fingerprint(alice.public_key));
  assert.throws(() => decryptMessage(eve, server, eveId, message(wire)), /not addressed/);
  assert.equal(Object.keys(keyRegistration(alice, server, aliceId)).join(','), 'public_key,signature');
});
test('unverified recipient and relay key substitution fail before content leaves the endpoint', () => {
  const { alice, bob, eve } = fixture(), input = { to: bobId, text: 'private', client_message_id: randomUUID() };
  assert.throws(() => encryptMessage(createIdentity(), server, aliceId, input, [{ id: bobId, encryption_key: bob.public_key }]), /Verify and trust/);
  assert.throws(() => trustPeer(alice, eveId, eve.public_key, fingerprint(bob.public_key)), /does not match/);
  assert.throws(() => encryptMessage(alice, server, aliceId, input, [{ id: bobId, encryption_key: eve.public_key }]), /key changed/);
  assert.throws(() => trustPeer(alice, bobId, eve.public_key, fingerprint(eve.public_key)), /key changed/);
});
test('tampered ciphertext, sender, route, thread, kind and destination origin release no content', () => {
  const { alice, bob } = fixture();
  const wire = encryptMessage(alice, server, aliceId, { to: bobId, text: 'private', client_message_id: randomUUID() }, [{ id: bobId, encryption_key: bob.public_key }]);
  for (const changes of [{ thread_id: randomUUID() }, { client_message_id: 'replay-as-another-message' }, { to: eveId }, { room: 'different' }, { kind: 'status' }, { mentions: [eveId] }, { hop_count: 1 }, { reply_to: 8 }]) assert.throws(() => decryptMessage(bob, server, bobId, { ...message(wire), ...changes }), /authentication failed|membership/);
  assert.throws(() => decryptMessage(bob, 'https://different.example', bobId, message(wire)), /authentication failed/);
  const modified = structuredClone(wire); const box = modified.encrypted.recipients[bobId]; box.ciphertext = 'AAAA' + box.ciphertext.slice(4);
  assert.throws(() => decryptMessage(bob, server, bobId, message(modified)), /authentication failed/);
});
test('room content uses a separately sealed copy for each verified endpoint', () => {
  const { alice, bob, eve } = fixture();
  trustPeer(alice, eveId, eve.public_key, fingerprint(eve.public_key)); trustPeer(eve, aliceId, alice.public_key, fingerprint(alice.public_key));
  trustRoom(alice,'home',[bobId,eveId],aliceId);
  trustPeer(bob,eveId,eve.public_key,fingerprint(eve.public_key)); trustRoom(bob,'home',[aliceId,eveId],bobId);
  trustPeer(eve,bobId,bob.public_key,fingerprint(bob.public_key)); trustRoom(eve,'home',[aliceId,bobId],eveId);
  const wire = encryptMessage(alice, server, aliceId, { room: 'home', text: 'private group', client_message_id: randomUUID() }, [{ id: bobId, encryption_key: bob.public_key }, { id: eveId, encryption_key: eve.public_key }]);
  assert.notEqual(wire.encrypted.recipients[bobId].ciphertext, wire.encrypted.recipients[eveId].ciphertext);
  assert.equal(decryptMessage(bob, server, bobId, message(wire)).text, 'private group');
  assert.equal(decryptMessage(eve, server, eveId, message(wire)).text, 'private group');
});
test('the relay cannot add an already trusted contact to a private room', () => {
  const {alice,bob,eve}=fixture(); trustPeer(alice,eveId,eve.public_key,fingerprint(eve.public_key));
  trustRoom(alice,'home',[bobId],aliceId);
  assert.throws(()=>encryptMessage(alice,server,aliceId,{room:'home',text:'private group',client_message_id:randomUUID()},[{id:bobId,encryption_key:bob.public_key},{id:eveId,encryption_key:eve.public_key}]),/membership.*changed/);
});
