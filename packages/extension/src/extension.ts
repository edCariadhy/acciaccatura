import * as vscode from "vscode";

/**
 * Entry point for the VS Code extension (the human writer).
 *
 * `activationEvents` is empty on purpose: VS Code activates the extension only
 * when a contributed command first runs. The extension host is shared, so we do
 * NO work at startup — a large workspace must not pay an activation cost for a
 * feature the user has not invoked yet.
 */
export function activate(context: vscode.ExtensionContext): void {
  const annotate = vscode.commands.registerCommand("acciaccatura.annotateSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showWarningMessage(
        "Acciaccatura: select the code you want to annotate first.",
      );
      return;
    }

    // TODO(first-slice): capture selection range + exact snapshot text and write
    // to the SAME store the MCP server reads (@acciaccatura/mcp-server/store),
    // with provenance "human". Two writers, one store — the shared model already
    // carries provenance/trust so agent and human notes coexist. See CLAUDE.md.
    void vscode.window.showInformationMessage(
      "Acciaccatura: annotation capture is not implemented yet (scaffold).",
    );
  });

  context.subscriptions.push(annotate);
}

export function deactivate(): void {
  // Nothing to tear down yet.
}
