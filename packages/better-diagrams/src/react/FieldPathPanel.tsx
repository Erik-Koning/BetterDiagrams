/**
 * FieldPathPanel.tsx — the side panel for pinned fields.
 *
 * Two pins: the routes between them (hover lights one, click keeps it and
 * frames it), the tables on any route, and the wider corridor. Three or
 * more: what lies between every pair and what the pins reach, with the
 * canvas dimmed to one or the other. The pin chips under the title are
 * jumps, like every other label here. Presentational: the studio owns the
 * pins, the query and the computed view.
 */
import { useState, type CSSProperties } from "react";
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
  /**
   * The key under the pointer, and the one clicked: every route through it
   * lights, the rest don't — hover previews, click keeps, as with a route.
   */
  hoverKey: string | null;
  onHoverKey: (fieldKey: string | null) => void;
  stickyKey: string | null;
  onPickKey: (fieldKey: string) => void;
  onNavigate: (nodeId: string) => void;
  /** A pin chip: go to the row it names, or to the table for a table pin. */
  onJumpToPin: (pin: Pin) => void;
  onClose: () => void;
}

/** More rows than this and the list says how many it left out. */
const LIST_CAP = 500;
/** Routes shown before the list asks to be expanded. */
const ROUTE_CAP = 4;

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
  stickyKey,
  onPickKey,
  onNavigate,
  onJumpToPin,
  onClose,
}: FieldPathPanelProps) {
  // Which view the reader expanded the route list for: a new view (other
  // pins, the direction toggled) folds it back to the first few.
  const [expandedFor, setExpandedFor] = useState<RouteView | null>(null);
  const routesExpanded = expandedFor === view;
  const shownRoutes = routesExpanded ? view.routes : view.routes.slice(0, ROUTE_CAP);

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
        {/* The panel is a map of what lies between these two, and the pins
            themselves are the one pair of labels on it that did not take you
            anywhere — on a model big enough to need the search, the chip is
            often the only mention of a table you can still see. */}
        {pins.map((pin) => (
          <button
            key={`${pin.nodeId}.${pin.fieldId}`}
            type="button"
            className="as-chip as-chip--on"
            title={`Go to ${labelOf(pin)}`}
            onClick={() => onJumpToPin(pin)}
          >
            {labelOf(pin)}
          </button>
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
              {shownRoutes.map((route, i) => (
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
          {view.routes.length > ROUTE_CAP ? (
            <button
              type="button"
              className="as-btn as-paths__expand"
              aria-expanded={routesExpanded}
              onClick={() => setExpandedFor(routesExpanded ? null : view)}
            >
              {routesExpanded ? "Show fewer" : `Show all ${view.routes.length} routes`}
            </button>
          ) : null}
          {hoverRoute === null && stickyRoute === null && hoverKey === null && stickyKey === null && view.routes.length > 1 ? (
            <p className="as-paths__hint">All routes are lit; hover one to see it alone.</p>
          ) : null}
        </section>
      ) : null}

      {pair && view.directKeys.length ? (
        <section className="as-paths__section" aria-label="Keys joining the pins">
          <h3 className="as-paths__caption">
            Keys joining the pins <span className="as-paths__count">{view.directKeys.length}</span>
          </h3>
          <ul className="as-paths__list">
            {view.directKeys.slice(0, LIST_CAP).map((link) => {
              const key = fieldKey(link.from);
              const drawn = link.edgeId !== undefined;
              const text = `${nodeLabel(link.from.nodeId)}.${link.from.fieldId} → ${nodeLabel(link.to.nodeId)}${link.to.fieldId ? `.${link.to.fieldId}` : ""}`;
              return (
                <li key={`${key}\u0000${fieldKey(link.to)}`}>
                  <button
                    type="button"
                    className={`as-paths__item as-paths__keyuse${hoverKey === key ? " as-paths__item--hover" : ""}${stickyKey === key ? " as-paths__item--sticky" : ""}`}
                    aria-pressed={stickyKey === key}
                    title={drawn ? "Hover to light this key on the canvas; click to keep it lit" : "The document draws no line for this reference"}
                    disabled={!drawn}
                    onMouseEnter={() => onHoverKey(key)}
                    onMouseLeave={() => onHoverKey(null)}
                    onFocus={() => onHoverKey(key)}
                    onBlur={() => onHoverKey(null)}
                    onClick={() => onPickKey(key)}
                  >
                    <span className="as-paths__itemlabel">{text}</span>
                    {!drawn ? <span className="as-paths__itemdetail">not drawn</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* A ranking needs something to rank: with one route every key on it
          is trivially "1 of 1", and the route's own hop strip already names
          them in order. */}
      {pair && view.routes.length > 1 && view.keyUse?.keys.length ? (
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
                    className={`as-paths__item as-paths__keyuse${hoverKey === key ? " as-paths__item--hover" : ""}${stickyKey === key ? " as-paths__item--sticky" : ""}`}
                    aria-pressed={stickyKey === key}
                    title="Hover to light every route through this key; click to keep them lit"
                    onMouseEnter={() => onHoverKey(key)}
                    onMouseLeave={() => onHoverKey(null)}
                    onFocus={() => onHoverKey(key)}
                    onBlur={() => onHoverKey(null)}
                    onClick={() => onPickKey(key)}
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
