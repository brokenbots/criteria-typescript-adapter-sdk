/**
 * Handshake validation for Criteria plugins.
 * 
 * Criteria uses HashiCorp's go-plugin protocol which requires a "magic cookie"
 * handshake to ensure the plugin process was started by a legitimate Criteria
 * host process.
 */

/** Environment variable name for the magic cookie */
export const MAGIC_COOKIE_KEY = 'CRITERIA_PLUGIN';

/** Expected value for the magic cookie */
export const MAGIC_COOKIE_VALUE = '7a1bf31f-c805-4e75-a31c-22195c9fdd4c';

/** go-plugin app protocol version. Must match the host's adapterhost.Handshake. */
export const PROTOCOL_VERSION = 2;

/**
 * Validate the handshake cookie.
 * 
 * If the CRITERIA_PLUGIN environment variable is not set or has the wrong
 * value, the plugin should exit immediately. This prevents accidental
 * execution of plugin binaries as standalone programs.
 * 
 * @returns true if handshake is valid
 * @throws Error if handshake fails
 */
export function validateHandshake(): boolean {
  const cookie = process.env[MAGIC_COOKIE_KEY];
  
  if (!cookie) {
    throw new Error(
      `Missing ${MAGIC_COOKIE_KEY} environment variable. ` +
      'This binary must be started by the Criteria plugin host.'
    );
  }
  
  if (cookie !== MAGIC_COOKIE_VALUE) {
    throw new Error(
      `Invalid ${MAGIC_COOKIE_KEY} value. ` +
      `Expected "${MAGIC_COOKIE_VALUE}", got "${cookie}".`
    );
  }
  
  return true;
}

/**
 * Check if running as a plugin (has valid handshake).
 * Non-throwing version for detection.
 * 
 * @returns true if this is a plugin invocation
 */
export function isPluginInvocation(): boolean {
  return process.env[MAGIC_COOKIE_KEY] === MAGIC_COOKIE_VALUE;
}

/**
 * Validate handshake and exit if invalid.
 * 
 * This function validates the handshake and exits the process if it fails.
 * Use this at the very start of your plugin's main() function.
 * 
 * @example
 * ```typescript
 * import { validateAndExitOnFailure } from '@criteria/adapter-sdk';
 * 
 * // This will exit with code 1 if handshake fails
 * validateAndExitOnFailure();
 * 
 * // Continue with plugin initialization...
 * ```
 */
export function validateAndExitOnFailure(): void {
  try {
    validateHandshake();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
