import * as vscode from 'vscode';
import { AnnotationStore, driftStatus, reanchor, readRegion } from '@acciaccatura/core';

let annotationDecorationType: vscode.TextEditorDecorationType;
let spanDecorationType: vscode.TextEditorDecorationType;
let lostAnnotationDecorationType: vscode.TextEditorDecorationType;

export function initDecorations(context: vscode.ExtensionContext) {
  // The icon marks WHERE the note is attached, so it goes on the first line
  // only: VS Code repeats a gutter icon on every line of a range, and a 30-line
  // annotation rendered as 30 identical bubbles reads as 30 separate notes.
  annotationDecorationType = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'annotation.svg'),
    gutterIconSize: 'contain',
  });

  // The spine shows HOW FAR the note reaches — one continuous rule down the
  // span. It carries the hover, so hovering anywhere in the range works.
  spanDecorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(92, 152, 255, 0.1)',
    borderColor: 'rgba(92, 152, 255, 0.7)',
    borderStyle: 'solid',
    borderWidth: '0 0 0 2px',
  });

  lostAnnotationDecorationType = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'lost.svg'),
    gutterIconSize: 'contain',
    isWholeLine: true,
    backgroundColor: 'rgba(255, 92, 92, 0.1)',
  });
}

export class DecorationManager {
  constructor(private store: AnnotationStore) {}

  async updateDecorations(editor: vscode.TextEditor | undefined) {
    if (!editor) {
      return;
    }
    
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;
    const workspaceRoot = folders[0]!.uri.fsPath;
    
    // Relative path to workspace root
    const relPath = vscode.workspace.asRelativePath(editor.document.uri, false);
    
    const annotations = this.store.all();
    const fileAnnotations = annotations.filter(a => a.anchor.file === relPath);
    
    const iconDecorations: vscode.DecorationOptions[] = [];
    const spanDecorations: vscode.DecorationOptions[] = [];
    const lostDecorations: vscode.DecorationOptions[] = [];

    const fileText = editor.document.getText();
    let storeChanged = false;

    for (const annotation of fileAnnotations) {
      // Re-read region to check for drift
      let currentAnchor = annotation.anchor;
      const currentText = await readRegion(workspaceRoot, currentAnchor);
      const status = driftStatus(currentAnchor, currentText);

      if (status === 'drifted' || status === 'unknown') {
        const reanchored = reanchor(currentAnchor, fileText);
        if (reanchored) {
          // In place, so the annotation keeps its id: anything holding the old
          // one (a cached MCP result, a tree selection) survives the heal.
          const healed = await this.store.update(annotation.id, { anchor: reanchored });
          currentAnchor = healed?.anchor ?? reanchored;
          storeChanged = true;
        } else {
          // Permanently lost! Degrade loudly. Display at line 1.
          const range = new vscode.Range(0, 0, 0, 0);
          lostDecorations.push({
            range,
            hoverMessage: `**Lost Annotation:** ${annotation.body}\n\n*This annotation could not be re-anchored. Please review it in the Acciaccatura Tree View.*`
          });
          continue;
        }
      }
      
      const startPos = new vscode.Position(currentAnchor.startLine - 1, 0);
      const endPos = new vscode.Position(currentAnchor.endLine - 1, 0);

      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**Acciaccatura (${annotation.trust})**\n\n`);
      md.appendMarkdown(annotation.body);

      // Only the span carries the hover; the icon shares the first line with it
      // and a second hoverMessage there would show the note twice.
      iconDecorations.push({ range: new vscode.Range(startPos, startPos) });
      spanDecorations.push({
        range: new vscode.Range(startPos, endPos),
        hoverMessage: md
      });
    }

    editor.setDecorations(annotationDecorationType, iconDecorations);
    editor.setDecorations(spanDecorationType, spanDecorations);
    editor.setDecorations(lostAnnotationDecorationType, lostDecorations);
    
    return storeChanged; // So we can refresh TreeView if needed
  }
}
