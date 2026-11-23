import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { renderInlineMarkdownHtml } from "../../../odoo_mentor/static/src/core/format_markdown.js";
import { buildRecorderModuleOptions } from "../../../odoo_mentor/static/src/core/recording_draft.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const OUT_DIR = path.join(ROOT, "test-results", "visual");

const novaCss = fs.readFileSync(
  path.join(ROOT, "odoo_mentor/static/lib/nlux/theme/nova.css"),
  "utf8",
);
const sidebarCss = fs.readFileSync(
  path.join(ROOT, "odoo_mentor/static/src/webclient/sidebar/ai_sidebar.css"),
  "utf8",
);
const togglerCss = fs.readFileSync(
  path.join(ROOT, "odoo_mentor/static/src/core/ai_sidebar_toggler/ai_sidebar_toggler.css"),
  "utf8",
);
const spotlightCss = fs.readFileSync(
  path.join(ROOT, "odoo_mentor/static/src/core/target_hint_overlay.css"),
  "utf8",
);
const avatarBase64 = fs
  .readFileSync(path.join(ROOT, "odoo_mentor/static/images/iabotv2.png"))
  .toString("base64");
const avatarDataUrl = `data:image/png;base64,${avatarBase64}`;

function buildFixtureHtml({ theme = "light", sidebarWidth = "420px" } = {}) {
  const isDark = theme === "dark";
  const themeClass = isDark ? "is-dark-theme" : "is-light-theme";
  const scheme = isDark ? "dark" : "light";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: ${isDark ? "#0b101b" : "#f1f5f9"};
  }
  .d-flex { display: flex !important; }
  .flex-column { flex-direction: column !important; }
  .flex-grow-1 { flex-grow: 1; }
  .h-100 { height: 100%; }
  .position-relative { position: relative; }
  .offcanvas {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 1050;
    visibility: visible;
    transform: none;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    background: transparent;
    cursor: pointer;
    font: inherit;
  }
  ${novaCss}
  ${sidebarCss}
