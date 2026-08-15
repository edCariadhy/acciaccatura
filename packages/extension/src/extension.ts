import { relative, sep, join } from "node:path";

import * as vscode from "vscode";
import { AnnotationStore } from "@acciaccatura/core";
import type { CapturedSelection } from "@acciaccatura/core";

import { captureAnnotation } from "./capture.js";

import { DecorationManager, initDecorations } from "./decorations.js";
import { AnnotationTreeProvider, AnnotationTreeItem } from "./treeView.js";

/**
 * Entry point for the VS Code extension.
 */
export function activate(context: vscode.ExtensionContext): void {
  initDecorations(context);
  const folders = vscode.workspace.workspaceFolders;
  const store = (folders && folders.length > 0)
    ? new AnnotationStore(join(folders[0]!.uri.fsPath, ".acciaccatura", "annotations.json")) 
    : undefined;

  let decorationManager: DecorationManager | undefined;
  let treeProvider: AnnotationTreeProvider | undefined;

  if (store) {
    store.load().then(() => {
      decorationManager = new DecorationManager(store);
      treeProvider = new AnnotationTreeProvider(store);
      
      vscode.window.registerTreeDataProvider("acciaccatura.annotations", treeProvider);
      
      // Initial decorations
      decorationManager.updateDecorations(vscode.window.activeTextEditor).then(changed => {
        if (changed) treeProvider?.refresh();
      });

      // Update on editor change
      context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async editor => {
          const changed = await decorationManager?.updateDecorations(editor);
          if (changed) treeProvider?.refresh();
        })
      );

      // Update on document change
      context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(async e => {
          if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
            const changed = await decorationManager?.updateDecorations(vscode.window.activeTextEditor);
            if (changed) treeProvider?.refresh();
          }
        })
      );
    }).catch(() => {});
  }

  const annotate = vscode.commands.registerCommand("acciaccatura.annotateSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    const folder = editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : undefined;
    if (!editor || !folder) {
      void vscode.window.showWarningMessage(
        "Acciaccatura: open a file inside a workspace folder to annotate it.",
      );
      return;
    }

    const currentStore = store || new AnnotationStore(join(folder.uri.fsPath, ".acciaccatura", "annotations.json"));
    await currentStore.load();

    await captureAnnotation({
      getSelection: () => selectionFrom(editor, folder),
      promptForBody: () =>
        Promise.resolve(
          vscode.window.showInputBox({
            title: "Acciaccatura",
            prompt: "What should the next reader know about this code that the code itself does not show? Say why.",
            ignoreFocusOut: true,
          }),
        ),
      store: currentStore,
      notify: (level, message) =>
        level === "info"
          ? void vscode.window.showInformationMessage(`Acciaccatura: ${message}`)
          : void vscode.window.showWarningMessage(`Acciaccatura: ${message}`),
    });
    
    treeProvider?.refresh();
    decorationManager?.updateDecorations(editor);
  });

  const refreshTree = vscode.commands.registerCommand("acciaccatura.refreshTree", () => {
    treeProvider?.refresh();
  });

  const deleteAnno = vscode.commands.registerCommand("acciaccatura.deleteAnnotation", async (item: AnnotationTreeItem) => {
    if (store && item && item.annotation) {
      await store.remove(item.annotation.id);
      treeProvider?.refresh();
      decorationManager?.updateDecorations(vscode.window.activeTextEditor);
    }
  });

  const reviewAnno = vscode.commands.registerCommand("acciaccatura.reviewAnnotation", async (item: AnnotationTreeItem) => {
    if (store && item && item.annotation) {
      // Promotion is an edit, not a rewrite: the note keeps its id and its
      // original createdAt, and stays attributed to the agent that wrote it.
      await store.update(item.annotation.id, { trust: "authoritative" });
      treeProvider?.refresh();
      decorationManager?.updateDecorations(vscode.window.activeTextEditor);
    }
  });

  context.subscriptions.push(annotate, refreshTree, deleteAnno, reviewAnno);
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
