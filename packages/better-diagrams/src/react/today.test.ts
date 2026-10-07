/**
 * @vitest-environment jsdom
 *
 * The date an editor left open overnight measures overdue against: it turns
 * over at local midnight on its own, and catches up when the tab is shown
 * again after a sleep that outlasted the timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useToday } from "./today";

describe("useToday", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date(2026, 9, 2, 23, 59, 30));
  });
  afterEach(() => vi.useRealTimers());

  it("turns over at local midnight", () => {
    const { result } = renderHook(() => useToday());
    expect(result.current).toBe("2026-10-02");
    act(() => vi.advanceTimersByTime(20_000));
    expect(result.current).toBe("2026-10-02");
    act(() => vi.advanceTimersByTime(20_000));
    expect(result.current).toBe("2026-10-03");
    // And again the next night — the timer re-arms itself.
    act(() => vi.advanceTimersByTime(24 * 60 * 60 * 1000));
    expect(result.current).toBe("2026-10-04");
  });

  it("catches up when the tab is shown again", () => {
    const { result } = renderHook(() => useToday());
    vi.setSystemTime(new Date(2026, 9, 5, 8, 0, 0));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe("2026-10-05");
  });

  it("stops listening once unmounted", () => {
    const { unmount } = renderHook(() => useToday());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
