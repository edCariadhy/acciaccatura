import * as vscode from 'vscode';
import { AnnotationStore } from '@acciaccatura/core';

import { gutterMarks } from './viewModel.js';

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

    // Relative path to workspace root
    const relPath = vscode.workspace.asRelativePath(editor.document.uri, false);

    // What to draw is decided in viewModel.ts, which has no vscode import and
    // is unit-tested — including that finished notes leave the gutter and that
    // a note whose code is gone says so instead of pointing at a guess. The
    // buffer, not the file on disk, so notes follow unsaved edits.
    const marks = gutterMarks(this.store.all(), relPath, editor.document.getText());

    const iconDecorations: vscode.DecorationOptions[] = [];
    const spanDecorations: vscode.DecorationOptions[] = [];
    const missingCodeDecorations: vscode.DecorationOptions[] = [];

    for (const mark of marks) {
      if (mark.kind === 'missing') {
        // Drawn at line 1, where it cannot be missed.
        missingCodeDecorations.push({
          range: new vscode.Range(0, 0, 0, 0),
          hoverMessage: mark.hover,
        });
        continue;
      }

      const startPos = new vscode.Position(mark.startLine - 1, 0);
      const endPos = new vscode.Position(mark.endLine - 1, 0);

      // Only the side line holds the hover text. The icon sits on the same
      // first line, so hover text on both would show the note twice.
      iconDecorations.push({ range: new vscode.Range(startPos, startPos) });
      spanDecorations.push({
        range: new vscode.Range(startPos, endPos),
        hoverMessage: new vscode.MarkdownString(mark.hover),
      });
    }

    editor.setDecorations(noteStartIcon, iconDecorations);
    editor.setDecorations(noteSpanLine, spanDecorations);
    editor.setDecorations(missingCodeWarning, missingCodeDecorations);
  }
}
