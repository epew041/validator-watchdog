import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { loadIdentity, publicKeyFromPem, signBytes, verifySignature } from '../src/keys.js';

test('generated identity signs and verifies', () => {
  const id = loadIdentity(null);
  assert.equal(id.stableIdentity, false);
  assert.match(id.publicKeyPem, /BEGIN PUBLIC KEY/);
  const bytes = Buffer.from('hello watchdog', 'utf8');
  const sig = signBytes(id.privateKey, bytes);
  assert.equal(verifySignature(id.publicKey, bytes, sig), true);
});

test('wrong key rejects the signature', () => {
  const a = loadIdentity(null);
  const b = loadIdentity(null);
  const bytes = Buffer.from('hello watchdog', 'utf8');
  const sig = signBytes(a.privateKey, bytes);
  assert.equal(verifySignature(b.publicKey, bytes, sig), false);
});

test('tampered bytes reject the signature', () => {
  const id = loadIdentity(null);
  const sig = signBytes(id.privateKey, Buffer.from('original', 'utf8'));
  assert.equal(verifySignature(id.publicKey, Buffer.from('tampered', 'utf8'), sig), false);
});

test('malformed signature is a clean false, not a throw', () => {
  const id = loadIdentity(null);
  assert.equal(verifySignature(id.publicKey, Buffer.from('x'), '!!!not-base64!!!'), false);
  assert.equal(verifySignature(id.publicKey, Buffer.from('x'), ''), false);
});

test('configured PEM key gives a stable identity with the same public key', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const a = loadIdentity(pem);
  const b = loadIdentity(pem);
  assert.equal(a.stableIdentity, true);
  assert.equal(a.publicKeyPem, b.publicKeyPem);
  assert.equal(a.publicKeyPem, publicKey.export({ format: 'pem', type: 'spki' }));
  const sig = signBytes(a.privateKey, Buffer.from('stable', 'utf8'));
  assert.equal(verifySignature(b.publicKey, Buffer.from('stable', 'utf8'), sig), true);
});

test('non-Ed25519 configured key is rejected', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  assert.throws(() => loadIdentity(pem), /Ed25519/);
});

test('publicKeyFromPem round-trips and rejects non-Ed25519', () => {
  const id = loadIdentity(null);
  const restored = publicKeyFromPem(id.publicKeyPem);
  const sig = signBytes(id.privateKey, Buffer.from('roundtrip', 'utf8'));
  assert.equal(verifySignature(restored, Buffer.from('roundtrip', 'utf8'), sig), true);
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(
    () => publicKeyFromPem(publicKey.export({ format: 'pem', type: 'spki' })),
    /Ed25519/,
  );
});
