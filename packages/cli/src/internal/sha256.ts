/**
 * SHA-256 hashing shared by the generation builder and the doctor checks.
 * @module @eedsh/cli/internal/sha256
 */
import { createHash } from 'node:crypto'

/**
 * The lowercase hex SHA-256 digest of a UTF-8 string.
 * @param text - the text to hash.
 * @returns the 64-character hex digest.
 */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
