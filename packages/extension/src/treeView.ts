import * as vscode from 'vscode';
import { AnnotationStore, Annotation, NoteLines, findNoteLines } from '@acciaccatura/core';
import type { ScopeIndexEntry, ScopeReport } from '@acciaccatura/core';

import { filesWithNotes, noteView, notesForFile, notesInScope, scopeView } from './viewModel.js';

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

export class ScopeTreeItem extends vscode.TreeItem {
  constructor(
    public readonly scope: string,
    entry: ScopeIndexEntry,
    report: ScopeReport | undefined,
    collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    const view = scopeView(entry, report);
    super(view.label, collapsibleState);
    this.description = view.description;
    this.tooltip = view.tooltip;
    this.contextValue = view.contextValue;
    this.iconPath = new vscode.ThemeIcon(view.icon);
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

  /**
   * What the last "Check Set" found, per set. Empty until someone asks:
   * checking reads code, and the tree redraws far too often to do that on its
   * own. A set with no entry here reads as "not checked", never as "fine".
   */
  private reports = new Map<string, ScopeReport>();

  constructor(private store: AnnotationStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /** Remember a check so the set can show its counts until something changes. */
  setReport(report: ScopeReport): void {
    this.reports.set(report.scope, report);
    this.refresh();
  }

  /**
   * Forget every check. Called after a write, because finishing, moving or
   * deleting a note changes what a check would say, and a count that no longer
   * matches the store is worse than no count at all.
   */
  clearReports(): void {
    this.reports.clear();
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

    if (element instanceof FileTreeItem) {
      const fileAnnos = notesForFile(annotations, element.file);
      // One read per expanded file, not per note. Reading through the editor
      // means unsaved edits count too.
      const fileText = await this.readFile(element.file);
      return fileAnnos.map(
        a => new AnnotationTreeItem(a, vscode.TreeItemCollapsibleState.None, findNoteLines(a.anchor, fileText)),
      );
    }

    if (element instanceof ScopeTreeItem) {
      // A set spans files, so read each one it touches, once.
      const inSet = notesInScope(annotations, element.scope);
      const texts = new Map<string, string | undefined>();
      for (const a of inSet) {
        if (!texts.has(a.anchor.file)) texts.set(a.anchor.file, await this.readFile(a.anchor.file));
      }
      return inSet.map(
        a => new AnnotationTreeItem(
          a,
          vscode.TreeItemCollapsibleState.None,
          findNoteLines(a.anchor, texts.get(a.anchor.file)),
        ),
      );
    }

    if (element) return [];

    // Sets first: they are what someone hands over, reviews, and ends. Files
    // stay below, because a note still belongs to a file whether or not it is
    // in a set.
    const scopes = this.store.scopes().map(
      entry => new ScopeTreeItem(
        entry.scope,
        entry,
        this.reports.get(entry.scope),
        vscode.TreeItemCollapsibleState.Collapsed,
      ),
    );
    const files = filesWithNotes(annotations).map(
      f => new FileTreeItem(f, vscode.TreeItemCollapsibleState.Expanded),
    );
    return [...scopes, ...files];
  }
}
