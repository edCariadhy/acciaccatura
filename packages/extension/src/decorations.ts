import * as vscode from 'vscode';
import { AnnotationStore, driftStatus, reanchor, readRegion } from '@acciaccatura/core';

let noteStartIcon: vscode.TextEditorDecorationType;
let noteSpanLine: vscode.TextEditorDecorationType;
let missingCodeWarning: vscode.TextEditorDecorationType;

export function initDecorations(context: vscode.ExtensionContext) {
  // The icon shows WHERE a note starts, so it sits on the first line only.
  // VS Code repeats a gutter icon on every line of a range, and a 30-line note
  // drawn as 30 of the same bubble looks like 30 separate notes.
  noteStartIcon = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'annotation.svg'),
    gutterIconSize: 'contain',
  });

  // The line down the side shows HOW FAR the note reaches. It holds the hover
  // text, so pointing anywhere inside the range shows the note.
  noteSpanLine = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(92, 152, 255, 0.1)',
    borderColor: 'rgba(92, 152, 255, 0.7)',
    borderStyle: 'solid',
    borderWidth: '0 0 0 2px',
  });

  missingCodeWarning = vscode.window.createTextEditorDecorationType({
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
    const missingCodeDecorations: vscode.DecorationOptions[] = [];

    const fileText = editor.document.getText();
    let storeChanged = false;

    for (const annotation of fileAnnotations) {
      // Read the lines again to see whether the code still matches the note.
      let currentAnchor = annotation.anchor;
      const currentText = await readRegion(workspaceRoot, currentAnchor);
      const status = driftStatus(currentAnchor, currentText);

      if (status === 'drifted' || status === 'unknown') {
        const movedAnchor = reanchor(currentAnchor, fileText);
        if (movedAnchor) {
          // Update in place so the note keeps its id. Anything holding the old
          // id — a saved MCP result, a selection in the sidebar — still works.
          const saved = await this.store.update(annotation.id, { anchor: movedAnchor });
          currentAnchor = saved?.anchor ?? movedAnchor;
          storeChanged = true;
        } else {
          // We could not find the code again. Say so in the open, at line 1,
          // rather than leave the note pointing at whatever is there now.
          const range = new vscode.Range(0, 0, 0, 0);
          missingCodeDecorations.push({
            range,
            hoverMessage: `**Note with no code:** ${annotation.body}\n\n*We can't find the code this note was written for. Open the Acciaccatura view in the sidebar to move it or delete it.*`
          });
          continue;
        }
      }
      
      const startPos = new vscode.Position(currentAnchor.startLine - 1, 0);
      const endPos = new vscode.Position(currentAnchor.endLine - 1, 0);

      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**Acciaccatura (${annotation.trust})**\n\n`);
      md.appendMarkdown(annotation.body);

      // Only the side line holds the hover text. The icon sits on the same
      // first line, so hover text on both would show the note twice.
      iconDecorations.push({ range: new vscode.Range(startPos, startPos) });
      spanDecorations.push({
        range: new vscode.Range(startPos, endPos),
        hoverMessage: md
      });
    }

    editor.setDecorations(noteStartIcon, iconDecorations);
    editor.setDecorations(noteSpanLine, spanDecorations);
    editor.setDecorations(missingCodeWarning, missingCodeDecorations);
    
    return storeChanged; // So we can refresh TreeView if needed
  }
}
