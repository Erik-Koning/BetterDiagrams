/**
 * KindSelect — the node-type picker, relevance-aware.
 *
 * A native <select> can't style its options, and the cloud packs need
 * structure a flat list can't give: core kinds first, then the clouds this
 * document actually references (a zone/node/edge names the provider), and at
 * the bottom a dimmed "Other clouds" section holding every cloud the
 * document doesn't touch — visually demoted, still fully selectable, so
 * discovering a pack never requires leaving the dropdown.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import type { ResolvedRegistry } from "./registry-types";

export interface KindSelectProps {
  registry: ResolvedRegistry;
  value: string;
  onChange: (kind: string) => void;
  /** Providers the document references — these clouds list un-demoted. */
  relevantProviders: ReadonlySet<string>;
  /**
   * Kinds this picker must not offer. Used where a kind would be a category
   * error rather than a bad choice — nesting a group cannot turn it into
   * another container, or the contents would stay inline.
   */
  omit?: (kind: string) => boolean;
}

interface CloudGroup {
  provider: string;
  label: string;
  color: string;
  kinds: string[];
}

export function KindSelect({ registry, value, onChange, relevantProviders, omit }: KindSelectProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const coreKinds: string[] = [];
  const byProvider = new Map<string, string[]>();
  for (const kind of registry.kindOrder) {
    if (omit?.(kind)) continue;
    const provider = registry.nodeKinds[kind]?.provider;
    if (!provider) {
      coreKinds.push(kind);
    } else {
      const list = byProvider.get(provider) ?? [];
      list.push(kind);
      byProvider.set(provider, list);
    }
  }
  const group = (provider: string): CloudGroup => ({
    provider,
    label: registry.providers[provider]?.label ?? provider,
    color: registry.providers[provider]?.color ?? "var(--as-text-dim)",
    kinds: byProvider.get(provider) ?? [],
  });
  const cloudProviders = [...byProvider.keys()];
  const relevant = cloudProviders.filter((p) => relevantProviders.has(p)).map(group);
  const demoted = cloudProviders.filter((p) => !relevantProviders.has(p)).map(group);

  const pick = (kind: string) => {
    onChange(kind);
    setOpen(false);
  };

  const option = (kind: string) => (
    <button
      key={kind}
      type="button"
      role="option"
      aria-selected={kind === value}
      className={`as-kindmenu__option${kind === value ? " as-kindmenu__option--active" : ""}`}
      onClick={() => pick(kind)}
    >
      {registry.nodeKinds[kind]?.label ?? kind}
    </button>
  );

  return (
    <div className="as-kindselect" ref={wrapRef}>
      <button
        type="button"
        className="as-select as-kindselect__button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Node kind"
        title="Node kind"
      >
        {registry.nodeKinds[value]?.label ?? value} ▾
      </button>
      {open ? (
        <div className="as-menu as-kindmenu" role="listbox" aria-label="Node kind">
          {coreKinds.map(option)}
          {relevant.map((cloud) => (
            <Fragment key={cloud.provider}>
              <div className="as-kindmenu__header">
                <span className="as-kindmenu__dot" style={{ background: cloud.color }} />
                {cloud.label}
              </div>
              {cloud.kinds.map(option)}
            </Fragment>
          ))}
          {demoted.length ? (
            <div className="as-kindmenu__dim">
              <div className="as-kindmenu__header">Other clouds</div>
              {demoted.map((cloud) => (
                <Fragment key={cloud.provider}>
                  <div className="as-kindmenu__header as-kindmenu__header--sub">
                    <span className="as-kindmenu__dot" style={{ background: cloud.color }} />
                    {cloud.label}
                  </div>
                  {cloud.kinds.map(option)}
                </Fragment>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
