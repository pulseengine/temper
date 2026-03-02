import { spawn } from 'node:child_process';
import { triggerSelfUpdate } from '../../src/self-update.js';

jest.mock('node:child_process', () => ({
  spawn: jest.fn(() => ({ unref: jest.fn() }))
}));

describe('triggerSelfUpdate', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('spawns the self-update binary as a detached process', () => {
    triggerSelfUpdate(mockLogger);

    expect(spawn).toHaveBeenCalledTimes(1);
    const [binary, args, opts] = spawn.mock.calls[0];
    expect(binary).toContain('temper-self-update');
    expect(args).toEqual([]);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
  });

  it('passes TEMPER_PID and TEMPER_REPO_DIR as env vars', () => {
    triggerSelfUpdate(mockLogger);

    const opts = spawn.mock.calls[0][2];
    expect(opts.env.TEMPER_PID).toBe(String(process.pid));
    expect(opts.env.TEMPER_REPO_DIR).toBeDefined();
  });

  it('calls unref() on the child process', () => {
    const mockUnref = jest.fn();
    spawn.mockReturnValue({ unref: mockUnref });

    triggerSelfUpdate(mockLogger);

    expect(mockUnref).toHaveBeenCalledTimes(1);
  });

  it('logs that the update is being triggered', () => {
    triggerSelfUpdate(mockLogger);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('self-update')
    );
  });
});
