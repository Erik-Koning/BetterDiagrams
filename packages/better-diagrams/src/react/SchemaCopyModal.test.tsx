/**
 * @vitest-environment jsdom
 *
 * SchemaCopyModal behavior. The point of this dialog is that the copy carries
 * exactly what was ticked — so the assertions are mostly about the scope
 * handed to `buildPrompt`, not about pixels.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SchemaCopyModal, type SchemaCopyModalProps } from "./SchemaCopyModal";

const CLOUDS = [
  { id: "aws", label: "AWS", color: "#ff9900" },
  { id: "azure", label: "Azure", color: "#0078d4" },
];

const RESOURCES = [
  { id: "aws-s3", cloud: "aws", label: "S3", hint: "object storage bucket" },
  { id: "aws-lambda", cloud: "aws", label: "Lambda", hint: "serverless function" },
  { id: "azure-blob", cloud: "azure", label: "Blob Storage" },
  { id: "azure-sql", cloud: "azure", label: "Azure SQL" },
];

/**
 * MUST be called after `userEvent.setup()` — setup installs a clipboard stub
 * of its own, so stubbing first would just be overwritten by it.
 */
const stubClipboard = () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
};

function mount(overrides: Partial<SchemaCopyModalProps> = {}) {
  const buildPrompt = vi.fn(
    (scope: { clouds: string[]; components: string[] }, opts: { geometry: boolean }) =>
      `PROMPT[${scope.clouds.join("+")}|${scope.components.join(",")}|${opts.geometry ? "full" : "content"}]`,
  );
  const props: SchemaCopyModalProps = {
    clouds: CLOUDS,
    resources: RESOURCES,
    buildPrompt,
    onClose: vi.fn(),
    ...overrides,
  };
  render(<SchemaCopyModal {...props} />);
  return { ...props, buildPrompt: props.buildPrompt as typeof buildPrompt };
}

describe("SchemaCopyModal", () => {
  it("opens with nothing selected and says the schema stays neutral", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    mount();
    expect(screen.getByRole("dialog", { name: "Copy schema & system prompt" })).toBeInTheDocument();
    expect(screen.getByText(/provider-neutral/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AWS" })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "Copy schema" }));
    expect(writeText).toHaveBeenCalledWith("PROMPT[||full]");
  });

  it("seeds from the document's clouds, taking all of their resources", () => {
    mount({ initialClouds: ["azure"] });
    expect(screen.getByRole("button", { name: "Azure" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "AWS" })).toHaveAttribute("aria-pressed", "false");
    // Only the selected cloud's checklist is on screen, all of it ticked.
    expect(screen.getByLabelText(/Blob Storage/)).toBeChecked();
    expect(screen.getByLabelText(/Azure SQL/)).toBeChecked();
    expect(screen.queryByLabelText(/^S3/)).not.toBeInTheDocument();
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
  });

  it("copies exactly the ticked clouds and resources", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    mount();

    await user.click(screen.getByRole("button", { name: "AWS" }));
    await user.click(screen.getByLabelText(/Lambda/));
    await user.click(screen.getByRole("button", { name: "Copy schema" }));

    expect(writeText).toHaveBeenCalledWith("PROMPT[aws|aws-s3|full]");
    expect(screen.getByRole("button", { name: "Copied ✓" })).toBeInTheDocument();
  });

  it("unticking a cloud takes its resources back out", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    mount({ initialClouds: ["aws", "azure"] });
    await user.click(screen.getByRole("button", { name: "AWS" }));
    await user.click(screen.getByRole("button", { name: "Copy schema" }));
    expect(writeText).toHaveBeenCalledWith("PROMPT[azure|azure-blob,azure-sql|full]");
  });

  it("the per-cloud presets set the whole pack, the diagram's own, or none", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    mount({ initialClouds: ["aws"], usedResources: ["aws-lambda"] });

    await user.click(screen.getByRole("button", { name: "In this diagram" }));
    expect(screen.getByText("1 of 2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "None" }));
    await user.click(screen.getByRole("button", { name: "Copy schema" }));
    // The cloud stays ticked but contributes nothing — the prompt builder is
    // what decides an empty pack means no section.
    expect(writeText).toHaveBeenCalledWith("PROMPT[aws||full]");

    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
  });

  it("offers the elements-only form", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    mount({ initialClouds: ["azure"] });
    await user.click(screen.getByRole("button", { name: "Elements only" }));
    await user.click(screen.getByRole("button", { name: "Copy schema" }));
    expect(writeText).toHaveBeenCalledWith("PROMPT[azure|azure-blob,azure-sql|content]");
  });

  it("hides the form picker when the host has only one form", () => {
    mount({ forms: false });
    expect(screen.queryByRole("group", { name: "Schema form" })).not.toBeInTheDocument();
  });

  it("reports the copied text and scope to the host", async () => {
    const user = userEvent.setup();
    stubClipboard();
    const onCopied = vi.fn();
    mount({ initialClouds: ["aws"], onCopied });
    await user.click(screen.getByRole("button", { name: "Copy schema" }));
    expect(onCopied).toHaveBeenCalledWith(
      "PROMPT[aws|aws-s3,aws-lambda|full]",
      { clouds: ["aws"], components: ["aws-s3", "aws-lambda"] },
      "full",
    );
  });

  it("says so when the clipboard is blocked, instead of a false Copied ✓", async () => {
    const user = userEvent.setup();
    // Both paths refused: the async API rejects, and jsdom implements no
    // execCommand for the legacy fallback to reach.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    mount();
    await user.click(screen.getByRole("button", { name: "Copy schema" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Clipboard is blocked/);
    expect(screen.queryByRole("button", { name: "Copied ✓" })).not.toBeInTheDocument();
  });

  it("Done closes without copying", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    const props = mount();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(props.onClose).toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });
});
