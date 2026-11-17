/**
 * @vitest-environment jsdom
 *
 * keys.ts — which keys a focused control keeps, and which still belong to
 * the editor. Each case is a control a person had just used when the key
 * went to the wrong place.
 */
import { afterEach, describe, expect, it } from "vitest";
import { claimKeyboard, controlOwnsKey, isTypingTarget, ownsKeyboard, releaseKeyboard } from "./keys";

const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: k, ...init });

function el(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.querySelector("[data-t]") as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isTypingTarget on a <select>", () => {
  it("keeps letters and arrows for the select", () => {
    const select = el(`<select data-t><option>a</option></select>`);
    expect(isTypingTarget(select, key("a"))).toBe(true);
    expect(isTypingTarget(select, key("ArrowDown"))).toBe(true);
    expect(isTypingTarget(select)).toBe(true);
  });

  it("lets ⌘Z, ⇧⌘Z and ⌘Y through, so undo works straight after a pick", () => {
    const select = el(`<select data-t><option>a</option></select>`);
    expect(isTypingTarget(select, key("z", { metaKey: true }))).toBe(false);
    expect(isTypingTarget(select, key("z", { metaKey: true, shiftKey: true }))).toBe(false);
    expect(isTypingTarget(select, key("y", { ctrlKey: true }))).toBe(false);
  });

  it("still stands down for a text field's ⌘Z, which is the field's own undo", () => {
    const input = el(`<input data-t type="text" />`);
    expect(isTypingTarget(input, key("z", { metaKey: true }))).toBe(true);
  });
});

describe("controlOwnsKey", () => {
  it("gives a slider its arrows", () => {
    const range = el(`<input data-t type="range" />`);
    expect(controlOwnsKey(range, key("ArrowRight"))).toBe(true);
    expect(controlOwnsKey(range, key("ArrowUp", { shiftKey: true }))).toBe(true);
  });

  it("gives a select and a radio their arrows", () => {
    expect(controlOwnsKey(el(`<select data-t></select>`), key("ArrowDown"))).toBe(true);
    expect(controlOwnsKey(el(`<input data-t type="radio" name="r" />`), key("ArrowLeft"))).toBe(true);
  });

  it("gives a menu its arrows, whatever its rows are made of", () => {
    const row = el(`<div role="menu"><button data-t role="menuitem">Tidy</button></div>`);
    expect(controlOwnsKey(row, key("ArrowLeft"))).toBe(true);
    const tick = el(`<div role="menu"><label><input data-t type="checkbox" /> Snap</label></div>`);
    expect(controlOwnsKey(tick, key("ArrowDown"))).toBe(true);
  });

  it("leaves the arrows to the canvas on a plain button or a tick box, which do nothing with them", () => {
    expect(controlOwnsKey(el(`<button data-t>Swatch</button>`), key("ArrowRight"))).toBe(false);
    expect(controlOwnsKey(el(`<input data-t type="checkbox" />`), key("ArrowRight"))).toBe(false);
  });

  it("gives Enter and Space to what they press", () => {
    for (const html of [
      `<button data-t>Undo</button>`,
      `<div data-t role="menuitem">Tidy</div>`,
      `<select data-t></select>`,
      `<input data-t type="checkbox" />`,
      `<input data-t type="color" />`,
      `<a data-t href="#x">x</a>`,
      `<div data-t role="button" tabindex="0">x</div>`,
    ]) {
      expect(controlOwnsKey(el(html), key("Enter")), html).toBe(true);
      expect(controlOwnsKey(el(html), key(" ")), html).toBe(true);
    }
  });

  it("leaves everything else, and anything with nothing focused, to the editor", () => {
    expect(controlOwnsKey(el(`<button data-t>Undo</button>`), key("Delete"))).toBe(false);
    expect(controlOwnsKey(document.body, key("Enter"))).toBe(false);
    expect(controlOwnsKey(null, key("Enter"))).toBe(false);
  });
});

describe("the keyboard claim", () => {
  it("goes to the editor focus is in, else to the one touched last", () => {
    const a = Symbol("a");
    const b = Symbol("b");
    const rootA = el(`<div data-t><input /></div>`);
    const rootB = document.createElement("div");
    document.body.appendChild(rootB);
    claimKeyboard(a, { ifFree: true });
    claimKeyboard(b, { ifFree: true });
    // The first to mount holds it; the second only asked if it was free.
    expect(ownsKeyboard(rootA, a)).toBe(true);
    expect(ownsKeyboard(rootB, b)).toBe(false);
    claimKeyboard(b);
    expect(ownsKeyboard(rootA, a)).toBe(false);
    expect(ownsKeyboard(rootB, b)).toBe(true);
    // Focus inside an editor outranks the claim.
    rootA.querySelector("input")!.focus();
    expect(ownsKeyboard(rootA, a)).toBe(true);
    expect(ownsKeyboard(rootB, b)).toBe(false);
    releaseKeyboard(a);
    releaseKeyboard(b);
  });
});
