import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

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
  .d-flex { display: flex; }
  .flex-column { flex-direction: column; }
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
                          <div class="nlux-markdown-container"><p>continue</p></div>
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

const SCENARIOS = [
  {
    name: "sidebar-desktop-light",
    theme: "light",
    viewport: { width: 1280, height: 760 },
    sidebarWidth: "420px",
  },
  {
    name: "sidebar-desktop-dark",
    theme: "dark",
    viewport: { width: 1280, height: 760 },
    sidebarWidth: "420px",
  },
  {
    name: "sidebar-mobile-light",
    theme: "light",
    viewport: { width: 390, height: 760 },
    sidebarWidth: "100%",
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
      await page.setContent(buildFixtureHtml(scenario), { waitUntil: "load" });
      await page.waitForTimeout(250);

      const screenshotPath = path.join(OUT_DIR, `${scenario.name}.png`);
      await page.locator("#offcanvasAiSidebar").screenshot({ path: screenshotPath });

      const metrics = await page.evaluate(() => {
        const sidebar = document.querySelector("#offcanvasAiSidebar");
        const quotaItem = document.querySelector('[data-testid="quota-item"]');
        const quotaBubble = quotaItem.querySelector(".nlux-markdown-container");
        const quotaBtn = quotaItem.querySelector(".ai-quota-plan-btn");
        const yesBtn = document.querySelector(".ai-exercise-choice-yes");

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
          horizontalOverflow: sidebar.scrollWidth > sidebar.clientWidth + 1,
        };
      });

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