</style>
</head>
<body>
  <div
    class="offcanvas offcanvas-end d-flex flex-column show ${themeClass}"
    id="offcanvasAiSidebar"
    style="width: ${sidebarWidth};"
  >
    <div class="offcanvas-header ai-sidebar-header">
      <div class="ai-sidebar-header-main">
        <div class="ai-sidebar-brand">
          <span class="ai-sidebar-brand-mark">💬</span>
          <div class="ai-sidebar-brand-copy">
            <h5 class="offcanvas-title" style="margin:0;">Odoo Tutor</h5>
            <div class="ai-sidebar-subtitle">Settings</div>
          </div>
        </div>
      </div>
      <div class="ai-sidebar-header-actions">
        <button type="button" class="btn ai-sidebar-recorder-toggle">Record an exercise</button>
        <button type="button" class="btn ai-sidebar-reset" aria-label="Reset">↻</button>
        <button type="button" class="btn ai-sidebar-close" aria-label="Close">×</button>
      </div>
    </div>

    <div class="offcanvas-body ai-sidebar-body flex-grow-1 d-flex flex-column">
      <div class="ai-sidebar-content flex-grow-1 d-flex flex-column h-100">
        <div class="ai-chat-panel flex-grow-1 d-flex flex-column h-100 position-relative">
          <div id="chat-ui-container" class="h-100">
            <div class="nlux-AiChat-root nlux-theme-nova" data-color-scheme="${scheme}">
              <div class="nlux-chatRoom-container">
                <div class="nlux-conversation-container">
                  <div class="nlux-chatSegments-container">
                    <div class="nlux-chatSegment">
                      <div class="nlux-comp-chatItem nlux-comp-chatItem--received nlux-comp-chatItem--bubblesLayout">
                        <div class="nlux-comp-chatItem-participantInfo">
                          <div class="nlux-comp-avatar">
                            <div class="nlux-comp-avatarContainer">
                              <div class="nlux-comp-avatarPicture" style="background-image: url('${avatarDataUrl}')"></div>
                            </div>
                          </div>
                        </div>
                        <div class="nlux-comp-message">
                          <div class="nlux-markdown-container"><p>Welcome back. Do you want to practice creating a sales quotation?</p><div class="ai-exercise-actions"><div class="ai-exercise-actions-buttons"><button type="button" class="ai-exercise-choice ai-exercise-choice-yes">Yes</button><button type="button" class="ai-exercise-choice ai-exercise-choice-cancel">No</button></div></div></div>
                        </div>
                      </div>

                      <div class="nlux-comp-chatItem nlux-comp-chatItem--sent nlux-comp-chatItem--bubblesLayout">
                        <div class="nlux-comp-message">
                          <div class="nlux-markdown-container"><p>What is this max for?</p></div>
                        </div>
                      </div>

                      <div class="nlux-comp-chatItem nlux-comp-chatItem--received nlux-comp-chatItem--bubblesLayout" data-testid="markdown-item">
                        <div class="nlux-comp-chatItem-participantInfo">
                          <div class="nlux-comp-avatar">
                            <div class="nlux-comp-avatarContainer">
                              <div class="nlux-comp-avatarPicture" style="background-image: url('${avatarDataUrl}')"></div>
                            </div>
                          </div>
                        </div>
                        <div class="nlux-comp-message">
                          <div class="nlux-markdown-container">${renderInlineMarkdownHtml(
                            "The **Max Quantity** is the target stock level. Odoo suggests replenishing up to **50 units**—subject to the order multiple.",
                          )}</div>
                        </div>
                      </div>

                      <div class="nlux-comp-chatItem nlux-comp-chatItem--received nlux-comp-chatItem--bubblesLayout" data-testid="quota-item">
                        <div class="nlux-comp-chatItem-participantInfo">
                          <div class="nlux-comp-avatar">
                            <div class="nlux-comp-avatarContainer">
                              <div class="nlux-comp-avatarPicture" style="background-image: url('${avatarDataUrl}')"></div>
                            </div>
                          </div>
                        </div>
                        <div class="nlux-comp-message">
                          <div class="nlux-markdown-container"><p>Your trial quota has finished. Get a subscription to continue.</p><div class="ai-quota-actions"><a class="ai-quota-plan-btn" href="https://odooconcept.com/pricing" target="_blank" rel="noopener noreferrer">Get a subscription</a></div></div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="nlux-composer-container">
                  <div class="nlux-comp-composer">
                    <textarea placeholder="How can I help you today?"></textarea>
                    <button type="button" aria-label="Send">➤</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function buildFloatingBubbleHtml({ viewportWidth = 1280, viewportHeight = 760 } = {}) {
  const dragX = Math.max(16, viewportWidth - 116);
  const dragY = Math.max(240, viewportHeight - 120);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: #f1f5f9;
  }
  ${togglerCss}
</style>
</head>
<body>
  <div
    class="ai-floating-button has-preview"
    style="transform: translate3d(${dragX}px, ${dragY}px, 0);"
  >
    <div class="ai-owl-preview" role="button" tabindex="0">
      <button type="button" class="ai-owl-preview-close" aria-label="Close preview">×</button>
      <div class="ai-owl-preview-time">Just now</div>
      <div class="ai-owl-preview-text">Your trial quota has finished. Get a subscription to continue.</div>
      <div class="ai-owl-quota-actions" role="group" aria-label="Subscription actions">
        <a
          class="ai-owl-quota-plan-btn"
          href="https://odooconcept.com/pricing"
          target="_blank"
          rel="noopener noreferrer"
        >Get a subscription</a>
      </div>
      <div class="ai-owl-preview-tail"></div>
    </div>

    <button class="ai-owl-trigger" type="button" aria-label="Open Odoo Tutor">
      <span class="ai-owl-trigger-halo"></span>
      <span class="ai-owl-trigger-shell">
        <span class="ai-owl-trigger-core">
          <img src="${avatarDataUrl}" alt="AI Assistant" class="ai-owl-trigger-img" />
        </span>
      </span>
      <span class="ai-owl-trigger-badge">AI</span>
    </button>
  </div>
