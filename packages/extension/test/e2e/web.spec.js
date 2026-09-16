const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  console.log("Navigating to VS Code Web on localhost:3000...");
  await page.goto('http://localhost:3000');
  
  // Wait for the workbench to load
  await page.waitForSelector('.part.activitybar', { timeout: 30000 });
  console.log("VS Code loaded.");

  try {
    const accItem = page.locator('.part.activitybar [aria-label*="Acciaccatura"]');
    await accItem.waitFor({ state: 'visible', timeout: 5000 });
    await accItem.click();
    console.log("Clicked Acciaccatura sidebar icon.");
  } catch(e) {
    console.log("Could not find Acciaccatura icon, taking screenshot...");
    await page.screenshot({ path: '/Users/edgarmalewicariadhi/.gemini/antigravity/brain/ee09094d-c57a-4d5c-ba17-4178445ad1f5/scratch/failed-icon.png' });
    await browser.close();
    return;
  }

  // Wait for the tree view to load
  try {
    await page.waitForSelector('.monaco-tree', { timeout: 10000 });
  } catch(e) {
    console.log("Tree did not load, taking screenshot...");
    await page.screenshot({ path: '/Users/edgarmalewicariadhi/.gemini/antigravity/brain/ee09094d-c57a-4d5c-ba17-4178445ad1f5/scratch/failed-tree.png' });
    await browser.close();
    return;
  }
  
  // We need to hover over an annotation to make the inline actions appear
  // Wait for a tree item. We might not have annotations in the workspace, so let's check
  const treeItems = page.locator('.monaco-tree-row');
  const count = await treeItems.count();
  console.log(`Found ${count} items in the tree view.`);
  
  if (count > 0) {
    // The first item is likely the file. Let's click it to expand.
    console.log("Clicking the first item (file) to expand it...");
    await treeItems.first().click();
    
    // Wait for expansion to render
    await page.waitForTimeout(1000);
    
    const newCount = await treeItems.count();
    console.log(`Now found ${newCount} items in the tree view.`);
    
    let foundReply = false;
    for (let i = 0; i < newCount; i++) {
      await treeItems.nth(i).hover();
      
      // Look for the reply action
      const replyAction = treeItems.nth(i).locator('.action-item .codicon-reply');
      if (await replyAction.isVisible().catch(() => false)) {
        console.log(`Success! Found the reply icon on item ${i}!`);
        foundReply = true;
        break;
      }
    }
    
    if (!foundReply) {
       console.log("Did not find a reply icon.");
    }
  } else {
    console.log("No annotations found. We need an annotation to test the reply button.");
  }
  
  await browser.close();
})().catch(console.error);
