/**
 * FieldPathPanel.tsx — the side panel for pinned fields.
 *
 * Two pins: the routes between them (hover lights one, click keeps it and
 * frames it), the tables on any route, and the wider corridor. Three or
 * more: what lies between every pair and what the pins reach, with the
 * canvas dimmed to one or the other. Presentational: the studio owns the
 * pins, the query and the computed view.
 */
import type { CSSProperties } from "react";
import { fieldKey, type Pin } from "../contract/fields";
import type { RouteView } from "./field-routes";
import { UiIcon } from "./ui-icons";

export interface FieldPathPanelProps {
  view: RouteView;
  pins: readonly Pin[];
  labelOf: (ref: Pin) => string;
  nodeLabel: (id: string) => string;
  undirected: boolean;
  onUndirectedChange: (undirected: boolean) => void;
  mode: "between" | "reachable";
  onModeChange: (mode: "between" | "reachable") => void;
  /** The route the pointer is over (lit alone), if any. */
  hoverRoute: number | null;
  onHoverRoute: (index: number | null) => void;
  /** The route the reader clicked (kept lit alone until another click). */
  stickyRoute: number | null;
  onPickRoute: (index: number) => void;
  /** The key under the pointer: every route through it lights, the rest don't. */
  hoverKey: string | null;
  onHoverKey: (fieldKey: string | null) => void;
  onPinKey: (ref: { nodeId: string; fieldId: string }) => void;
  onNavigate: (nodeId: string) => void;
  onClose: () => void;
}

/** More rows than this and the list says how many it left out. */
const LIST_CAP = 500;