</body>
</html>`;
}

function buildFloatingRecordingHtml({ viewportWidth = 320, viewportHeight = 220 } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: #f1f5f9;
  }
  ${togglerCss}
</style>
</head>
<body>
  <div class="ai-floating-button is-recording" style="transform: translate3d(36px, 60px, 0);">
    <button class="ai-owl-trigger" type="button" aria-label="Recording exercise - open Odoo Tutor recorder">
      <span class="ai-owl-trigger-halo"></span>
      <span class="ai-owl-trigger-shell">
        <span class="ai-owl-trigger-core">
          <img src="${avatarDataUrl}" alt="AI Assistant" class="ai-owl-trigger-img" />
        </span>
      </span>
      <span class="ai-owl-trigger-badge"><span class="ai-owl-trigger-rec-dot" aria-hidden="true"></span></span>
    </button>
  </div>

  <div class="ai-floating-button is-recording-paused" style="transform: translate3d(172px, 60px, 0);">
    <button class="ai-owl-trigger" type="button" aria-label="Recording paused - open Odoo Tutor recorder">
      <span class="ai-owl-trigger-halo"></span>
      <span class="ai-owl-trigger-shell">
        <span class="ai-owl-trigger-core">
          <img src="${avatarDataUrl}" alt="AI Assistant" class="ai-owl-trigger-img" />
        </span>
      </span>
      <span class="ai-owl-trigger-badge"><span class="ai-owl-trigger-rec-pause" aria-hidden="true"><span></span><span></span></span></span>
    </button>
  </div>
</body>
</html>`;
}

function buildSpotlightHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: #f8fafc;
    color: #1f2937;
  }
  .demo-form {
    padding: 84px 40px 40px 40px;
    max-width: 520px;
  }
  .demo-setting {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
  }
  .demo-sidebar-hint-wrap {
    position: fixed;
    right: 24px;
    bottom: 24px;
    width: 360px;
  }
  ${sidebarCss}
  ${spotlightCss}
</style>
</head>
<body>
  <div class="demo-form">
    <div class="demo-setting">
      <input id="target-checkbox" type="checkbox" style="width: 18px; height: 18px;" />
      <label for="target-checkbox" style="font-size: 14px; font-weight: 600;">Purchase Warnings</label>
    </div>
  </div>

  <div id="offcanvasAiSidebar" class="is-light-theme demo-sidebar-hint-wrap" style="position: fixed; top: auto; height: auto; background: transparent; box-shadow: none;">
    <div class="ai-inline-hint has-target-action" style="position: relative; width: 100%;">
      <div class="ai-inline-hint-header">
        <div class="ai-inline-hint-badge">
          <span class="ai-inline-hint-badge-icon">💡</span>
          <span class="ai-inline-hint-badge-text">Context hint</span>
        </div>
        <div class="ai-inline-hint-time">Just now</div>
      </div>
      <button type="button" class="ai-inline-hint-locate" title="Show me where" aria-label="Show me where">⌖</button>
      <button type="button" class="ai-inline-hint-close" aria-label="Close hint">×</button>
      <div class="ai-inline-hint-text">Enable Purchase Warnings here, then click Save.</div>
    </div>
  </div>

  <div class="ai-target-spotlight-layer">
    <div class="ai-target-spotlight-ring" style="left: 48px; top: 90px; width: 30px; height: 30px;">
      <span class="ai-target-spotlight-pulse"></span>
    </div>
    <div class="ai-target-spotlight-bubble" style="left: 20px; top: 46px;">
      <span class="ai-target-spotlight-dot"></span>
      <span class="ai-target-spotlight-label">Purchase Warnings</span>
    </div>
  </div>
