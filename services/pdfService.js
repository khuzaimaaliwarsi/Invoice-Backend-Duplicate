import puppeteer from 'puppeteer-core';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';

// Common Chrome/Chromium paths across platforms (Linux / Cloud / Docker / Windows / macOS)
const CHROME_PATHS = [
  // Explicit env overrides
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  // Linux / Debian / Ubuntu / Render / Railway / Docker / Alpine
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/lib/chromium/chromium',
  '/usr/lib/chromium-browser/chromium-browser',
  '/snap/bin/chromium',
  '/app/.apt/usr/bin/google-chrome',
  '/app/.apt/usr/bin/google-chrome-stable',
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Users\\' + (process.env.USERNAME || 'hp') + '\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Chromium\\Application\\chromium.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_PATHS) {
    if (existsSync(p)) return p;
  }
  // If running on POSIX / Linux, try system PATH lookup
  if (os.platform() !== 'win32') {
    try {
      const output = execSync('which google-chrome-stable || which google-chrome || which chromium-browser || which chromium', {
        stdio: 'pipe'
      }).toString().trim().split('\n')[0];
      if (output && existsSync(output)) return output;
    } catch (e) {
      // ignore
    }
  }
  return null;
}

let cachedBrowser = null;
let browserLaunchPromise = null;

export async function getBrowser() {
  if (cachedBrowser && cachedBrowser.connected !== false) {
    return cachedBrowser;
  }

  if (browserLaunchPromise) {
    return browserLaunchPromise;
  }

  const executablePath = findChrome();
  if (!executablePath) {
    throw new Error('Chrome/Edge not found on this system. Please install Google Chrome.');
  }

  browserLaunchPromise = puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-breakpad',
      '--disable-client-side-phishing-detection',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-hang-monitor',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--mute-audio',
      '--safebrowsing-disable-auto-update'
    ]
  }).then((browser) => {
    cachedBrowser = browser;
    browserLaunchPromise = null;
    browser.on('disconnected', () => {
      cachedBrowser = null;
    });
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
    // Pre-warm next page in the background asynchronously
    browser.newPage().then(nextPage => {
      warmPage = nextPage;
    }).catch(() => {});
    return p;
  }
  // If no warm page ready yet, create one and also schedule next
  const page = await browser.newPage();
  browser.newPage().then(nextPage => {
    warmPage = nextPage;
  }).catch(() => {});
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
 * Generate a PDF Buffer from an HTML string using Puppeteer + system Chrome.
 * Uses pre-warmed persistent browser & pages for near-instant rendering (< 80ms).
 * @param {string} htmlContent - Full HTML document
 * @returns {Promise<Buffer>} PDF Buffer
 */
export async function generatePdfFromHtml(htmlContent) {
  const browser = await getBrowser();
  const page = await getPage(browser);

  try {
    // Use a very tall viewport so nothing is clipped during layout/measurement
    await page.setViewport({ width: 900, height: 5000, deviceScaleFactor: 2 });
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    await page.emulateMediaType('print');

    // Wait for fonts & deferred CSS to fully settle
    await new Promise((r) => setTimeout(r, 150));

    // Detect document type and measure exact element size
    const docInfo = await page.evaluate(() => {
      // .a4-page = Proposal, .proposal-* = legacy, anything else = Invoice/Statement
      const isProposal = !!(
        document.querySelector('.a4-page') ||
        document.querySelector('.proposal-doc, .proposal-container, .proposal-root, .proposal')
      );
      const container = document.querySelector('.a4-page, .inv-container, .invoice, .statement') || document.body.firstElementChild || document.body;

      // Force layout recalc
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

      if (isProposal) {
        // Capture full document scroll height so NOTHING gets cut off
        const scrollH = Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight,
          container.scrollHeight,
          container.offsetHeight + 48
        );
        const totalHeight = Math.ceil(scrollH) + 48; // generous bottom padding
        const totalWidth = 860; // 800px card + 30px each side
        return { isProposal, totalWidth, totalHeight, marginZero: true };
      }

      // Invoice / Statement framing
      const topBottomMargin = 18;
      const sideMargin = 8;
      const totalHeight = cardHeight + (topBottomMargin * 2) + 20; // +20 safety buffer
      const totalWidth = cardWidth + (sideMargin * 2);
      return { isProposal, totalWidth, totalHeight, marginZero: false, topBottomMargin, sideMargin };
    });

    const pdfBuffer = await page.pdf({
      width: `${docInfo.totalWidth}px`,
      height: `${docInfo.totalHeight}px`,
      printBackground: true,
      preferCSSPageSize: false,
      margin: docInfo.marginZero ? {
        top: '0px',
        bottom: '0px',
        left: '0px',
        right: '0px'
      } : {
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
