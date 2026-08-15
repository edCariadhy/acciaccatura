import { annotationFromSelection } from "@acciaccatura/core";
import type { AnnotationStore, CapturedSelection } from "@acciaccatura/core";

/**
 * Dependencies the capture flow needs, injected so the flow is testable without
 * a running `vscode` host. `extension.ts` supplies the real editor-backed
 * implementations; tests supply fakes.
 */
export interface CaptureDeps {
  /** The current selection, or `undefined` if nothing usable is selected. */
  getSelection: () => CapturedSelection | undefined;
  /** Prompt for the note body; `undefined` means the user cancelled. */
  promptForBody: () => Promise<string | undefined>;
  /** The shared store (same file the MCP server reads). */
  store: AnnotationStore;
  /** Surface a message to the user. */
  notify: (level: "info" | "warn", message: string) => void;
  author?: string;
}

/**
 * Orchestrates a human annotation: read the selection, ask for the note, write
 * it to the shared store with `provenance: "human"`. Returns the new
 * annotation id, or `undefined` if nothing was written (no selection, cancelled
 * prompt, or invalid input). This is the seam the `vscode` command wraps.
 */
export async function captureAnnotation(deps: CaptureDeps): Promise<string | undefined> {
  const selection = deps.getSelection();
  if (!selection) {
    deps.notify("warn", "Select the code you want to annotate first.");
    return undefined;
  }

  const body = await deps.promptForBody();
  if (body === undefined) return undefined; // user dismissed the prompt

  let draft;
  try {
    draft = annotationFromSelection({ selection, body, provenance: "human", author: deps.author });
  } catch (err) {
    deps.notify("warn", err instanceof Error ? err.message : String(err));
    return undefined;
  }

  const saved = await deps.store.add(draft);
  deps.notify(
    "info",
    `Annotated ${selection.file}:${selection.startLine}-${selection.endLine}`,
  );
  return saved.id;
}
