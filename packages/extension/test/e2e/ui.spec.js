const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  console.log("Launching VS Code with Playwright...");
  const extensionPath = path.resolve(__dirname, '../../');
  
  const electronApp = await electron.launch({
    executablePath: path.resolve(__dirname, '../../.vscode-test/vscode-darwin-arm64-1.137.0/Visual Studio Code.app/Contents/MacOS/Code'),
    args: [
      '--disable-updates',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--extensionDevelopmentPath=' + extensionPath,
      '--no-sandbox'
    ],
  });

  console.log("Waiting for the first window...");
  const window = await electronApp.firstWindow();

  console.log("VS Code Window title:", await window.title());

  // Wait a bit for the extension to load
  await window.waitForTimeout(5000);

  // We need to open the Acciaccatura sidebar
  console.log("Opening Acciaccatura sidebar...");
  
  // VS Code's DOM is complex. We can use Playwright to find the activity bar item.
  // The activity bar item for our extension has id "workbench.view.extension.acciaccatura" or similar.
  // Let's just find the element with aria-label "Acciaccatura"
  try {
    const activityBar = window.locator('.part.activitybar');
    const accItem = activityBar.locator('[aria-label="Acciaccatura"]');
    await accItem.click();
    console.log("Clicked sidebar item!");
    
    await window.waitForTimeout(2000);
    
    // Now look for an annotation item. We need some annotations in the workspace to test this.
    // The workspace is empty by default unless we pass a folder.
    // We should probably run this with a folder!
    
  } catch (err) {
    console.error("Error clicking sidebar:", err);
  }

  await electronApp.close();
  console.log("Done!");
})().catch(console.error);
