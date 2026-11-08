/**
 * Hashes a password using SHA-256 via native SubtleCrypto API.
 * @param {string} password 
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  if (!password) return ''
  const msgUint8 = new TextEncoder().encode(password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  return hashHex
}
