import puppeteer from 'puppeteer-core';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';

const CHROME_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/lib/chromium/chromium',
  '/usr/lib/chromium-browser/chromium-browser',
  '/snap/bin/chromium',
  '/app/.apt/usr/bin/google-chrome',
  '/app/.apt/usr/bin/google-chrome-stable',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Users\\' + (process.env.USERNAME || 'hp') + '\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Chromium\\Application\\chromium.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_PATHS) {
    if (existsSync(p)) return p;
  }
  if (os.platform() !== 'win32') {
    try {
      const output = execSync(
        'which google-chrome-stable || which google-chrome || which chromium-browser || which chromium',
        { stdio: 'pipe' }
      ).toString().trim().split('\n')[0];
      if (output && existsSync(output)) return output;
    } catch (e) {}
  }
  return null;
}

let cachedBrowser = null;
let browserLaunchPromise = null;

export async function getBrowser() {
  if (cachedBrowser && cachedBrowser.connected !== false) return cachedBrowser;
  if (browserLaunchPromise) return browserLaunchPromise;

  const executablePath = findChrome();
  if (!executablePath) throw new Error('Chrome/Edge not found. Please install Google Chrome.');

  browserLaunchPromise = puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
      '--disable-dev-shm-usage', '--no-first-run',
      '--disable-background-networking', '--disable-background-timer-throttling',
      '--disable-breakpad', '--disable-client-side-phishing-detection',
      '--disable-default-apps', '--disable-extensions', '--disable-hang-monitor',
      '--disable-popup-blocking', '--disable-prompt-on-repost', '--disable-sync',
      '--disable-translate', '--metrics-recording-only', '--mute-audio',
      '--safebrowsing-disable-auto-update'
    ]
  }).then((browser) => {
    cachedBrowser = browser;
    browserLaunchPromise = null;
    browser.on('disconnected', () => { cachedBrowser = null; });
    return browser;
  }).catch((err) => {
    browserLaunchPromise = null;
    throw err;
  });

  return browserLaunchPromise;
}

let warmPage = null;

async function getPage(browser) {
  if (warmPage && !warmPage.isClosed()) {
    const p = warmPage;
    warmPage = null;
    browser.newPage().then(next => { warmPage = next; }).catch(() => {});
    return p;
  }
  const page = await browser.newPage();
  browser.newPage().then(next => { warmPage = next; }).catch(() => {});
  return page;
}

export function warmUpPdfEngine() {
  getBrowser().then(async (browser) => {
    if (!warmPage || warmPage.isClosed()) {
      warmPage = await browser.newPage().catch(() => null);
    }
  }).catch(() => {});
}

/**
 * Generate a PDF Buffer from HTML.
 * Mathematically perfect centering: left === right, top === bottom.
 * Single-page guarantee without content cut-off.
 */
export async function generatePdfFromHtml(htmlContent) {
  const browser = await getBrowser();
  const page = await getPage(browser);

  try {
    // 900px viewport ensures 800px proposal card has 50px each side
    await page.setViewport({ width: 900, height: 10000, deviceScaleFactor: 2 });
    await page.setContent(htmlContent, { waitUntil: 'domcontentloaded' });
    await page.emulateMediaType('print');

    // Settle reflow
    await new Promise((r) => setTimeout(r, 50));

    const docInfo = await page.evaluate(() => {
      const isProposal = !!(
        document.querySelector('.a4-page') ||
        document.querySelector('.proposal-doc, .proposal-container, .proposal-root, .proposal')
      );

      if (isProposal) {
        const card = document.querySelector('.a4-page');
        if (!card) {
          return {
            isProposal: true,
            totalWidth: 900,
            totalHeight: document.documentElement.scrollHeight + 48,
            marginZero: true
          };
        }

        // Make sure card allows full content display
        card.style.height = 'auto';
        card.style.overflow = 'visible';

        const rect = card.getBoundingClientRect();
        // Top gap is exact top offset of card from viewport (e.g. 24px html + 24px body = 48px)
        const topGap = Math.max(20, Math.ceil(rect.top));
        const cardHeight = Math.ceil(rect.height);

        // PERFECT EQUAL MARGINS:
        // Top gap == topGap (48px)
        // Bottom gap == topGap (48px)
        // Left gap == (900 - 800) / 2 = 50px
        // Right gap == (900 - 800) / 2 = 50px
        // +2px safety buffer avoids 1px fractional rounding overflow in Chrome's print pagination
        const totalHeight = cardHeight + (topGap * 2) + 2;
        const totalWidth = 900;

        return { isProposal: true, totalWidth, totalHeight, marginZero: true };
      }

      // ── Invoice / Statement ───────────────────────────────────────────────
      const container = document.querySelector('.inv-container, .invoice, .statement')
        || document.body.firstElementChild
        || document.body;

      container.getBoundingClientRect();

      const cardHeight = Math.ceil(Math.max(
        container.getBoundingClientRect().height,
        container.scrollHeight,
        container.offsetHeight
      ));
      const cardWidth = Math.ceil(Math.max(
        container.getBoundingClientRect().width,
        container.scrollWidth,
        800
      ));

      // Equal 20px padding on all 4 sides: top, bottom, left, right
      const PAD = 20;
      return {
        isProposal: false,
        totalWidth: cardWidth + (PAD * 2),
        totalHeight: cardHeight + (PAD * 2),
        marginZero: false,
        topBottomMargin: PAD,
        sideMargin: PAD
      };
    });

    const pdfBuffer = await page.pdf({
      width: `${docInfo.totalWidth}px`,
      height: `${docInfo.totalHeight}px`,
      printBackground: true,
      preferCSSPageSize: false,
      margin: docInfo.marginZero
        ? { top: '0px', bottom: '0px', left: '0px', right: '0px' }
        : {
            top: `${docInfo.topBottomMargin}px`,
            bottom: `${docInfo.topBottomMargin}px`,
            left: `${docInfo.sideMargin}px`,
            right: `${docInfo.sideMargin}px`
          }
    });

    return Buffer.from(pdfBuffer);
  } finally {
    page.close().catch(() => {});
  }
}
