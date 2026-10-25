/**
 * SearchSelect — a dropdown you can type into.
 *
 * A native <select> only jumps to the first option starting with a letter;
 * it can't narrow a list of forty icons to the three with "data" in them. So
 * the inspector's pickers are a button wearing `.as-select` over a menu with
 * a search box at its top. Opening the menu focuses that box, and a printable
 * key pressed on the closed button opens it with that key already typed — so
 * "just start typing" works either way.
 *
 * `useSearchMenu` is the behaviour alone (open/close, the query, the active
 * row, the keys) so `KindSelect` can keep its own sectioned rendering and
 * still filter the same way.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/** Does `text` contain every word of `query`, ignoring case? */
export function matchesQuery(query: string, ...text: Array<string | undefined>): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = text.filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The rows a query leaves, in order; arrows skip the ones marked disabled. */
type VisibleRows = ReadonlyArray<{ value: string; disabled?: boolean }>;

/**
 * Inferred rather than spelled out: React 18 and 19 type `useRef(null)`
 * differently, and CI builds against both.
 */
export type SearchMenu = ReturnType<typeof useSearchMenu>;

export function useSearchMenu({
  disabled = false,
  selected = null,
}: {
  disabled?: boolean;
  /** The current value: an unfiltered menu opens with it highlighted, as a native select does. */
  selected?: string | null;
} = {}) {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  // The row Enter would pick, by value; null means the first enabled one.
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  // Values are free text ("aws-lambda", "", "in-review"); an id may not hold a space.
  const optionId = useCallback((value: string) => `${baseId}-opt-${value.replace(/[^\w-]/g, "_")}`, [baseId]);

  const close = useCallback((refocus = false) => {
    setOpen(false);
    setQueryState("");
    setActiveValue(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const openWith = useCallback(
    (seed: string) => {
      if (disabled) return;
      setQueryState(seed);
      setActiveValue(seed ? null : selected);
      setOpen(true);
    },
    [disabled, selected],
  );

  // A click anywhere else closes it, as a native select's would.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  // Typing goes straight into the box: focus it on open, caret after any
  // key that opened it.
  useEffect(() => {
    if (!open) return;
    const box = searchRef.current;
    if (!box) return;
    // No scroll: the menu closes when something around it scrolls.
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length, box.value.length);
  }, [open]);

  // Keep the active row in view as the arrows walk past the menu's edge —
  // scrolling the menu alone, by hand: `scrollIntoView` parks a row under the
  // sticky search box, and can scroll the page too, which closes the menu.
  useEffect(() => {
    const list = listRef.current;
    const scroller = list?.parentElement;
    const row = list?.querySelector<HTMLElement>("[data-active='true']");
    if (!open || !scroller || !row) return;
    const r = row.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    const top = s.top + (searchRef.current?.offsetHeight ?? 0) + 4;
    if (r.top < top) scroller.scrollTop -= top - r.top;
    else if (r.bottom > s.bottom) scroller.scrollTop += r.bottom - s.bottom;
  }, [open, activeValue, query]);

  // The keys this takes are the picker's alone: the editor listens on
  // `window`, where a letter is a shortcut and an arrow nudges the selected
  // node. A button isn't a typing target there (`isTypingTarget`), so they
  // stop here. Everything else — ⌘Z, Delete — still reaches the editor.
  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      openWith("");
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // A printable key: open already searching for it.
      event.preventDefault();
      event.stopPropagation();
      openWith(event.key);
    }
  };

  /** The search box's keys, over the rows the query leaves. */
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>, visible: VisibleRows, pick: (value: string) => void) => {
    const enabled = visible.filter((o) => !o.disabled);
    const current = enabled.findIndex((o) => o.value === activeValue);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!enabled.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      // No active row yet means the first one is showing as active.
      const from = current === -1 ? 0 : current;
      setActiveValue(enabled[(from + step + enabled.length) % enabled.length]!.value);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = enabled[current === -1 ? 0 : current];
      if (chosen) pick(chosen.value);
    } else if (event.key === "Escape") {
      // Ours alone: the editor's own Escape would clear the selection and
      // take this inspector away with it.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      close();
    }
  };

  return {
    open,
    query,
    activeValue,
    wrapRef,
    triggerRef,
    searchRef,
    listRef,
    listId,
    optionId,
    toggle: () => (open ? close() : openWith("")),
    /** Close; `refocus` hands focus back to the button, as Escape should. */
    close,
    setQuery: (next: string) => {
      setQueryState(next);
      setActiveValue(null);
    },
    setActiveValue,
    onTriggerKeyDown,
    onSearchKeyDown,
  };
}

