/**
 * CloudScopePicker — "which cloud, and which of its services, should the
 * copied schema teach?"
 *
 * Both copy surfaces ask the same question: the welcome modal before a new
 * diagram exists, and the schema modal over one that already does. They share
 * this control so the answer means the same thing in both places, and so a
 * cloud can only enter a prompt because someone ticked it.
 *
 * Controlled on purpose. The scope is the copy button's input, so the owner of
 * the copy is the owner of the scope; this component only renders it and
 * reports edits. `scopeFor` builds the initial value from a document's
 * referenced clouds, which is the one derivation every caller wants.
 */
import type { CSSProperties } from "react";
import type { CloudOption, CloudResourceOption } from "./template-prompt";

/** The answer: which clouds, and which of their services. */
export interface CloudScope {
  clouds: string[];
  /**
   * Kind ids, always a subset of the selected clouds' resources. Selecting a
   * cloud selects all of its services — narrowing is a deliberate second act,
   * never a default that silently drops vocabulary.
   */
  components: string[];
}

export const EMPTY_SCOPE: CloudScope = { clouds: [], components: [] };

/** The scope for a set of clouds: every resource each of them ships. */
export function scopeFor(clouds: readonly string[], resources: readonly CloudResourceOption[]): CloudScope {
  return {
    clouds: [...clouds],
    components: resources.filter((r) => clouds.includes(r.cloud)).map((r) => r.id),
  };
}

/** Toggle one cloud, adding or removing its resources with it. */
export function toggleCloud(
  scope: CloudScope,
  cloud: string,
  resources: readonly CloudResourceOption[],
): CloudScope {
  if (scope.clouds.includes(cloud)) {
    return {
      clouds: scope.clouds.filter((c) => c !== cloud),
      components: scope.components.filter((id) => resources.find((r) => r.id === id)?.cloud !== cloud),
    };
  }
  const added = resources.filter((r) => r.cloud === cloud).map((r) => r.id);
  return {
    clouds: [...scope.clouds, cloud],
    components: [...scope.components, ...added.filter((id) => !scope.components.includes(id))],
  };
}

export interface CloudScopePickerProps {
  /** Cloud chips to offer, in registry order. */
  clouds: CloudOption[];
  /**
   * Every selectable service. Omitted (or empty), the picker is chips only —
   * the caller wants cloud granularity and nothing finer.
   */
  resources?: CloudResourceOption[];
  value: CloudScope;
  onChange: (next: CloudScope) => void;
  /**
   * The kinds the open document already uses, offered as a per-cloud preset.
   * Absent for a document that doesn't exist yet.
   */
  usedResources?: readonly string[];
  /** Label over the chip row. */
  label?: string;
}

export function CloudScopePicker({
  clouds,
  resources,
  value,
  onChange,
  usedResources,
  label = "Clouds",
}: CloudScopePickerProps) {
  const all = resources ?? [];
  const selected = new Set(value.components);

  const setComponents = (components: string[]) => onChange({ ...value, components });

  const toggleResource = (id: string) =>
    setComponents(
      selected.has(id) ? value.components.filter((c) => c !== id) : [...value.components, id],
    );

  const setCloudResources = (cloud: string, ids: readonly string[]) =>
    setComponents([
      ...value.components.filter((id) => all.find((r) => r.id === id)?.cloud !== cloud),
      ...ids,
    ]);

  return (
    <div className="as-scope">
      <div className="as-scope__clouds" role="group" aria-label="Cloud providers">
        <span className="as-scope__label">{label}</span>
        {clouds.map((cloud) => (
          <button
            key={cloud.id}
            type="button"
            className="as-cloud-chip"
            style={{ "--chip-color": cloud.color } as CSSProperties}
            aria-pressed={value.clouds.includes(cloud.id)}
            onClick={() => onChange(toggleCloud(value, cloud.id, all))}
            title={`Include ${cloud.label} components in the copied schema & prompt`}
          >
            <span className="as-cloud-chip__dot" aria-hidden="true" />
            {cloud.label}
          </button>
        ))}
      </div>

      {all.length
        ? clouds
            .filter((cloud) => value.clouds.includes(cloud.id))
            .map((cloud) => {
              const rows = all.filter((r) => r.cloud === cloud.id);
              if (!rows.length) return null;
              const on = rows.filter((r) => selected.has(r.id)).length;
              const used = rows.filter((r) => usedResources?.includes(r.id)).map((r) => r.id);
              return (
                <fieldset key={cloud.id} className="as-scope__group">
                  <legend className="as-scope__legend">
                    <span className="as-scope__legend-name">{cloud.label} resources</span>
                    <span className="as-scope__count">
                      {on} of {rows.length}
                    </span>
                    <span className="as-scope__presets">
                      <button
                        type="button"
                        className="as-scope__preset"
                        onClick={() => setCloudResources(cloud.id, rows.map((r) => r.id))}
                      >
                        All
                      </button>
                      {used.length ? (
                        <button
                          type="button"
                          className="as-scope__preset"
                          onClick={() => setCloudResources(cloud.id, used)}
                          title="Only the services this diagram already uses"
                        >
                          In this diagram
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="as-scope__preset"
                        onClick={() => setCloudResources(cloud.id, [])}
                      >
                        None
                      </button>
                    </span>
                  </legend>
                  <div className="as-scope__rows">
                    {rows.map((row) => (
                      <label key={row.id} className="as-scope__row">
                        <input
                          type="checkbox"
                          checked={selected.has(row.id)}
                          onChange={() => toggleResource(row.id)}
                        />
                        <span className="as-scope__row-label">{row.label}</span>
                        {row.hint ? <span className="as-scope__row-hint">{row.hint}</span> : null}
                      </label>
                    ))}
                  </div>
                </fieldset>
              );
            })
        : null}
    </div>
  );
}