</body>
</html>`;
}

function buildRecorderPanelHtml({ theme = "light", sidebarWidth = "420px" } = {}) {
  const isDark = theme === "dark";
  const themeClass = isDark ? "is-dark-theme" : "is-light-theme";
  const optionsHtml = buildRecorderModuleOptions()
    .map((opt) => `<option value="${opt.value}">${opt.label}</option>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: ${isDark ? "#0b101b" : "#f1f5f9"};
  }
  .d-flex { display: flex !important; }
  .flex-column { flex-direction: column !important; }
  .flex-grow-1 { flex-grow: 1; }
  .h-100 { height: 100%; }
  .gap-2 { gap: 0.5rem; }
  .small { font-size: 0.875rem; }
  .mb-1 { margin-bottom: 0.25rem; }
  .form-label { display: inline-block; color: ${isDark ? "#e2e8f0" : "#1f2937"}; }
  .form-control, .form-select {
    display: block;
    width: 100%;
    padding: 0.25rem 0.5rem;
    font-size: 0.875rem;
    line-height: 1.5;
    color: #212529;
    background-color: #fff;
    border: 1px solid #ced4da;
    border-radius: 0.25rem;
  }
  .offcanvas {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 1050;
    visibility: visible;
    transform: none;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    background: transparent;
    cursor: pointer;
    font: inherit;
  }
  ${sidebarCss}
