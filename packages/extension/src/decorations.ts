import * as vscode from 'vscode';
import { AnnotationStore, driftStatus, reanchor, readRegion } from '@acciaccatura/core';

let annotationDecorationType: vscode.TextEditorDecorationType;
let lostAnnotationDecorationType: vscode.TextEditorDecorationType;

export function initDecorations(context: vscode.ExtensionContext) {
  annotationDecorationType = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'annotation.svg'),
    gutterIconSize: 'contain',
    isWholeLine: true,
    backgroundColor: 'rgba(92, 152, 255, 0.1)',
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
    
    const validDecorations: vscode.DecorationOptions[] = [];
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
          currentAnchor = reanchored;
          await this.store.remove(annotation.id);
          await this.store.add({
            body: annotation.body,
            anchor: currentAnchor,
            provenance: annotation.provenance,
            trust: annotation.trust,
            author: annotation.author
          });
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
      const range = new vscode.Range(startPos, endPos);
      
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**Acciaccatura (${annotation.trust})**\n\n`);
      md.appendMarkdown(annotation.body);
      
      validDecorations.push({
        range,
        hoverMessage: md
      });
    }

    editor.setDecorations(annotationDecorationType, validDecorations);
    editor.setDecorations(lostAnnotationDecorationType, lostDecorations);
    
    return storeChanged; // So we can refresh TreeView if needed
  }
}
