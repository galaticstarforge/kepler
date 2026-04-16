import { execSync } from 'node:child_process';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { checkAwsCli, checkSsmPlugin } from '../src/lib/prerequisites.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

describe('checkAwsCli', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when aws --version succeeds', () => {
    mockExecSync.mockReturnValue(Buffer.from('aws-cli/2.15.0'));
    expect(checkAwsCli()).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith('aws --version', { stdio: 'pipe' });
  });

  it('returns false when aws --version throws', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });
    expect(checkAwsCli()).toBe(false);
  });
});

describe('checkSsmPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when session-manager-plugin succeeds', () => {
    mockExecSync.mockReturnValue(Buffer.from(''));
    expect(checkSsmPlugin()).toBe(true);
  });

  it('returns true when first call fails but --version succeeds', () => {
    let callCount = 0;
    mockExecSync.mockImplementation((() => {
      callCount++;
      if (callCount === 1) {
        // On Windows, 'where.exe' call; on Unix, bare command call
        throw new Error('failed');
      }
      return Buffer.from('1.2.3');
    }) as typeof execSync);

    // The behavior depends on platform
    // On Windows: first try where.exe, if that fails => false
    // On Unix: first try bare command, then --version
    if (process.platform === 'win32') {
      expect(checkSsmPlugin()).toBe(false);
    } else {
      expect(checkSsmPlugin()).toBe(true);
    }
  });

  it('returns false when all detection methods fail with exit code 127', () => {
    const error = new Error('command not found') as Error & { status: number };
    error.status = 127;
    mockExecSync.mockImplementation(() => {
      throw error;
    });

    expect(checkSsmPlugin()).toBe(false);
  });

  it('returns true on non-127 exit code (command found but errored)', () => {
    if (process.platform === 'win32') {
      // On Windows, only where.exe is called — a throw means not found
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(checkSsmPlugin()).toBe(false);
    } else {
      let callCount = 0;
      const error = new Error('bad args') as Error & { status: number };
      error.status = 1; // non-127 = command exists
      mockExecSync.mockImplementation((() => {
        callCount++;
        if (callCount <= 2) throw error;
        return Buffer.from('');
      }) as typeof execSync);

      expect(checkSsmPlugin()).toBe(true);
    }
  });
});
