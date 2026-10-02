import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, key] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const given = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, given);
}