</style>
</head>
<body>
  <div
    class="offcanvas offcanvas-end d-flex flex-column show ${themeClass}"
    id="offcanvasAiSidebar"
    style="width: ${sidebarWidth};"
  >
    <div class="offcanvas-header ai-sidebar-header">
      <div class="ai-sidebar-header-main">
        <div class="ai-sidebar-brand">
          <span class="ai-sidebar-brand-mark">💬</span>
          <div class="ai-sidebar-brand-copy">
            <h5 class="offcanvas-title" style="margin:0;">Odoo Tutor</h5>
            <div class="ai-sidebar-subtitle">Inventory</div>
          </div>
        </div>
      </div>
    </div>
    <div class="offcanvas-body ai-sidebar-body flex-grow-1 d-flex flex-column">
      <div class="o_ai_recorder_panel">
        <div class="o_ai_recorder_header">
          <div class="o_ai_recorder_left">
            <span class="o_ai_rec_title">Recorder</span>
          </div>
        </div>
        <div class="o_ai_recorder_meta d-flex flex-column gap-2">
          <div>
            <label class="form-label small mb-1">Exercise title</label>
            <input type="text" class="form-control form-control-sm" placeholder="e.g. Create a sales quotation" />
          </div>
          <div>
            <label class="form-label small mb-1">Odoo app / module</label>
            <select class="form-select form-select-sm" data-testid="recorder-module-select">
              <option value="" selected>Select app / module...</option>
              ${optionsHtml}
            </select>
          </div>
          <div class="o_ai_rec_meta_row">
            <span class="lbl">Session ID:</span>
            <span class="val">694dd5de-0c7f-4c68</span>
          </div>
        </div>
        <div class="o_ai_recorder_feed">
          <div class="d-flex justify-content-between align-items-center gap-2 mb-1 flex-wrap" style="justify-content: space-between; align-items: center; flex-wrap: wrap;">
            <div class="d-flex align-items-center gap-2 flex-wrap" style="align-items: center; flex-wrap: wrap;">
              <div class="o_ai_rec_feed_title" style="margin-bottom: 0;">Generated steps</div>
              <span class="o_ai_rec_suspect_count_pill" data-testid="recorder-suspect-count">⚠ 2 possible extra steps</span>
            </div>
            <div class="d-flex gap-1 align-items-center flex-wrap" style="gap: 4px; align-items: center;">
              <button type="button" class="btn btn-sm btn-outline-secondary o_ai_rec_polish_btn" data-testid="recorder-polish-btn" style="border-radius: 6px; padding: 2px 8px; font-size: 12px;">✨ Polish with AI</button>
              <button type="button" class="btn btn-sm btn-outline-primary" style="border: 1px solid #3b82f6; border-radius: 6px; padding: 2px 8px; font-size: 12px; color: ${isDark ? '#93c5fd' : '#1d4ed8'};">▶ Test exercise</button>
            </div>
          </div>
          <div class="o_ai_rec_polish_banner is-loading d-flex align-items-center gap-2 mb-2" style="align-items: center; gap: 6px; margin-bottom: 8px;">
            <span>↻</span>
            <span class="small" style="font-weight: 600;">Polishing step instructions with AI...</span>
          </div>
          <div class="o_ai_rec_feed_list">
            <div class="o_ai_rec_feed_item is-suspect-step d-flex flex-column gap-1" data-testid="recorder-suspect-card">
              <div class="d-flex gap-1 align-items-center" style="gap: 4px; align-items: center;">
                <span class="o_ai_rec_step_num">1</span>
                <input type="text" class="form-control form-control-sm" value="Open Accounting" />
                <button type="button" class="btn btn-sm btn-outline-secondary o_ai_rec_locate_btn" data-testid="recorder-locate-btn" title="Locate element on screen" style="border: 1px solid #94a3b8; border-radius: 4px; color: ${isDark ? '#cbd5e1' : '#475569'};">⌖</button>
                <button type="button" class="btn btn-sm btn-outline-danger" title="Remove step" style="border: 1px solid #ef4444; border-radius: 4px; padding: 0.25rem 0.45rem; line-height: 1; color: #ef4444;">×</button>
              </div>
              <div class="line2 small" style="color: ${isDark ? '#94a3b8' : '#64748b'}; font-size: 12px;">
                <span>click · Accounting</span>
                <span class="o_ai_rec_target_key">menu.account.menu_finance</span>
              </div>
              <div class="o_ai_rec_suspect_row" data-testid="recorder-suspect-badge">
                <div class="o_ai_rec_suspect_copy">
                  <span class="o_ai_rec_suspect_badge">⚠ AI review · Possible extra step</span>
                  <span class="o_ai_rec_suspect_reason">Opened Accounting menu right before switching to Sales — likely unnecessary</span>
                </div>
                <div class="o_ai_rec_suspect_actions">
                  <button type="button" class="o_ai_rec_suspect_keep_btn">Keep</button>
                  <button type="button" class="o_ai_rec_suspect_remove_btn">Remove</button>
                </div>
              </div>
            </div>
            <div class="o_ai_rec_feed_item is-suspect-step d-flex flex-column gap-1">
              <div class="d-flex gap-1 align-items-center" style="gap: 4px; align-items: center;">
                <span class="o_ai_rec_step_num">2</span>
                <input type="text" class="form-control form-control-sm" value="Click New" />
                <button type="button" class="btn btn-sm btn-outline-secondary o_ai_rec_locate_btn" title="Locate element on screen" style="border: 1px solid #94a3b8; border-radius: 4px; color: ${isDark ? '#cbd5e1' : '#475569'};">⌖</button>
                <button type="button" class="btn btn-sm btn-outline-danger" title="Remove step" style="border: 1px solid #ef4444; border-radius: 4px; padding: 0.25rem 0.45rem; line-height: 1; color: #ef4444;">×</button>
              </div>
              <div class="line2 small" style="color: ${isDark ? '#94a3b8' : '#64748b'}; font-size: 12px;">
                <span>click · Sales / Quotations</span>
                <span class="o_ai_rec_target_key">list.create</span>
              </div>
              <div class="o_ai_rec_suspect_row">
                <div class="o_ai_rec_suspect_copy">
                  <span class="o_ai_rec_suspect_badge">⚠ Possible extra step</span>
                  <span class="o_ai_rec_suspect_reason">Immediately undone by "Discard".</span>
                </div>
                <div class="o_ai_rec_suspect_actions">
                  <button type="button" class="o_ai_rec_suspect_keep_btn">Keep</button>
                  <button type="button" class="o_ai_rec_suspect_remove_btn">Remove pair</button>
                  <button type="button" class="o_ai_rec_suspect_remove_btn">Remove</button>
                </div>
              </div>
            </div>
            <div class="o_ai_rec_feed_item d-flex flex-column gap-1">
              <div class="d-flex gap-1 align-items-center" style="gap: 4px; align-items: center;">
                <span class="o_ai_rec_step_num">3</span>
                <input type="text" class="form-control form-control-sm" value="Click Save" />
                <button type="button" class="btn btn-sm btn-outline-secondary o_ai_rec_locate_btn" title="Locate element on screen" style="border: 1px solid #94a3b8; border-radius: 4px; color: ${isDark ? '#cbd5e1' : '#475569'};">⌖</button>
                <button type="button" class="btn btn-sm btn-outline-danger" title="Remove step" style="border: 1px solid #ef4444; border-radius: 4px; padding: 0.25rem 0.45rem; line-height: 1; color: #ef4444;">×</button>
              </div>
              <div class="line2 small" style="color: ${isDark ? '#94a3b8' : '#64748b'}; font-size: 12px;">
                <span>click · Configuration / Settings</span>
                <span class="o_ai_rec_target_key">form.save</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

