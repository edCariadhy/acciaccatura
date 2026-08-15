import { relative, sep, join } from "node:path";

import * as vscode from "vscode";
import { AnnotationStore } from "@acciaccatura/core";
import type { CapturedSelection } from "@acciaccatura/core";

import { captureAnnotation } from "./capture.js";

/**
 * Entry point for the VS Code extension (the human writer).
 *
 * `activationEvents` is empty on purpose: VS Code activates only when a
 * contributed command first runs. The extension host is shared, so we do NO
 * work at startup — a large workspace must not pay an activation cost for a
 * feature the user has not invoked yet.
 */
export function activate(context: vscode.ExtensionContext): void {
  const annotate = vscode.commands.registerCommand("acciaccatura.annotateSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    const folder = editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : undefined;
    if (!editor || !folder) {
      void vscode.window.showWarningMessage(
        "Acciaccatura: open a file inside a workspace folder to annotate it.",
      );
      return;
    }

    // One store per workspace folder — the same JSON file the MCP server reads.
    const store = new AnnotationStore(join(folder.uri.fsPath, ".acciaccatura", "annotations.json"));
    await store.load();

    await captureAnnotation({
      getSelection: () => selectionFrom(editor, folder),
      promptForBody: () =>
        Promise.resolve(
          vscode.window.showInputBox({
            title: "Acciaccatura",
            prompt: "Note to anchor here — state what is non-obvious, and why.",
            ignoreFocusOut: true,
          }),
        ),
      store,
      notify: (level, message) =>
        level === "info"
          ? void vscode.window.showInformationMessage(`Acciaccatura: ${message}`)
          : void vscode.window.showWarningMessage(`Acciaccatura: ${message}`),
    });
  });

  context.subscriptions.push(annotate);
}

export function deactivate(): void {
  // Nothing to tear down.
}

/**
 * Map the editor's selection to a {@link CapturedSelection}: a
 * workspace-relative POSIX path, a 1-based inclusive line range, and the exact
 * text of those whole lines (matching how the server re-reads the region).
 * Returns `undefined` when the selection is empty.
 */
function selectionFrom(
  editor: vscode.TextEditor,
  folder: vscode.WorkspaceFolder,
): CapturedSelection | undefined {
  const sel = editor.selection;
  if (sel.isEmpty) return undefined;

  // A selection ending at column 0 of a later line does not include that line.
  const endLineIdx =
    sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;

  const lastCol = editor.document.lineAt(endLineIdx).text.length;
  const fullLines = new vscode.Range(sel.start.line, 0, endLineIdx, lastCol);

  const file = relative(folder.uri.fsPath, editor.document.uri.fsPath).split(sep).join("/");
  return {
    file,
    startLine: sel.start.line + 1,
    endLine: endLineIdx + 1,
    snapshot: editor.document.getText(fullLines),
  };
}
