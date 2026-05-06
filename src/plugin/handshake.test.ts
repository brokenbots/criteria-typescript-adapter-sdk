import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { 
  validateHandshake, 
  isPluginInvocation, 
  MAGIC_COOKIE_KEY, 
  MAGIC_COOKIE_VALUE 
} from './handshake.js';

describe('handshake', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env[MAGIC_COOKIE_KEY];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('validateHandshake', () => {
    it('should throw when cookie is missing', () => {
      expect(() => validateHandshake()).toThrow('Missing CRITERIA_PLUGIN');
    });

    it('should throw when cookie is invalid', () => {
      process.env[MAGIC_COOKIE_KEY] = 'invalid-value';
      expect(() => validateHandshake()).toThrow('Invalid CRITERIA_PLUGIN');
    });

    it('should return true when cookie is valid', () => {
      process.env[MAGIC_COOKIE_KEY] = MAGIC_COOKIE_VALUE;
      expect(validateHandshake()).toBe(true);
    });
  });

  describe('isPluginInvocation', () => {
    it('should return false when cookie is missing', () => {
      expect(isPluginInvocation()).toBe(false);
    });

    it('should return false when cookie is invalid', () => {
      process.env[MAGIC_COOKIE_KEY] = 'invalid-value';
      expect(isPluginInvocation()).toBe(false);
    });

    it('should return true when cookie is valid', () => {
      process.env[MAGIC_COOKIE_KEY] = MAGIC_COOKIE_VALUE;
      expect(isPluginInvocation()).toBe(true);
    });
  });
});
