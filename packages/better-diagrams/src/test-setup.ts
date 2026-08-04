/**
 * test-setup.ts — browser APIs React Flow needs that jsdom does not implement.
 *
 * Without these, mounting <ReactFlow> throws rather than rendering, and the
 * component tests would only ever prove that the import resolved.
 *
 * This file runs for every test file, including the pure-logic ones that use
 * the `node` environment — so everything is guarded on a DOM being present.
 * Touching `HTMLElement` or `SVGElement` unguarded throws during setup, which
 * takes down the worker before a single test reports.
 */

if (typeof window !== "undefined" && typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");

  class ResizeObserverStub {
    private cb: (entries: unknown[], observer: unknown) => void;
    constructor(cb: (entries: unknown[], observer: unknown) => void) {
      this.cb = cb;
    }
    observe(target: Element) {
      // Real browsers deliver an initial observation. React Flow measures
      // nodes AND their handles from it — without the initial fire,
      // `handleBounds` stays undefined and no edge ever renders in jsdom.
      // Some observers read entry.contentRect, so the entry must carry one.
      queueMicrotask(() =>
        this.cb([{ target, contentRect: target.getBoundingClientRect() }], this),
      );
    }
    unobserve() {}
    disconnect() {}
  }

  class DOMMatrixReadOnlyStub {
    m22 = 1;
    constructor(transform?: string) {
      const match = transform?.match(/matrix\(([^)]+)\)/);
      if (match) {
        const parts = match[1].split(",").map((v) => Number.parseFloat(v.trim()));
        this.m22 = Number.isFinite(parts[3]) ? parts[3] : 1;
      }
    }
  }

  globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
  // @ts-expect-error — jsdom has no DOMMatrixReadOnly; React Flow only reads m22.
  globalThis.DOMMatrixReadOnly ??= DOMMatrixReadOnlyStub;

  // React Flow measures nodes through these. jsdom DOES define the getters —
  // returning 0 for everything — and zero-sized measurements are DISCARDED by
  // React Flow's updateNodeInternals, which leaves `handleBounds` undefined
  // and silently skips rendering every edge. Override unconditionally with
  // style-derived sizes.
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return Number.parseFloat(this.style.height) || 76;
      },
    },
    offsetWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return Number.parseFloat(this.style.width) || 170;
      },
    },
  });

  // getBBox is declared on SVGGraphicsElement, not SVGElement, so patching the
  // base prototype needs a cast.
  if (typeof SVGElement !== "undefined") {
    const proto = SVGElement.prototype as unknown as { getBBox?: () => DOMRect };
    proto.getBBox ??= () => ({ x: 0, y: 0, width: 170, height: 76 }) as DOMRect;
  }

  // jsdom implements neither; the download helper touches both.
  globalThis.URL.createObjectURL ??= () => "blob:stub";
  globalThis.URL.revokeObjectURL ??= () => {};

  // The download helper clicks a programmatic <a href>. jsdom responds by
  // attempting real navigation and printing "Not implemented: navigation to
  // another Document" on every export test. Nothing listens to that anchor —
  // it exists only for its default action — so a no-op silences the noise
  // without changing what any test observes. (Re-dispatching the event would
  // not help: jsdom runs anchor activation behaviour on dispatched clicks
  // too, so it would navigate all the same.)
  HTMLAnchorElement.prototype.click = function click() {};

  // React Flow updates its internal store from async work no test can wrap —
  // the resize-observer microtask above, d3-zoom init, fitView timers. Each
  // mount prints dozens of act(...) warnings for library internals, burying
  // real failures. Filter EXACTLY that warning; every other console.error
  // (including act warnings that name no component, and our own code's
  // errors) still comes through.
  const realConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (
      typeof args[0] === "string" &&
      args[0].includes("was not wrapped in act(")
    ) {
      return;
    }
    realConsoleError(...args);
  };

  // jsdom has no pointer capture; the polygon vertex editor uses it so a drag
  // keeps tracking even when the pointer leaves the small handle.
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;

  // CodeMirror (the welcome modal's JSON editor) measures text with ranges
  // and probes elementFromPoint/scrollIntoView; jsdom implements none of them.
  Range.prototype.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
  document.elementFromPoint ??= () => null;
  Element.prototype.scrollIntoView ??= () => {};

  // jsdom leaves `view` null on synthetically dispatched mouse events, and
  // d3-drag (under React Flow) does `event.view.document` on mousedown — so
  // clicking any node throws. Real browsers always populate it; fall back to
  // the window so the drag path behaves as it would in one.
  const viewDescriptor = Object.getOwnPropertyDescriptor(UIEvent.prototype, "view");
  Object.defineProperty(UIEvent.prototype, "view", {
    configurable: true,
    get(this: UIEvent) {
      return viewDescriptor?.get?.call(this) ?? window;
    },
  });
}

// Top-level `await` above requires this file to be a module.
export {};