export function FieldPathPanel({
  view,
  pins,
  labelOf,
  nodeLabel,
  undirected,
  onUndirectedChange,
  mode,
  onModeChange,
  hoverRoute,
  onHoverRoute,
  stickyRoute,
  onPickRoute,
  hoverKey,
  onHoverKey,
  onPinKey,
  onNavigate,
  onClose,
}: FieldPathPanelProps) {
  const pair = view.kind === "pair";
  const reachableOthers = [...view.reachable.entries()].filter(([id]) => !pins.some((p) => p.nodeId === id));

  return (
    <div className="as-panel as-panel--paths" role="region" aria-label="Paths between pinned fields">
      <div className="as-panel__head">
        <h2 className="as-panel__title">{pair ? "Paths between pins" : `Between ${pins.length} pins`}</h2>
        <button type="button" className="as-btn as-btn--icon" onClick={onClose} aria-label="Close paths panel">
          <UiIcon name="close" />
        </button>
      </div>

      <div className="as-paths__pins">
        {pins.map((pin) => (
          <span key={`${pin.nodeId}.${pin.fieldId}`} className="as-chip as-chip--on">
            {labelOf(pin)}
          </span>
        ))}
      </div>

      <div className="as-paths__controls">
        <label className="as-check">
          <input type="checkbox" checked={undirected} onChange={(event) => onUndirectedChange(event.target.checked)} />
          Ignore arrow direction
        </label>
        {!pair ? (
          <div className="as-seg" role="group" aria-label="Dim the canvas to">
            <span className="as-seg__caption">Dim to</span>
            <button type="button" className={`as-btn${mode === "between" ? " as-btn--on" : ""}`} aria-pressed={mode === "between"} onClick={() => onModeChange("between")}>
              Between
            </button>
            <button type="button" className={`as-btn${mode === "reachable" ? " as-btn--on" : ""}`} aria-pressed={mode === "reachable"} onClick={() => onModeChange("reachable")}>
              Reachable
            </button>
          </div>
        ) : null}
      </div>

      {view.truncated ? (
        <p className="as-paths__note" role="status">
          The search stopped at its limits — more routes or tables may exist. Fewer pins, or pins closer together, narrow it.
        </p>
      ) : null}
      {view.constrainedFallback.map((ref) => (
        <p key={`${ref.nodeId}.${ref.fieldId}`} className="as-paths__note">
          <strong>{labelOf(ref)}</strong> anchors no line on this document; searched from the table instead.
        </p>
      ))}
      {view.pinsIgnored ? (
        <p className="as-paths__note">Pairwise search looks at the first {pins.length} pins; {view.pinsIgnored} more are not compared.</p>
      ) : null}

      {pair ? (
        <section className="as-paths__section" aria-label="Routes">
          <h3 className="as-paths__caption">
            Routes <span className="as-paths__count">{view.routes.length}</span>
          </h3>
          {view.routes.length ? (
            <ol className="as-routes">
              {view.routes.map((route, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className={`as-routes__row${stickyRoute === i ? " as-routes__row--sticky" : ""}`}
                    aria-pressed={stickyRoute === i}
                    title="Click to keep this route lit and frame it"
                    onMouseEnter={() => onHoverRoute(i)}
                    onMouseLeave={() => onHoverRoute(null)}
                    onFocus={() => onHoverRoute(i)}
                    onBlur={() => onHoverRoute(null)}
                    onClick={() => onPickRoute(i)}
                  >
                    <span
                      className="as-legend__swatch"
                      style={{ "--as-legend-color": `var(--as-edge-${route.color})` } as CSSProperties}
                      aria-hidden="true"
                    />
                    <span className="as-routes__body">
                      <span className="as-routes__title">{route.title}</span>
                      <span className="as-routes__keys" title="The key carrying each hop">
                        {route.keys.map((key, k) => (
                          <span key={k} className="as-routes__key">
                            {k > 0 ? <span className="as-routes__sep" aria-hidden="true">▸</span> : null}
                            {key}
                          </span>
                        ))}
                      </span>
                    </span>
                    <span className="as-routes__hops">
                      {route.hops} hop{route.hops === 1 ? "" : "s"}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="as-paths__empty">No route between these fields within 10 hops{undirected ? "" : " in the arrows' direction"}.</p>
          )}
          {hoverRoute === null && stickyRoute === null && view.routes.length > 1 ? (
            <p className="as-paths__hint">All routes are lit; hover one to see it alone.</p>
          ) : null}
        </section>
      ) : null}

      {pair && view.keyUse?.keys.length ? (
        <section className="as-paths__section" aria-label="Keys most routes use">
          <h3 className="as-paths__caption">
            Keys most routes use <span className="as-paths__count">{view.keyUse.keys.length}</span>
          </h3>
          <ul className="as-paths__list">
            {view.keyUse.keys.slice(0, LIST_CAP).map((use) => {
              const key = fieldKey(use.ref);
              return (
                <li key={key}>
                  <button
                    type="button"
                    className={`as-paths__item as-paths__keyuse${hoverKey === key ? " as-paths__item--hover" : ""}`}
                    title="Hover to light every route through this key; click to pin it"
                    onMouseEnter={() => onHoverKey(key)}
                    onMouseLeave={() => onHoverKey(null)}
                    onFocus={() => onHoverKey(key)}
                    onBlur={() => onHoverKey(null)}
                    onClick={() => onPinKey(use.ref)}
                  >
                    <span className="as-paths__itemlabel">
                      {labelOf(use.ref)}
                    </span>
                    <span className="as-paths__share" aria-hidden="true">
                      <span className="as-paths__sharebar" style={{ width: `${Math.round(use.share * 100)}%` }} />
                    </span>
                    <span className="as-paths__itemdetail">
                      {use.routes} of {view.keyUse!.routes}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <NodeList
        caption={pair ? "Tables between" : "Between the pins"}
        ids={view.betweenNodes}
        nodeLabel={nodeLabel}
        onNavigate={onNavigate}
        empty="None — the pins touch directly, or nothing joins them."
      />
      {!pair ? (
        <NodeList
          caption="Reachable from the pins"
          ids={reachableOthers.map(([id]) => id)}
          detail={(id) => {
            const d = view.reachable.get(id);
            return d === undefined ? "" : `${d} hop${d === 1 ? "" : "s"}`;
          }}
          nodeLabel={nodeLabel}
          onNavigate={onNavigate}
          empty="Nothing beyond the pins themselves."
        />
      ) : null}
      {view.corridorExtra.length ? (
        <details className="as-paths__section">
          <summary className="as-paths__caption">
            Also within reach of both ends <span className="as-paths__count">{view.corridorExtra.length}</span>
          </summary>
          <p className="as-paths__hint">Close to both pins by shortest distance, but on no route the search enumerated.</p>
          <NodeList ids={view.corridorExtra} nodeLabel={nodeLabel} onNavigate={onNavigate} />
        </details>
      ) : null}
    </div>
  );
}

function NodeList({
  caption,
  ids,
  detail,
  nodeLabel,
  onNavigate,
  empty,
}: {
  caption?: string;
  ids: readonly string[];
  detail?: (id: string) => string;
  nodeLabel: (id: string) => string;
  onNavigate: (nodeId: string) => void;
  empty?: string;
}) {
  const shown = ids.slice(0, LIST_CAP);
  return (
    <section className="as-paths__section" aria-label={caption}>
      {caption ? (
        <h3 className="as-paths__caption">
          {caption} <span className="as-paths__count">{ids.length}</span>
        </h3>
      ) : null}
      {ids.length ? (
        <ul className="as-paths__list">
          {shown.map((id) => (
            <li key={id}>
              <button type="button" className="as-paths__item" onClick={() => onNavigate(id)} title={`Go to ${nodeLabel(id)}`}>
                <span className="as-paths__itemlabel">{nodeLabel(id)}</span>
                {detail ? <span className="as-paths__itemdetail">{detail(id)}</span> : null}
              </button>
            </li>
          ))}
          {ids.length > shown.length ? <li className="as-paths__more">… and {ids.length - shown.length} more</li> : null}
        </ul>
      ) : empty ? (
        <p className="as-paths__empty">{empty}</p>
      ) : null}
    </section>
  );
}
