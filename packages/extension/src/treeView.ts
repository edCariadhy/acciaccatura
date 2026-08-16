import * as vscode from 'vscode';
import { AnnotationStore, Annotation, NoteLines, findNoteLines } from '@acciaccatura/core';

import { filesWithNotes, noteView, notesForFile } from './viewModel.js';

export class AnnotationTreeItem extends vscode.TreeItem {
  constructor(
    public readonly annotation: Annotation,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    /** Where the code sits now. The saved anchor only says where it started. */
    public readonly lines: NoteLines = { state: 'same', startLine: annotation.anchor.startLine, endLine: annotation.anchor.endLine }
  ) {
    // What to show is decided in viewModel.ts, which has no vscode import and
    // is unit-tested. This class only turns those answers into a TreeItem.
    const view = noteView(annotation, lines);
    super(view.label, collapsibleState);

    this.tooltip = view.tooltip;
    this.description = view.description;
    this.contextValue = view.contextValue;
    this.iconPath = new vscode.ThemeIcon(view.icon);

    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      const uri = vscode.Uri.joinPath(folders[0]!.uri, annotation.anchor.file);
      this.resourceUri = uri;
      this.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [
          uri,
          view.reveal
            ? { selection: new vscode.Range(view.reveal.startLine - 1, 0, view.reveal.endLine - 1, 0) }
            : {}
        ]
      };
    }
  }
}

export class FileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly file: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(file, collapsibleState);
    this.contextValue = 'file';
    this.iconPath = vscode.ThemeIcon.File;
  }
}

export class AnnotationTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private store: AnnotationStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  /** File text as the editor sees it, or undefined if it cannot be read. */
  private async readFile(relPath: string): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    try {
      const uri = vscode.Uri.joinPath(folders[0]!.uri, relPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      return doc.getText();
    } catch {
      return undefined;
    }
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!vscode.workspace.workspaceFolders) {
      return [];
    }

    const annotations = this.store.all();

    if (element) {
      if (element instanceof FileTreeItem) {
        const fileAnnos = notesForFile(annotations, element.file);
        // One read per expanded file, not per note. Reading through the editor
        // means unsaved edits count too.
        const fileText = await this.readFile(element.file);
        return fileAnnos.map(
          a => new AnnotationTreeItem(a, vscode.TreeItemCollapsibleState.None, findNoteLines(a.anchor, fileText)),
        );
      }
      return [];
    }

    return filesWithNotes(annotations).map(
      f => new FileTreeItem(f, vscode.TreeItemCollapsibleState.Expanded),
    );
  }
}
