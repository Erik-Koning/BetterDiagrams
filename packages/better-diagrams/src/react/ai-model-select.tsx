/**
 * ai-model-select.tsx — the AI panel's choice of model, shared by the
 * architecture and sequence editors. The host says which models there are and
 * keeps the choice; the editor shows it and sends it with each request.
 */
import type { AiModelOption } from "../contract/llm";

/**
 * The model a request goes to: the one chosen, else the first offered, so what
 * the picker shows is always what gets sent. Nothing when none are offered.
 */
export function pickedAiModel(models: AiModelOption[] | undefined, id: string | undefined): AiModelOption | undefined {
  return models?.find((model) => model.id === id) ?? models?.[0];
}

export function AiModelSelect({
  models,
  value,
  onChange,
  disabled = false,
}: {
  models: AiModelOption[] | undefined;
  value: string | undefined;
  onChange: ((id: string) => void) | undefined;
  disabled?: boolean;
}) {
  // With one model there is nothing to choose: the panel just names it.
  if (!models || models.length < 2) return null;
  const options = (list: AiModelOption[]) =>
    list.map((model) => (
      <option key={model.id} value={model.id}>
        {model.label}
      </option>
    ));
  const groups = [...new Set(models.map((model) => model.group ?? ""))];
  return (
    <label className="as-panel__model">
      <span className="as-panel__label">Model</span>
      <select
        className="as-select"
        value={pickedAiModel(models, value)?.id}
        // Not while a request is out: it went to the model chosen when it was sent.
        disabled={disabled || !onChange}
        onChange={(event) => onChange?.(event.target.value)}
      >
        {groups.length > 1
          ? groups.map((group) => (
              <optgroup key={group} label={group || "Other"}>
                {options(models.filter((model) => (model.group ?? "") === group))}
              </optgroup>
            ))
          : options(models)}
      </select>
    </label>
  );
}
