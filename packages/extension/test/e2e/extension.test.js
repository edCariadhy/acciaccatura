const assert = require("node:assert");
const vscode = require("vscode");

// Real extension-host smoke test: proves the packaged extension activates and
// wires its command inside an actual VS Code. Deeper write-path logic is
// covered by the fast vitest unit suite (test/unit), not here.
suite("Acciaccatura extension (e2e)", () => {
  test("is present and activates", async () => {
    const ext = vscode.extensions.getExtension("acciaccatura.acciaccatura");
    assert.ok(ext, "extension acciaccatura.acciaccatura should be installed in the host");
    await ext.activate();
    assert.strictEqual(ext.isActive, true, "extension should activate");
  });

  test("registers the annotate command", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("acciaccatura.annotateSelection"),
      "acciaccatura.annotateSelection should be registered",
    );
  });

  test("invoking with no active editor no-ops without throwing", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("acciaccatura.annotateSelection");
  });
});
