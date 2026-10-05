/**
 * SqlBlock.tsx — a route as SQL, under the route it came from.
 *
 * Dialect, join style and select list are the reader's; the SQL and its
 * warnings are `routeSql`'s (contract/route-sql.ts) — the same text the
 * HTML export's paths panel shows. The choices live for as long as the
 * paths panel is open.
 */
import { useState } from "react";
import { SQL_DIALECTS, type RouteSql, type RouteSqlOptions, type SqlDialect } from "../contract/route-sql";

export interface SqlBlockProps {
  sql: (opts: RouteSqlOptions) => RouteSql;
  onCopy: (text: string) => void;
}

export function SqlBlock({ sql, onCopy }: SqlBlockProps) {
  const [dialect, setDialect] = useState<SqlDialect>("ansi");
  const [join, setJoin] = useState<NonNullable<RouteSqlOptions["join"]>>("auto");
  const [select, setSelect] = useState<NonNullable<RouteSqlOptions["select"]>>("star");
  const out = sql({ dialect, join, select });
  return (
    <div className="as-sql" role="group" aria-label="SQL for this route">
      <div className="as-sql__controls">
        <select className="as-input as-sql__select" aria-label="SQL dialect" value={dialect} onChange={(e) => setDialect(e.target.value as SqlDialect)}>
          {SQL_DIALECTS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <select className="as-input as-sql__select" aria-label="Join style" value={join} onChange={(e) => setJoin(e.target.value as typeof join)}>
          <option value="auto">Joins: auto</option>
          <option value="inner">Joins: inner</option>
          <option value="left">Joins: left</option>
        </select>
        <select className="as-input as-sql__select" aria-label="Select list" value={select} onChange={(e) => setSelect(e.target.value as typeof select)}>
          <option value="star">SELECT *</option>
          <option value="keys">Keys</option>
        </select>
        <button type="button" className="as-btn" onClick={() => onCopy(out.sql)}>
          Copy
        </button>
      </div>
      <pre className="as-sql__code">{out.sql}</pre>
      {out.warnings.length ? (
        <ul className="as-sql__warnings">
          {out.warnings.map((w, i) => (
            <li key={i} className={`as-sql__warning as-sql__warning--${w.kind}`}>
              {w.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
