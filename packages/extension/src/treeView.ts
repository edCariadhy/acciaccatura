import * as vscode from 'vscode';
import { AnnotationStore, Annotation, NoteLines, findNoteLines } from '@acciaccatura/core';

export class AnnotationTreeItem extends vscode.TreeItem {
  constructor(
    public readonly annotation: Annotation,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    /** Where the code sits now. The saved anchor only says where it started. */
    public readonly lines: NoteLines = { state: 'same', startLine: annotation.anchor.startLine, endLine: annotation.anchor.endLine }
  ) {
    super(annotation.body.split('\n')[0] || 'Annotation', collapsibleState);

    const finished = Boolean(annotation.resolvedAt);

    this.tooltip = annotation.body;
    this.contextValue = finished
      ? 'resolved'
      : annotation.trust === 'suggested'
        ? 'suggested'
        : 'authoritative';

    if (lines.state === 'gone') {
      this.description = 'code not found';
      this.tooltip = `${annotation.body}\n\nWe can't find the code this note was written for. It was on lines ${annotation.anchor.startLine}–${annotation.anchor.endLine}.`;
    } else {
      this.description =
        lines.state === 'moved'
          ? `L${lines.startLine}-L${lines.endLine} (moved)`
          : `L${lines.startLine}-L${lines.endLine}`;
    }

    if (finished) {
      // Say who finished it: an agent closing a human's note is worth seeing.
      this.description = `${this.description} · done`;
      this.tooltip = `${annotation.body}\n\nDone — marked by the ${annotation.resolvedBy ?? 'unknown'} writer.`;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      const uri = vscode.Uri.joinPath(folders[0]!.uri, annotation.anchor.file);
      this.resourceUri = uri;
      // Jump to where the code is now. Opening the saved lines would send the
      // reader to whatever code took that place.
      const target = lines.state === 'gone' ? undefined : lines;
      this.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [
          uri,
          target
            ? { selection: new vscode.Range(target.startLine - 1, 0, target.endLine - 1, 0) }
            : {}
        ]
      };
    }

    if (finished) {
      this.iconPath = new vscode.ThemeIcon('check');
    } else if (lines.state === 'gone') {
      this.iconPath = new vscode.ThemeIcon('warning');
    } else if (annotation.trust === 'suggested') {
      this.iconPath = new vscode.ThemeIcon('lightbulb');
    } else {
      this.iconPath = new vscode.ThemeIcon('comment');
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
        // Open notes first: finished ones are kept for review, not for reading.
        const fileAnnos = annotations
          .filter(a => a.anchor.file === element.file)
          .sort((a, b) => Number(Boolean(a.resolvedAt)) - Number(Boolean(b.resolvedAt)));
        // One read per expanded file, not per note. Reading through the editor
        // means unsaved edits count too.
        const fileText = await this.readFile(element.file);
        return fileAnnos.map(
          a => new AnnotationTreeItem(a, vscode.TreeItemCollapsibleState.None, findNoteLines(a.anchor, fileText)),
        );
      }
      return [];
    } else {
      // Group by file
      const files = [...new Set(annotations.map(a => a.anchor.file))];
      return files.map(f => new FileTreeItem(f, vscode.TreeItemCollapsibleState.Expanded));
    }
  }
}
