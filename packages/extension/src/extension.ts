import { relative, sep, join } from "node:path";

import * as vscode from "vscode";
import { AnnotationStore } from "@acciaccatura/core";
import type { CapturedSelection } from "@acciaccatura/core";

import { captureAnnotation } from "./capture.js";
import { clearFinishedNotes, markNoteDone, reopenNote, showNoteAges } from "./lifecycle.js";
import type { LifecycleDeps } from "./lifecycle.js";

import { addNoteToScope, checkScope, closeScope } from "./scopes.js";

import { watchStore } from "./watch.js";
import type { ScopeDeps } from "./scopes.js";

import { DecorationManager, initDecorations } from "./decorations.js";
import { AnnotationTreeProvider, AnnotationTreeItem, ScopeTreeItem } from "./treeView.js";
import { resolveCaptureLines } from "./lineRange.js";

/**
 * Entry point for the VS Code extension.
 */
export function activate(context: vscode.ExtensionContext): void {
  initDecorations(context);
  const folders = vscode.workspace.workspaceFolders;
  // Held separately from `folders` so the watcher below can name it.
  const rootFolder = folders?.[0];
  const store = rootFolder
    ? new AnnotationStore(join(rootFolder.uri.fsPath, ".acciaccatura", "annotations.json"))
    : undefined;

  let decorationManager: DecorationManager | undefined;
  let treeProvider: AnnotationTreeProvider | undefined;

  if (store) {
    store.load().then(() => {
      decorationManager = new DecorationManager(store);
      treeProvider = new AnnotationTreeProvider(store);
      
      vscode.window.registerTreeDataProvider("acciaccatura.annotations", treeProvider);
      
      // Initial decorations. Drawing never writes to the store, so there is
      // nothing for the sidebar to pick up afterwards.
      void decorationManager.updateDecorations(vscode.window.activeTextEditor);

      // Update on editor change
      context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async editor => {
          // Another writer — an agent over MCP — may have added notes since the
          // last look. Switching files is rare enough to afford a re-read.
          await store.reload();
          await decorationManager?.updateDecorations(editor);
          treeProvider?.refresh();
        })
      );

      // Update on document change
      context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(async e => {
          if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
            await decorationManager?.updateDecorations(vscode.window.activeTextEditor);
          }
        })
      );

      // Watch the store, so a note an agent writes while you sit in one file
      // does not wait for you to switch files to appear. The glob covers
      // annotations.json, the set files under scopes/, and each loose note's
      // own file under notes/; the store's temp files end in .tmp and are not
      // matched, so a write is not seen twice.
      // Non-null because the store exists only when rootFolder does, which is
      // the condition this whole block runs under.
      const pattern = new vscode.RelativePattern(rootFolder!, ".acciaccatura/**/*.json");
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      context.subscriptions.push(watcher);
      context.subscriptions.push({
        dispose: watchStore({
          onChange: (handler) => {
            const subs = [
              watcher.onDidChange(handler),
              watcher.onDidCreate(handler),
              watcher.onDidDelete(handler),
            ];
            return () => subs.forEach((s) => s.dispose());
          },
          refresh: async () => {
            await store.reload();
            // A write changes what a set check would say, so cached counts go
            // with it — the same reason our own writes clear them.
            treeProvider?.clearReports();
            treeProvider?.refresh();
            await decorationManager?.updateDecorations(vscode.window.activeTextEditor);
          },
          // A store read mid-write is broken JSON and the next event fixes it,
          // so this is not worth a message bar. It goes where a developer can
          // find it instead of nowhere.
          onError: (error) => console.warn("Acciaccatura: could not re-read the store", error),
        }),
      });
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

  /** Everything the finish-a-note flows need, wired to the real editor. */
  const lifecycleDeps = (): LifecycleDeps | undefined =>
    store && {
      store,
      chooseNote: async (candidates) => {
        const picked = await vscode.window.showQuickPick(
          candidates.map((a) => ({
            label: a.body.split("\n")[0] ?? "Annotation",
            description: `${a.anchor.file}:${a.anchor.startLine}-${a.anchor.endLine}`,
            detail: `written by the ${a.provenance}`,
            annotation: a,
          })),
          { title: "Acciaccatura", placeHolder: "Which note?" },
        );
        return picked?.annotation;
      },
      confirmDelete: async (question) =>
        (await vscode.window.showWarningMessage(question, { modal: true }, "Delete")) === "Delete",
      notify: (level, message) =>
        level === "info"
          ? void vscode.window.showInformationMessage(`Acciaccatura: ${message}`)
          : void vscode.window.showWarningMessage(`Acciaccatura: ${message}`),
    };

  /**
   * Redraw after any change: the sidebar and the gutter both show finished
   * state. Cached set checks go too — a write changes what a check would say,
   * and counts that no longer match the store are worse than none. Switching
   * files only calls refresh(), so a check survives that.
   */
  const redraw = async (): Promise<void> => {
    treeProvider?.clearReports();
    treeProvider?.refresh();
    await decorationManager?.updateDecorations(vscode.window.activeTextEditor);
  };

  // The sidebar passes the note it was invoked on; from the command palette
  // there is no item, and the flow asks which note instead.
  const resolveAnno = vscode.commands.registerCommand("acciaccatura.resolveAnnotation", async (item?: AnnotationTreeItem) => {
    const deps = lifecycleDeps();
    if (!deps) return;
    await markNoteDone(deps, item?.annotation);
    await redraw();
  });

  const reopenAnno = vscode.commands.registerCommand("acciaccatura.reopenAnnotation", async (item?: AnnotationTreeItem) => {
    const deps = lifecycleDeps();
    if (!deps) return;
    await reopenNote(deps, item?.annotation);
    await redraw();
  });

  const clearFinished = vscode.commands.registerCommand("acciaccatura.clearFinishedAnnotations", async () => {
    const deps = lifecycleDeps();
    if (!deps) return;
    await clearFinishedNotes(deps);
    await redraw();
  });

  // Reporting only: it writes nothing, so there is nothing to redraw.
  const noteAges = vscode.commands.registerCommand("acciaccatura.showNoteAges", async () => {
    const deps = lifecycleDeps();
    if (!deps) return;
    await showNoteAges(deps);
  });

  /** Everything the set-level flows need, wired to the real editor. */
  const scopeDeps = (): ScopeDeps | undefined => {
    const root = folders?.[0]?.uri.fsPath;
    return store && root
      ? {
          store,
          workspaceRoot: root,
          chooseScope: async (scopes) => {
            const picked = await vscode.window.showQuickPick(
              scopes.map((s) => ({
                label: s.scope,
                description: `${s.notes} note${s.notes === 1 ? "" : "s"} · ${s.open} open`,
                detail: `Opened ${s.openedAt}`,
                scope: s.scope,
              })),
              { title: "Acciaccatura", placeHolder: "Which set?" },
            );
            return picked?.scope;
          },
          chooseNote: async (candidates) => {
            const picked = await vscode.window.showQuickPick(
              candidates.map((a) => ({
                label: a.body.split("\n")[0] ?? "Annotation",
                description: `${a.anchor.file}:${a.anchor.startLine}-${a.anchor.endLine}`,
                detail: a.scope ? `already in ${a.scope}` : "in no set",
                annotation: a,
              })),
              { title: "Acciaccatura", placeHolder: "Which note?" },
            );
            return picked?.annotation;
          },
          askScopeName: async (existing) => {
            // Offer the names already in use so a workspace does not end up
            // with pr/142 and pr-142 meaning the same thing.
            const NEW = "$(add) New set…";
            const choice =
              existing.length === 0
                ? NEW
                : (
                    await vscode.window.showQuickPick([...existing, NEW], {
                      title: "Acciaccatura",
                      placeHolder: "Which set should this note join?",
                    })
                  );
            if (!choice) return undefined;
            if (choice !== NEW) return choice;
            return vscode.window.showInputBox({
              title: "Acciaccatura",
              prompt: "Name the set, for example pr/142 or onboarding/billing.",
              ignoreFocusOut: true,
            });
          },
          confirmClose: async (scope, count) =>
            (await vscode.window.showInformationMessage(
              `Close ${scope}? This marks ${count} note${count === 1 ? "" : "s"} as done. You can reopen them one at a time.`,
              { modal: true },
              "Close set",
            )) === "Close set",
          notify: (level, message) =>
            level === "info"
              ? void vscode.window.showInformationMessage(`Acciaccatura: ${message}`)
              : void vscode.window.showWarningMessage(`Acciaccatura: ${message}`),
        }
      : undefined;
  };

  const closeSet = vscode.commands.registerCommand("acciaccatura.closeScope", async (item?: ScopeTreeItem) => {
    const deps = scopeDeps();
    if (!deps) return;
    await closeScope(deps, item?.scope);
    await redraw();
  });

  const checkSet = vscode.commands.registerCommand("acciaccatura.checkScope", async (item?: ScopeTreeItem) => {
    const deps = scopeDeps();
    if (!deps) return;
    const report = await checkScope(deps, item?.scope);
    // Keep the counts on the row until something changes, so the reader does
    // not have to hold them in their head.
    if (report) treeProvider?.setReport(report);
  });

  const addToSet = vscode.commands.registerCommand("acciaccatura.addNoteToScope", async (item?: AnnotationTreeItem) => {
    const deps = scopeDeps();
    if (!deps) return;
    await addNoteToScope(deps, item?.annotation);
    await redraw();
  });

  context.subscriptions.push(
    annotate, refreshTree, deleteAnno, reviewAnno, resolveAnno, reopenAnno, clearFinished,
    noteAges, closeSet, checkSet, addToSet,
  );
}

export function deactivate(): void {
  // Nothing to tear down.
}

/**
 * Map the editor's selection to a {@link CapturedSelection}: a
 * workspace-relative POSIX path, a 1-based inclusive line range, and the exact
 * text of those whole lines (matching how the server re-reads the region). An
 * empty selection (just a caret) falls back to the caret's own line, so "note
 * about this line" needs no select-then-invoke step. Line-range logic itself
 * lives in {@link resolveCaptureLines}, which is unit-tested without a
 * `vscode` host.
 */
function selectionFrom(
  editor: vscode.TextEditor,
  folder: vscode.WorkspaceFolder,
): CapturedSelection | undefined {
  const sel = editor.selection;
  const { startLine, endLineIdx } = resolveCaptureLines({
    startLine: sel.start.line,
    endLine: sel.end.line,
    endChar: sel.end.character,
  });

  const lastCol = editor.document.lineAt(endLineIdx).text.length;
  const fullLines = new vscode.Range(startLine, 0, endLineIdx, lastCol);

  const file = relative(folder.uri.fsPath, editor.document.uri.fsPath).split(sep).join("/");
  return {
    file,
    startLine: startLine + 1,
    endLine: endLineIdx + 1,
    snapshot: editor.document.getText(fullLines),
  };
}
