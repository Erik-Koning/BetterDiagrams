/**
 * ai.ts — the studio's AI panel (Generate, Adjust with AI), answered by one
 * of VS Code's own language models: whatever the person's chat uses, such as
 * Copilot's. No key lives in the extension; the first request asks the
 * person, in VS Code's own words, to let Better Diagrams use the model.
 */
import * as vscode from "vscode";
import { conversationOf, modelChoices, pickModel } from "./ai-request";

const preferredModel = () => vscode.workspace.getConfiguration("betterDiagrams").get<string>("aiModel", "");

/** The model requests go to, or nothing when VS Code has none to offer. */
export async function chatModel(preferred = preferredModel()): Promise<vscode.LanguageModelChat | undefined> {
  if (!vscode.lm?.selectChatModels) return undefined;
  return pickModel(await vscode.lm.selectChatModels(), preferred);
}

/** What the AI panel offers: the model's name, or null when there isn't one, and the others to choose from. */
export async function aiChoices(): Promise<ReturnType<typeof modelChoices>> {
  try {
    return modelChoices(vscode.lm?.selectChatModels ? await vscode.lm.selectChatModels() : [], preferredModel());
  } catch {
    return modelChoices([], "");
  }
}

/**
 * Answer one of the studio's requests: the model's raw text, which the
 * studio parses, repairs and merges as it does the web app's. Throws with a
 * message for the panel when there's no answer.
 */
export async function generate(request: unknown, token: vscode.CancellationToken): Promise<string> {
  const conversation = conversationOf(request);
  if (!conversation) throw new Error("The request had no prompt in it.");
  const model = await chatModel(conversation.model);
  if (!model) throw new Error("VS Code has no language model to ask. Sign in to GitHub Copilot, or install a model provider, then try again.");
  // There's no system role in VS Code's chat API: the schema goes first, as the person.
  const messages = [
    vscode.LanguageModelChatMessage.User(conversation.system),
    ...conversation.turns.map((turn) =>
      turn.role === "user" ? vscode.LanguageModelChatMessage.User(turn.content) : vscode.LanguageModelChatMessage.Assistant(turn.content),
    ),
  ];
  let text = "";
  try {
    const response = await model.sendRequest(
      messages,
      { justification: "Better Diagrams draws and edits the diagram you describe with it." },
      token,
    );
    for await (const part of response.text) text += part;
  } catch (error) {
    if (error instanceof vscode.LanguageModelError) {
      if (error.code === vscode.LanguageModelError.NoPermissions.name) {
        throw new Error(`Better Diagrams isn't allowed to use ${model.name}. Allow it when VS Code asks, then try again.`);
      }
      if (error.code === vscode.LanguageModelError.Blocked.name) throw new Error(`${model.name} refused the request: ${error.message}`);
    }
    throw error;
  }
  if (!text.trim()) throw new Error(`${model.name} returned no text to read a diagram from.`);
  return text;
}
