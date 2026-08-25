/**
 * @vitest-environment jsdom
 *
 * WelcomeModal behavior tests. The CodeMirror editor is stubbed with a
 * textarea — typing into a real EditorView is unreliable in jsdom, and the
 * editor's own mounting is covered by JsonCodeEditor.test.tsx. What matters
 * here is the modal's contract: CTAs, the name field, and the parse → insert
 * / error flow.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WelcomeModal, type WelcomeModalProps } from "./WelcomeModal";

vi.mock("./JsonCodeEditor", () => ({
  JsonCodeEditor: ({
    value,
    onChange,
    placeholder,
    ariaLabel,
  }: {
    value: string;
    onChange: (text: string) => void;
    placeholder?: string;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel ?? "Diagram JSON"}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

function mountModal(overrides: Partial<WelcomeModalProps> = {}) {
  const props: WelcomeModalProps = {
    kind: "architecture",
    defaultName: "Untitled 1",
    showNameField: true,
    systemPrompt: "THE PROMPT",
    parse: (text: string) => JSON.parse(text),
    onInsert: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
  render(<WelcomeModal {...props} />);
  return props;
}

describe("WelcomeModal", () => {
  it("renders the brand, both CTAs, and the prefilled name field", () => {
    mountModal();
    expect(screen.getByRole("dialog", { name: "Get started" })).toBeInTheDocument();
    expect(screen.getByText("BetterDiagrams")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Insert Node Manually/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Copy Schema & System Prompt/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("File name")).toHaveValue("Untitled 1");
  });

  it("hides the name field when the host can't use it", () => {
    mountModal({ showNameField: false });
    expect(screen.queryByLabelText("File name")).not.toBeInTheDocument();
  });

  it("shows the kind-appropriate placeholder", () => {
    mountModal({ kind: "sequence" });
    expect(screen.getByLabelText("Diagram JSON")).toHaveAttribute(
      "placeholder",
      expect.stringContaining('"participants"'),
    );
  });

  it("dismisses with the typed name from the manual CTA", async () => {
    const user = userEvent.setup();
    const props = mountModal();
    const name = screen.getByLabelText("File name");
    await user.clear(name);
    await user.type(name, "Payments");
    await user.click(screen.getByRole("button", { name: /Insert Node Manually/ }));
    expect(props.onDismiss).toHaveBeenCalledWith("Payments");
  });

  it("copies the system prompt", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    mountModal();
    await user.click(screen.getByRole("button", { name: /Copy Schema & System Prompt/ }));
    expect(writeText).toHaveBeenCalledWith("THE PROMPT");
    expect(await screen.findByText(/Copied/)).toBeInTheDocument();
  });

  it("reveals Insert only once there is text", async () => {
    const user = userEvent.setup();
    mountModal();
    expect(screen.queryByRole("button", { name: "Insert" })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Diagram JSON"), "x");
    expect(screen.getByRole("button", { name: "Insert" })).toBeInTheDocument();
  });

  it("surfaces parse errors as an alert and does not insert", async () => {
    const user = userEvent.setup();
    const props = mountModal({
      parse: () => {
        throw new Error("bad template");
      },
    });
    await user.type(screen.getByLabelText("Diagram JSON"), "not json");
    await user.click(screen.getByRole("button", { name: "Insert" }));
    expect(screen.getByRole("alert")).toHaveTextContent("bad template");
    expect(props.onInsert).not.toHaveBeenCalled();
  });

  it("offers 'Approximate a fix' for damaged JSON and heals on click", async () => {
    const user = userEvent.setup();
    const props = mountModal();
    const editor = screen.getByLabelText("Diagram JSON");
    await user.click(editor);
    // The real-world mangle: a copy dropped text, fusing icon into description.
    await user.paste('{"kind":"client","icon":y React 18+ app","x":40}');
    await user.click(screen.getByRole("button", { name: "Insert" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Approximate a fix \(1 guess\)/ }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect((editor as HTMLTextAreaElement).value).toContain('"icon": "y React 18+ app"');

    await user.click(screen.getByRole("button", { name: "Insert" }));
    expect(props.onInsert).toHaveBeenCalledWith(
      { kind: "client", icon: "y React 18+ app", x: 40 },
      "Untitled 1",
    );
  });

  it("keeps the rescue button away from text that is not JSON-shaped", async () => {
    const user = userEvent.setup();
    mountModal({
      parse: () => {
        throw new Error("bad template");
      },
    });
    await user.type(screen.getByLabelText("Diagram JSON"), "not json");
    await user.click(screen.getByRole("button", { name: "Insert" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approximate a fix/ })).not.toBeInTheDocument();
  });

  it("hints when an architecture paste looks like a sequence document", async () => {
    const user = userEvent.setup();
    mountModal({
      parse: () => {
        throw new Error("missing nodes");
      },
    });
    const editor = screen.getByLabelText("Diagram JSON");
    // paste — typing JSON through user.type trips on the {} keystroke syntax
    await user.click(editor);
    await user.paste('{"version": 1, "participants": []}');
    await user.click(screen.getByRole("button", { name: "Insert" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/looks like a sequence document/);
  });

  it("inserts the parsed document with the typed name", async () => {
    const user = userEvent.setup();
    const props = mountModal();
    const name = screen.getByLabelText("File name");
    await user.clear(name);
    await user.type(name, "From LLM");
    const editor = screen.getByLabelText("Diagram JSON");
    await user.click(editor);
    await user.paste('{"version": 1, "nodes": [], "edges": []}');
    await user.click(screen.getByRole("button", { name: "Insert" }));
    expect(props.onInsert).toHaveBeenCalledWith(
      { version: 1, nodes: [], edges: [] },
      "From LLM",
    );
  });

  it("prefills the editor from initialText, with Insert available immediately", async () => {
    const user = userEvent.setup();
    const props = mountModal({ initialText: '{"version": 1, "nodes": [], "edges": []}' });
    expect(screen.getByLabelText("Diagram JSON")).toHaveValue(
      '{"version": 1, "nodes": [], "edges": []}',
    );
    await user.click(screen.getByRole("button", { name: "Insert" }));
    expect(props.onInsert).toHaveBeenCalledWith(
      { version: 1, nodes: [], edges: [] },
      "Untitled 1",
    );
  });

  it("falls back to the default name when the field is cleared", async () => {
    const user = userEvent.setup();
    const props = mountModal();
    await user.clear(screen.getByLabelText("File name"));
    await user.click(screen.getByRole("button", { name: /Insert Node Manually/ }));
    expect(props.onDismiss).toHaveBeenCalledWith("Untitled 1");
  });
});

describe("WelcomeModal cloud toggle", () => {
  const CLOUDS = [
    { id: "aws", label: "AWS", color: "#ff9900" },
    { id: "azure", label: "Azure", color: "#0078d4" },
    { id: "gcp", label: "GCP", color: "#4285f4" },
  ];

  it("renders the toggle row only when cloud providers are passed", () => {
    mountModal();
    expect(screen.queryByRole("group", { name: "Cloud providers" })).not.toBeInTheDocument();
  });

  it("multi-selects and deselects chips via aria-pressed", async () => {
    const user = userEvent.setup();
    mountModal({ cloudProviders: CLOUDS });
    const aws = screen.getByRole("button", { name: "AWS" });
    const gcp = screen.getByRole("button", { name: "GCP" });
    expect(aws).toHaveAttribute("aria-pressed", "false");

    await user.click(aws);
    await user.click(gcp);
    expect(aws).toHaveAttribute("aria-pressed", "true");
    expect(gcp).toHaveAttribute("aria-pressed", "true");

    await user.click(aws);
    expect(aws).toHaveAttribute("aria-pressed", "false");
  });

  it("copies the prompt built for the selected clouds", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const promptForClouds = vi.fn((clouds: string[]) => `PROMPT[${clouds.join("+")}]`);
    mountModal({ cloudProviders: CLOUDS, promptForClouds });

    await user.click(screen.getByRole("button", { name: "AWS" }));
    await user.click(screen.getByRole("button", { name: "GCP" }));
    await user.click(screen.getByRole("button", { name: /Copy Schema & System Prompt/ }));
    expect(promptForClouds).toHaveBeenCalledWith(["aws", "gcp"]);
    expect(writeText).toHaveBeenCalledWith("PROMPT[aws+gcp]");
  });

  it("narrows the copy to the ticked resources when the host offers them", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const promptForClouds = vi.fn(
      (clouds: string[], opts?: { components?: readonly string[] }) =>
        `PROMPT[${clouds.join("+")}|${(opts?.components ?? []).join(",")}]`,
    );
    mountModal({
      cloudProviders: CLOUDS,
      promptForClouds,
      cloudResources: [
        { id: "aws-s3", cloud: "aws", label: "S3" },
        { id: "aws-lambda", cloud: "aws", label: "Lambda" },
      ],
    });

    // Ticking a cloud takes all of its services…
    await user.click(screen.getByRole("button", { name: "AWS" }));
    expect(screen.getByLabelText(/Lambda/)).toBeChecked();
    // …and unticking one narrows the copy without dropping the cloud.
    await user.click(screen.getByLabelText(/Lambda/));
    await user.click(screen.getByRole("button", { name: /Copy Schema & System Prompt/ }));
    expect(promptForClouds).toHaveBeenCalledWith(["aws"], { components: ["aws-s3"] });
    expect(writeText).toHaveBeenCalledWith("PROMPT[aws|aws-s3]");
  });

  it("copies the base prompt when nothing is selected", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const promptForClouds = vi.fn(() => "BASE");
    mountModal({ cloudProviders: CLOUDS, promptForClouds });
    await user.click(screen.getByRole("button", { name: /Copy Schema & System Prompt/ }));
    expect(promptForClouds).toHaveBeenCalledWith([]);
    expect(writeText).toHaveBeenCalledWith("BASE");
  });
});

describe("type picker", () => {
  const seqJson = '{"version":1,"participants":[{"id":"u","label":"U"}],"messages":[]}';
  const rfExport = '{"nodes":[{"id":"a","position":{"x":0,"y":0},"data":{}}],"edges":[]}';

  const stubClipboard = () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    return writeText;
  };

  it("initial pick follows the studio; the other option is disabled without host support", () => {
    mountModal();
    expect(screen.getByRole("button", { name: "Architecture" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const seq = screen.getByRole("button", { name: "Sequence" });
    expect(seq).toBeDisabled();
    expect(seq).toHaveAttribute("title", expect.stringContaining("can't create sequence files"));
  });

  it("auto-flips to the pasted kind; placeholder and cloud chips follow", async () => {
    const user = userEvent.setup();
    mountModal({
      parseOther: (text: string) => JSON.parse(text),
      onInsertOther: vi.fn(),
      cloudProviders: [{ id: "aws", label: "AWS", color: "#f90" }],
    });
    expect(screen.getByRole("group", { name: "Cloud providers" })).toBeInTheDocument();

    const editor = screen.getByLabelText("Diagram JSON");
    await user.click(editor);
    await user.paste(seqJson);

    expect(screen.getByRole("button", { name: "Sequence" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(editor).toHaveAttribute("placeholder", expect.stringContaining('"participants"'));
    // The clouds row is architecture-only.
    expect(screen.queryByRole("group", { name: "Cloud providers" })).not.toBeInTheDocument();
  });

  it("a manual pick wins over auto-detect", async () => {
    const user = userEvent.setup();
    mountModal({ parseOther: (text: string) => JSON.parse(text), onInsertOther: vi.fn() });
    await user.click(screen.getByRole("button", { name: "Architecture" }));
    const editor = screen.getByLabelText("Diagram JSON");
    await user.click(editor);
    await user.paste(seqJson);
    expect(screen.getByRole("button", { name: "Architecture" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("an RF export flips a sequence modal to architecture", async () => {
    const user = userEvent.setup();
    mountModal({
      kind: "sequence",
      parseOther: (text: string) => JSON.parse(text),
      onInsertOther: vi.fn(),
    });
    const editor = screen.getByLabelText("Diagram JSON");
    await user.click(editor);
    await user.paste(rfExport);
    expect(screen.getByRole("button", { name: "Architecture" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("cross-kind Insert routes to onInsertOther, not onInsert", async () => {
    const user = userEvent.setup();
    const onInsertOther = vi.fn();
    const props = mountModal({
      parseOther: (text: string) => JSON.parse(text),
      onInsertOther,
    });
    const editor = screen.getByLabelText("Diagram JSON");
    await user.click(editor);
    await user.paste(seqJson);
    await user.click(screen.getByRole("button", { name: "Insert" }));
    expect(onInsertOther).toHaveBeenCalledWith(JSON.parse(seqJson), "Untitled 1");
    expect(props.onInsert).not.toHaveBeenCalled();
  });

  it("copy follows the picked kind", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    mountModal({
      parseOther: (text: string) => JSON.parse(text),
      onInsertOther: vi.fn(),
      systemPromptOther: "SEQ PROMPT",
    });
    const editor = screen.getByLabelText("Diagram JSON");
    await user.click(editor);
    await user.paste(seqJson);
    await user.click(screen.getByRole("button", { name: /Copy Schema & System Prompt/ }));
    expect(writeText).toHaveBeenCalledWith("SEQ PROMPT");
  });

  it("offers no schema-form menu when the host supplies no content prompt", () => {
    mountModal();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("the menu's Elements only copies the content form; the button keeps the full form", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    mountModal({ systemPromptContent: "CONTENT PROMPT" });
    await user.click(screen.getByRole("menuitem", { name: /Elements only/ }));
    expect(writeText).toHaveBeenLastCalledWith("CONTENT PROMPT");
    await user.click(screen.getByRole("button", { name: /Copy Schema & System Prompt/ }));
    expect(writeText).toHaveBeenLastCalledWith("THE PROMPT");
    // "Copied ✓" holds the clicked item's label for 1.5s; wait it out.
    await user.click(await screen.findByRole("menuitem", { name: /Full schema/ }, { timeout: 2500 }));
    expect(writeText).toHaveBeenLastCalledWith("THE PROMPT");
  });

  it("cloud tailoring reaches the content form through the geometry option", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    const promptForClouds = vi.fn(
      (clouds: string[], opts?: { geometry?: boolean }) =>
        `P(${clouds.join("+")},${opts?.geometry === false ? "content" : "full"})`,
    );
    mountModal({
      cloudProviders: [{ id: "aws", label: "AWS", color: "#f90" }],
      promptForClouds,
      initialClouds: ["aws"],
      systemPromptContent: "CONTENT PROMPT",
    });
    await user.click(screen.getByRole("menuitem", { name: /Elements only/ }));
    expect(writeText).toHaveBeenLastCalledWith("P(aws,content)");
    await user.click(screen.getByRole("menuitem", { name: /Full schema/ }));
    expect(writeText).toHaveBeenLastCalledWith("P(aws,full)");
  });

  it("the schema-form menu follows the picked kind", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    mountModal({
      parseOther: (text: string) => JSON.parse(text),
      onInsertOther: vi.fn(),
      systemPromptOther: "SEQ PROMPT",
      systemPromptOtherContent: "SEQ CONTENT PROMPT",
    });
    // Architecture is picked and has no content prompt — no menu.
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sequence" }));
    await user.click(screen.getByRole("menuitem", { name: /Elements only/ }));
    expect(writeText).toHaveBeenLastCalledWith("SEQ CONTENT PROMPT");
  });

  it("initialClouds pre-toggles the chips and seeds the immediate copy", async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    const promptForClouds = vi.fn().mockReturnValue("AWS-TAILORED");
    mountModal({
      cloudProviders: [{ id: "aws", label: "AWS", color: "#f90" }],
      promptForClouds,
      initialClouds: ["aws"],
    });
    expect(screen.getByRole("button", { name: /AWS/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: /Copy Schema & System Prompt/ }));
    expect(promptForClouds).toHaveBeenCalledWith(["aws"]);
    expect(writeText).toHaveBeenCalledWith("AWS-TAILORED");
  });

  it("lockKind pins both options through a cross-kind paste, and the hint survives", async () => {
    const user = userEvent.setup();
    mountModal({
      lockKind: true,
      parse: () => {
        throw new Error("missing nodes");
      },
      parseOther: (text: string) => JSON.parse(text),
      onInsertOther: vi.fn(),
    });
    expect(screen.getByRole("button", { name: "Architecture" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sequence" })).toBeDisabled();

    const editor = screen.getByLabelText("Diagram JSON");
    await user.click(editor);
    await user.paste(seqJson);
    // Pinned: no flip.
    expect(screen.getByRole("button", { name: "Architecture" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Insert" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/looks like a sequence document/);
  });
});
