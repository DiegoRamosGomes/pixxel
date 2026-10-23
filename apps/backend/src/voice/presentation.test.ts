import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelPresentation, isMouseKeyboardTestRunning, runMouseKeyboardTest } from './presentation.js';

describe('apresentação', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancelPresentation para as chamadas locais seguintes', async () => {
    vi.useFakeTimers();
    const local = vi.fn().mockResolvedValue({ ok: true });
    const ctx = { say: vi.fn(), local, showWidget: vi.fn(() => 'w1'), dismissWidget: vi.fn() };
    const run = runMouseKeyboardTest(ctx);
    await vi.advanceTimersByTimeAsync(7000);
    const before = local.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    cancelPresentation();
    await vi.runAllTimersAsync();
    await run;
    expect(local.mock.calls.length).toBe(before);
    expect(isMouseKeyboardTestRunning()).toBe(false);
  });

  it('teste de mouse usa desktop_mouse em porcentagem', async () => {
    vi.useFakeTimers();
    const local = vi.fn().mockResolvedValue({ ok: true });
    const ctx = { say: vi.fn(), local, showWidget: vi.fn(() => 'w1'), dismissWidget: vi.fn() };
    const run = runMouseKeyboardTest(ctx);
    await vi.runAllTimersAsync();
    await run;
    expect(local).toHaveBeenCalledWith('desktop_mouse', { x: 50, y: 50, unit: 'percent', action: 'move' });
    expect(local).toHaveBeenCalledWith('desktop_type', expect.objectContaining({ text: expect.any(String) }));
    expect(local).toHaveBeenCalledWith('desktop_key', { combo: 'Home' });
  });
});
