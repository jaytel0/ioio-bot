// Endpoint-only code. Never import this module into the Worker.
import { createRequire } from 'node:module';
const sodium = createRequire(import.meta.url)('libsodium-wrappers');
import { createHash, randomUUID } from 'node:crypto';
await sodium.ready;

const encode = value => sodium.from_string(JSON.stringify(value));
const hex = value => sodium.to_hex(value);
const keyBytes = value => sodium.from_hex(value);
export const fingerprint = publicKey => createHash('sha256').update(keyBytes(publicKey)).digest('hex');
export function createIdentity() {
  const keys = sodium.crypto_sign_keypair();
  return { public_key: hex(keys.publicKey), private_key: hex(keys.privateKey), trusted: {}, rooms: {} };
}
export function validateIdentity(identity) {
  if (!identity || !/^[a-f0-9]{128}$/.test(identity.private_key ?? '') || !/^[a-f0-9]{64}$/.test(identity.public_key ?? '')) throw new Error('Initialize endpoint encryption with privacy-init');
  const derived = sodium.crypto_sign_seed_keypair(keyBytes(identity.private_key).slice(0, 32));
  if (hex(derived.publicKey) !== identity.public_key || hex(derived.privateKey) !== identity.private_key) throw new Error('Invalid local encryption identity');
  return identity;
}
export function keyRegistration(identity, server, agentId) {
  validateIdentity(identity);
  const message = sodium.from_string(`ioio-key-v1\n${server}\n${agentId}\n${identity.public_key}`);
  return { public_key: identity.public_key, signature: hex(sodium.crypto_sign_detached(message, keyBytes(identity.private_key))) };
}
export function trustPeer(identity, agentId, publicKey, expectedFingerprint) {
  validateIdentity(identity);
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprint ?? '') || fingerprint(publicKey) !== expectedFingerprint) throw new Error('Recipient fingerprint does not match the independently verified fingerprint');
  if (identity.trusted?.[agentId] && identity.trusted[agentId] !== publicKey) throw new Error('Recipient key changed; use a new profile after independently verifying the replacement');
  identity.trusted = { ...identity.trusted, [agentId]: publicKey };
}
export function trustRoom(identity, room, members, selfId) {
  validateIdentity(identity);
  const approved = [...new Set([...members, selfId])].sort();
  if (!room || approved.some(id => id !== selfId && !identity.trusted?.[id])) throw new Error('Verify all intended room members independently before approving room membership');
  identity.rooms = { ...identity.rooms, [room]: approved };
}
function peerKey(identity, id, directoryKey, selfId) {
  const pinned = id === selfId ? identity.public_key : identity.trusted?.[id];
  if (!pinned) throw new Error(`Verify and trust ${id}'s fingerprint locally before messaging. IO cannot verify recipient keys for you.`);
  if (!directoryKey || pinned !== directoryKey) throw new Error('Recipient key changed or encryption is not configured; message was not sent');
  return pinned;
}
const binding = (server, from, input) => ({ domain: 'ioio-message-v1', server, from, to: input.to ?? null, room: input.room ?? null, kind: input.kind ?? 'message', thread_id: input.thread_id, reply_to: input.reply_to ?? null, client_message_id: input.client_message_id, mentions: input.mentions ?? [], hop_count: input.hop_count ?? 0 });
export function encryptMessage(identity, server, selfId, input, recipients) {
  validateIdentity(identity);
  if (Boolean(input.to) === Boolean(input.room)) throw new Error('Choose exactly one recipient or room');
  if (!['message','request','response','status'].includes(input.kind ?? 'message')) throw new Error('Invalid message kind');
  if (input.room) {
    const actual = [...new Set([...recipients.map(peer => peer.id), selfId])].sort();
    if (!identity.rooms?.[input.room] || JSON.stringify(actual) !== JSON.stringify(identity.rooms[input.room])) throw new Error('Room membership is not independently approved or has changed; message was not sent');
  }
  if ((!input.text?.trim() && input.data === undefined) || (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 12000))) throw new Error('Provide text or JSON data (text maximum 12000 characters)');
  const route = { ...(input.to ? { to: input.to } : { room: input.room }), kind: input.kind ?? 'message', thread_id: input.thread_id ?? randomUUID(), ...(input.reply_to ? { reply_to: input.reply_to } : {}), client_message_id: input.client_message_id ?? randomUUID(), mentions: input.mentions ?? [], hop_count: input.hop_count ?? 0 };
  const signed = sodium.crypto_sign(encode({ ...binding(server, selfId, route), payload: { ...(input.text === undefined ? {} : { text: input.text }), ...(input.data === undefined ? {} : { data: input.data }) } }), keyBytes(identity.private_key));
  if (signed.length > 16500) throw new Error('Message exceeds the encrypted payload limit');
  const boxes = {};
  // A self-copy lets the sender read its response until recipient acknowledgement.
  for (const recipient of [...recipients, { id: selfId, encryption_key: identity.public_key }]) {
    const key = peerKey(identity, recipient.id, recipient.encryption_key, selfId);
    const encryptionKey = sodium.crypto_sign_ed25519_pk_to_curve25519(keyBytes(key));
    boxes[recipient.id] = { key, ciphertext: sodium.to_base64(sodium.crypto_box_seal(signed, encryptionKey), sodium.base64_variants.ORIGINAL) };
  }
  return { ...route, encrypted: { format: 'ioio-e2ee-v1', sender_key: identity.public_key, recipients: boxes } };
}
export function decryptMessage(identity, server, selfId, message) {
  validateIdentity(identity);
  if (message.from === 'BTB') return message; // Service-generated permission notices contain no user-authored text.
  if (!message.encrypted) return { ...message, text: null, data: null, content_unavailable: true };
  const envelope = message.encrypted;
  if (envelope.format !== 'ioio-e2ee-v1') throw new Error('Unsupported encrypted message');
  const senderKey = peerKey(identity, message.from, envelope.sender_key, selfId);
  if (message.room && (!identity.rooms?.[message.room]?.includes(message.from) || !identity.rooms[message.room].includes(selfId))) throw new Error('Incoming room membership is not independently approved');
  const box = envelope.recipients[selfId];
  if (!box || box.key !== identity.public_key) throw new Error('Encrypted message is not addressed to this local identity');
  try {
    const privateKey = sodium.crypto_sign_ed25519_sk_to_curve25519(keyBytes(identity.private_key));
    const publicKey = sodium.crypto_sign_ed25519_pk_to_curve25519(keyBytes(identity.public_key));
    const signed = sodium.crypto_box_seal_open(sodium.from_base64(box.ciphertext, sodium.base64_variants.ORIGINAL), publicKey, privateKey);
    const plain = JSON.parse(sodium.to_string(sodium.crypto_sign_open(signed, keyBytes(senderKey))));
    const expected = binding(server, message.from, message);
    if (JSON.stringify(Object.fromEntries(Object.keys(expected).map(key => [key, plain[key]]))) !== JSON.stringify(expected)) throw new Error('Message routing authentication failed');
    const { encrypted, ...metadata } = message;
    return { ...metadata, text: plain.payload.text ?? null, data: plain.payload.data ?? null, end_to_end_encrypted: true };
  } catch { throw new Error('Encrypted message authentication failed; no content released'); }
}
export async function prepareMessage(identity, server, selfId, input, request) {
  if (Boolean(input.to) === Boolean(input.room)) throw new Error('Choose exactly one recipient or room');
  let prepared = { ...input };
  if (input.reply_to) {
    const parent = await request('/v1/messages/' + input.reply_to);
    prepared.thread_id = input.thread_id ?? parent.thread_id;
    prepared.hop_count = parent.hop_count + 1;
  }
  let recipients;
  if (input.to) recipients = (await request('/v1/agents')).agents.filter(agent => agent.id === input.to);
  else recipients = (await request('/v1/rooms')).rooms.find(room => room.id === input.room)?.participants.filter(agent => agent.id !== selfId);
  if (!recipients?.length) throw new Error('No approved encrypted recipients found');
  return encryptMessage(identity, server, selfId, prepared, recipients);
}
export function decryptResult(identity, server, selfId, result) {
  if (Array.isArray(result.messages)) return { ...result, messages: result.messages.map(message => decryptMessage(identity, server, selfId, message)) };
  if (result.from) return decryptMessage(identity, server, selfId, result);
  return result;
}