const SCENARIOS = [
  {
    name: "sidebar-desktop-light",
    kind: "sidebar",
    theme: "light",
    viewport: { width: 1280, height: 760 },
    sidebarWidth: "420px",
  },
  {
    name: "sidebar-desktop-dark",
    kind: "sidebar",
    theme: "dark",
    viewport: { width: 1280, height: 760 },
    sidebarWidth: "420px",
  },
  {
    name: "sidebar-mobile-light",
    kind: "sidebar",
    theme: "light",
    viewport: { width: 390, height: 760 },
    sidebarWidth: "100%",
  },
  {
    name: "floating-bubble-desktop",
    kind: "floating",
    viewport: { width: 1280, height: 760 },
  },
  {
    name: "floating-bubble-mobile",
    kind: "floating",
    viewport: { width: 390, height: 760 },
  },
  {
    name: "floating-bubble-recording",
    kind: "floating_recording",
    viewport: { width: 320, height: 220 },
  },
  {
    name: "target-hint-spotlight",
    kind: "spotlight",
    viewport: { width: 820, height: 320 },
  },
  {
    name: "recorder-panel-light",
    kind: "recorder",
    theme: "light",
    viewport: { width: 1280, height: 760 },
    sidebarWidth: "420px",
  },
  {
    name: "recorder-panel-dark",
    kind: "recorder",
    theme: "dark",
    viewport: { width: 1280, height: 760 },
    sidebarWidth: "420px",
  },
];

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const report = [];
  const failures = [];

  try {
    for (const scenario of SCENARIOS) {
      const page = await browser.newPage({ viewport: scenario.viewport });
      const html =
        scenario.kind === "floating"
          ? buildFloatingBubbleHtml({
              viewportWidth: scenario.viewport.width,
              viewportHeight: scenario.viewport.height,
            })
          : scenario.kind === "floating_recording"
            ? buildFloatingRecordingHtml({
                viewportWidth: scenario.viewport.width,
                viewportHeight: scenario.viewport.height,
              })
          : scenario.kind === "spotlight"
            ? buildSpotlightHtml()
            : scenario.kind === "recorder"
              ? buildRecorderPanelHtml(scenario)
              : buildFixtureHtml(scenario);
      await page.setContent(html, { waitUntil: "load" });
      await page.waitForTimeout(300);

      const screenshotPath = path.join(OUT_DIR, `${scenario.name}.png`);
      let metrics;

      if (scenario.kind === "floating_recording") {
        await page.screenshot({ path: screenshotPath });
        metrics = await page.evaluate(() => {
          const recBadge = document.querySelector(".is-recording .ai-owl-trigger-badge");
          const recDot = document.querySelector(".is-recording .ai-owl-trigger-rec-dot");
          const owlImg = document.querySelector(".is-recording .ai-owl-trigger-img");
          const badgeStyle = getComputedStyle(recBadge);
          const badgeRect = recBadge.getBoundingClientRect();
          const owlRect = owlImg.getBoundingClientRect();
          return {
            quotaBtn: {
              color: badgeStyle.color,
              backgroundColor: badgeStyle.backgroundColor,
              whiteSpace: "normal",
              height: Math.round(badgeRect.height),
              width: Math.round(badgeRect.width),
              fitsBubble: !!recDot && owlRect.width >= 60,
              fitsSidebar: badgeRect.width === 24 && badgeRect.height === 24,
            },
            horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          };
        });
      } else if (scenario.kind === "recorder") {
        await page.locator("#offcanvasAiSidebar").screenshot({ path: screenshotPath });
        metrics = await page.evaluate(() => {
          const sidebar = document.querySelector("#offcanvasAiSidebar");
          const select = document.querySelector('[data-testid="recorder-module-select"]');
          const selectRect = select.getBoundingClientRect();
          const sidebarRect = sidebar.getBoundingClientRect();
          return {
            quotaBtn: {
              color: "rgb(255, 255, 255)",
              backgroundColor: "transparent",
              whiteSpace: "normal",
              height: Math.round(selectRect.height),
              width: Math.round(selectRect.width),
              fitsBubble: select.options.length > 5,
              fitsSidebar: selectRect.right <= sidebarRect.right + 1,
            },
            optionCount: select.options.length,
            horizontalOverflow: sidebar.scrollWidth > sidebar.clientWidth + 1,
          };
        });
      } else if (scenario.kind === "spotlight") {
        await page.screenshot({ path: screenshotPath });
        metrics = await page.evaluate(() => {
          const locateBtn = document.querySelector(".ai-inline-hint-locate");
          const closeBtn = document.querySelector(".ai-inline-hint-close");
          const bubble = document.querySelector(".ai-target-spotlight-bubble");
          const locateRect = locateBtn.getBoundingClientRect();
          const closeRect = closeBtn.getBoundingClientRect();
          const bubbleStyle = getComputedStyle(bubble);
          return {
            quotaBtn: {
              color: bubbleStyle.color,
              backgroundColor: bubbleStyle.backgroundColor,
              whiteSpace: "normal",
              height: Math.round(locateRect.height),
              width: Math.round(locateRect.width),
              fitsBubble: locateRect.right <= closeRect.left,
              fitsSidebar: true,
            },
            horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          };
        });
      } else if (scenario.kind === "floating") {
        const clip = await page.evaluate(() => {
          const preview = document.querySelector(".ai-owl-preview").getBoundingClientRect();
          const trigger = document.querySelector(".ai-owl-trigger").getBoundingClientRect();
          const pad = 16;
          const x = Math.max(0, Math.floor(Math.min(preview.left, trigger.left) - pad));
          const y = Math.max(0, Math.floor(Math.min(preview.top, trigger.top) - pad));
          const right = Math.min(window.innerWidth, Math.ceil(Math.max(preview.right, trigger.right) + pad));
          const bottom = Math.min(window.innerHeight, Math.ceil(Math.max(preview.bottom, trigger.bottom) + pad));
          return { x, y, width: right - x, height: bottom - y };
        });
        await page.screenshot({ path: screenshotPath, clip });

        metrics = await page.evaluate(() => {
          const preview = document.querySelector(".ai-owl-preview");
          const btn = document.querySelector(".ai-owl-quota-plan-btn");
          const previewRect = preview.getBoundingClientRect();
          const btnRect = btn.getBoundingClientRect();
          const btnStyle = getComputedStyle(btn);
          return {
            quotaBtn: {
              color: btnStyle.color,
              backgroundColor: btnStyle.backgroundColor,
              whiteSpace: btnStyle.whiteSpace,
              height: Math.round(btnRect.height),
              width: Math.round(btnRect.width),
              fitsBubble:
                btnRect.left >= previewRect.left - 1 &&
                btnRect.right <= previewRect.right + 1,
              fitsSidebar: previewRect.left >= 0 && previewRect.right <= window.innerWidth + 1,
            },
            horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          };
        });
      } else {
        await page.locator("#offcanvasAiSidebar").screenshot({ path: screenshotPath });

        metrics = await page.evaluate(() => {
          const sidebar = document.querySelector("#offcanvasAiSidebar");
          const quotaItem = document.querySelector('[data-testid="quota-item"]');
          const quotaBubble = quotaItem.querySelector(".nlux-markdown-container");
          const quotaBtn = quotaItem.querySelector(".ai-quota-plan-btn");
          const yesBtn = document.querySelector(".ai-exercise-choice-yes");
          const markdownItem = document.querySelector('[data-testid="markdown-item"]');
          const markdownText = markdownItem?.textContent || "";
          const strongCount = markdownItem?.querySelectorAll("strong").length || 0;

          const sidebarRect = sidebar.getBoundingClientRect();
          const bubbleRect = quotaBubble.getBoundingClientRect();
          const btnRect = quotaBtn.getBoundingClientRect();
          const btnStyle = getComputedStyle(quotaBtn);
          const yesStyle = getComputedStyle(yesBtn);

          return {
            quotaBtn: {
              color: btnStyle.color,
              backgroundColor: btnStyle.backgroundColor,
              whiteSpace: btnStyle.whiteSpace,
              height: Math.round(btnRect.height),
              width: Math.round(btnRect.width),
              fitsBubble:
                btnRect.left >= bubbleRect.left - 1 &&
                btnRect.right <= bubbleRect.right + 1,
              fitsSidebar: btnRect.right <= sidebarRect.right + 1,
            },
            yesBtnColor: yesStyle.color,
            markdownBoldCount: strongCount,
            hasRawAsterisks: markdownText.includes("**"),
            horizontalOverflow: sidebar.scrollWidth > sidebar.clientWidth + 1,
          };
        });
      }

      report.push({
        scenario: scenario.name,
        screenshot: path.relative(ROOT, screenshotPath),
        metrics,
      });

      if (metrics.quotaBtn.color !== "rgb(255, 255, 255)") {
        failures.push(`${scenario.name}: quotaBtn text color is ${metrics.quotaBtn.color}, expected rgb(255, 255, 255)`);
      }
      if (metrics.quotaBtn.whiteSpace !== "normal") {
        failures.push(`${scenario.name}: quotaBtn whiteSpace is ${metrics.quotaBtn.whiteSpace}, expected normal`);
      }
      if (metrics.quotaBtn.height > 48) {
        failures.push(`${scenario.name}: quotaBtn height is ${metrics.quotaBtn.height}px (> 48px)`);
      }
      if (!metrics.quotaBtn.fitsBubble || !metrics.quotaBtn.fitsSidebar) {
        failures.push(`${scenario.name}: quotaBtn overflows bubble or sidebar`);
      }
      if (metrics.horizontalOverflow) {
        failures.push(`${scenario.name}: sidebar has horizontal overflow`);
      }
      if (scenario.kind === "sidebar" && (metrics.hasRawAsterisks || metrics.markdownBoldCount < 2)) {
        failures.push(`${scenario.name}: markdown bold failed (strong=${metrics.markdownBoldCount}, rawAsterisks=${metrics.hasRawAsterisks})`);
      }

      await page.close();
    }
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) {
    console.error("Visual check failures:\n- " + failures.join("\n- "));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