/** The search box at the top of a menu — shared so every picker reads alike. */
export function SearchMenuBox({
  menu,
  visible,
  pick,
  label,
}: {
  menu: SearchMenu;
  visible: VisibleRows;
  pick: (value: string) => void;
  label: string;
}) {
  const enabled = visible.filter((o) => !o.disabled);
  const active = enabled.find((o) => o.value === menu.activeValue) ?? enabled[0];
  return (
    <input
      ref={menu.searchRef}
      className="as-input as-searchmenu__box"
      type="search"
      role="combobox"
      aria-expanded="true"
      aria-controls={menu.listId}
      aria-autocomplete="list"
      aria-activedescendant={active ? menu.optionId(active.value) : undefined}
      aria-label={`Search ${label}`}
      placeholder="Search…"
      autoComplete="off"
      spellCheck={false}
      value={menu.query}
      onChange={(event) => menu.setQuery(event.target.value)}
      onKeyDown={(event) => menu.onSearchKeyDown(event, visible, pick)}
    />
  );
}

export interface SearchOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** More words the search should find this row by. */
  keywords?: string;
  /** A tooltip for the row: what a relationship kind means, say. */
  title?: string;
  /** A picture before the label — an icon's own glyph, in the icon picker. */
  icon?: ReactNode;
}

export interface SearchSelectProps {
  value: string;
  options: readonly SearchOption[];
  onChange: (value: string) => void;
  /** The selection disagrees: the button reads `placeholder`, no row is ticked. */
  mixed?: boolean;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
  "aria-label": string;
}

export function SearchSelect({
  value,
  options,
  onChange,
  mixed = false,
  placeholder = "Mixed",
  disabled = false,
  title,
  className,
  "aria-label": label,
}: SearchSelectProps) {
  const menu = useSearchMenu({ disabled, selected: mixed ? null : value });
  const menuRef = useRef<HTMLDivElement>(null);
  const current = mixed ? undefined : options.find((o) => o.value === value);
  const visible = options.filter((o) => matchesQuery(menu.query, o.label, o.value, o.keywords));
  const enabled = visible.filter((o) => !o.disabled);
  const active = enabled.find((o) => o.value === menu.activeValue) ?? enabled[0];

  const pick = (next: string) => {
    menu.close(true);
    if (mixed || next !== value) onChange(next);
  };

  // Placed against the box that contains it, not against the button. The
  // wrapper is deliberately unpositioned, so the menu hangs off the nearest
  // positioned ancestor — the inspector — and a scrolling one in between (a
  // table's field list) can't clip it. Every render while open, because the
  // query changes its height; anchored by its bottom, it drops UP from the
  // button as `KindSelect`'s does, the inspector being at the canvas's foot.
  useLayoutEffect(() => {
    const el = menuRef.current;
    const trigger = menu.triggerRef.current;
    const box = el?.offsetParent as HTMLElement | null | undefined;
    if (!menu.open || !el || !trigger || !box) return;
    const t = trigger.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    el.style.left = `${t.left - b.left - box.clientLeft + box.scrollLeft}px`;
    el.style.bottom = `${b.top + box.clientTop + box.clientHeight - box.scrollTop - t.top + 6}px`;
    el.style.minWidth = `${Math.max(t.width, 160)}px`;
  });

  // Placed once per render, it would be left behind by anything that moves
  // the button under it — so, like a native select, it closes instead.
  const { open, close } = menu;
  useEffect(() => {
    if (!open) return;
    const onScroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    const onResize = () => close();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);

  return (
    <div className={`as-searchselect${className ? ` ${className}` : ""}`} ref={menu.wrapRef}>
      <button
        ref={menu.triggerRef}
        type="button"
        className="as-select as-searchselect__button"
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={menu.open}
        aria-label={label}
        title={title ?? label}
        disabled={disabled}
      >
        {/* A value no row offers (a 12px note, a registry's own icon) shows
            as itself: "Mixed" would claim a disagreement there isn't. */}
        {!mixed && current?.icon ? current.icon : null}
        <span className="as-searchselect__value">{mixed ? placeholder : (current?.label ?? value)}</span>
      </button>
      {menu.open ? (
        <div ref={menuRef} className="as-menu as-searchmenu">
          <SearchMenuBox menu={menu} visible={visible} pick={pick} label={label} />
          <div ref={menu.listRef} id={menu.listId} role="listbox" aria-label={label}>
            {visible.map((o) => (
              <button
                key={o.value}
                id={menu.optionId(o.value)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={o === current}
                aria-disabled={o.disabled || undefined}
                title={o.title}
                data-active={o === active}
                className={`as-kindmenu__option${o === current ? " as-kindmenu__option--active" : ""}`}
                // Keep focus in the search box, so the keys go on working
                // after a row is hovered or pressed.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => (o.disabled ? undefined : menu.setActiveValue(o.value))}
                onClick={() => (o.disabled ? undefined : pick(o.value))}
              >
                {o.icon}
                {o.label}
              </button>
            ))}
            {!visible.length ? <div className="as-searchmenu__empty">No matches</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
