import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installProcessGuards } from './process-guards.js';

describe('proteções do processo', () => {
  it('promise rejeitada sem catch é logada em vez de derrubar a API', () => {
    const proc = new EventEmitter();
    const log = { error: vi.fn() };
    installProcessGuards(proc as unknown as NodeJS.Process, log);
    const err = new Error('EACCES no índice');
    expect(() => proc.emit('unhandledRejection', err, Promise.resolve())).not.toThrow();
    expect(log.error).toHaveBeenCalledWith({ err }, 'unhandled rejection');
  });
});
