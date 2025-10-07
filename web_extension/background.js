chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'INJECT_YT_PROBE' && sender.tab?.id != null) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      files: ["yt_probe.js"]
    }, () => sendResponse({ ok: true }));
    return true; // async
  }
});
