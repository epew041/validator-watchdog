// Ed25519 identity for signing report entries. Node crypto stdlib only.
//
// Identity model (stated plainly, because it decides what "verified" means):
// - If WATCHDOG_PRIVATE_KEY holds a PKCS#8 PEM Ed25519 private key, that key
//   is the agent's stable identity across restarts. Reports signed in every
//   boot verify against the same public key.
// - If the variable is absent, a fresh keypair is generated at boot and the
//   reports from that boot verify ONLY against the public key published by
//   that same boot at GET /public-key. A restart starts a new identity.
// The private key is never written to disk, never logged, and never leaves
// this process.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

export function loadIdentity(privateKeyPem) {
  if (privateKeyPem) {
    const privateKey = createPrivateKey(privateKeyPem);
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('WATCHDOG_PRIVATE_KEY must be an Ed25519 private key (PKCS#8 PEM)');
    }
    const publicKey = createPublicKey(privateKey);
    return {
      privateKey,
      publicKey,
      publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
      stableIdentity: true,
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKey,
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
    stableIdentity: false,
  };
}

export function signBytes(privateKey, bytes) {
  return sign(null, bytes, privateKey).toString('base64');
}

export function verifySignature(publicKey, bytes, signatureBase64) {
  try {
    const signature = Buffer.from(signatureBase64, 'base64');
    return verify(null, bytes, publicKey, signature);
  } catch {
    return false;
  }
}

export function publicKeyFromPem(pem) {
  const publicKey = createPublicKey(pem);
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('public key is not Ed25519');
  }
  return publicKey;
}
