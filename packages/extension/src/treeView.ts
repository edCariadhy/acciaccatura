import * as vscode from 'vscode';
import { AnnotationStore, Annotation } from '@acciaccatura/core';

export class AnnotationTreeItem extends vscode.TreeItem {
  constructor(
    public readonly annotation: Annotation,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(annotation.body.split('\n')[0] || 'Annotation', collapsibleState);
    
    this.tooltip = annotation.body;
    this.description = `L${annotation.anchor.startLine}-L${annotation.anchor.endLine}`;
    this.contextValue = annotation.trust === 'suggested' ? 'suggested' : 'authoritative';
    
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      const uri = vscode.Uri.joinPath(folders[0]!.uri, annotation.anchor.file);
      this.resourceUri = uri;
      this.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [
          uri,
          {
            selection: new vscode.Range(
              annotation.anchor.startLine - 1,
              0,
              annotation.anchor.endLine - 1,
              0
            )
          }
        ]
      };
    }
    
    if (annotation.trust === 'suggested') {
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

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!vscode.workspace.workspaceFolders) {
      return [];
    }
    
    const annotations = this.store.all();
    
    if (element) {
      if (element instanceof FileTreeItem) {
        const fileAnnos = annotations.filter(a => a.anchor.file === element.file);
        return fileAnnos.map(a => new AnnotationTreeItem(a, vscode.TreeItemCollapsibleState.None));
      }
      return [];
    } else {
      // Group by file
      const files = [...new Set(annotations.map(a => a.anchor.file))];
      return files.map(f => new FileTreeItem(f, vscode.TreeItemCollapsibleState.Expanded));
    }
  }
}
