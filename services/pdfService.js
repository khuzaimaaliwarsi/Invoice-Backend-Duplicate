import puppeteer from 'puppeteer-core';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';

// Common Chrome/Chromium paths across platforms (Linux / Cloud / Docker / Windows / macOS)
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
      const output = execSync('which google-chrome-stable || which google-chrome || which chromium-browser || which chromium', {
        stdio: 'pipe'
      }).toString().trim().split('\n')[0];
      if (output && existsSync(output)) return output;
    } catch (e) {}
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
 * Generate a PDF Buffer from an HTML string using Puppeteer + system Chrome.
 * Fast, pixel-perfect, equal margins on all sides.
 */
export async function generatePdfFromHtml(htmlContent) {
  const browser = await getBrowser();
  const page = await getPage(browser);

  try {
    // Viewport: 900px wide (fits 800px proposal card with 50px each side)
    await page.setViewport({ width: 900, height: 5000, deviceScaleFactor: 2 });

    // domcontentloaded = instant (CSS/fonts are inline in our HTML templates)
    await page.setContent(htmlContent, { waitUntil: 'domcontentloaded' });
    await page.emulateMediaType('print');

    // Small delay for layout engine to settle
    await new Promise((r) => setTimeout(r, 40));

    const docInfo = await page.evaluate(() => {
      const isProposal = !!(
        document.querySelector('.a4-page') ||
        document.querySelector('.proposal-doc, .proposal-container, .proposal-root, .proposal')
      );
      const container = document.querySelector('.a4-page, .inv-container, .invoice, .statement')
        || document.body.firstElementChild
        || document.body;

      container.getBoundingClientRect(); // force layout recalc

      if (isProposal) {
        // Proposal body CSS: padding: 24px 0 (top & bottom)
        // Card: 800px, margin: 0 auto → 50px each side in 900px viewport
        // scrollHeight already includes body padding-top (24px) + content + body padding-bottom (24px)
        const scrollH = Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight,
          container.scrollHeight + 48
        );
        // Add just 4px safety buffer — body padding (24px) handles top & bottom equally
        const totalHeight = Math.ceil(scrollH) + 4;
        const totalWidth  = 900; // must equal viewport width for zero clipping
        return { isProposal, totalWidth, totalHeight, marginZero: true };
      }

      // Invoice / Statement
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
      const pad = 20; // equal padding on all sides
      return {
        isProposal,
        totalWidth:  cardWidth  + pad * 2,
        totalHeight: cardHeight + pad * 2,
        marginZero: false,
        topBottomMargin: pad,
        sideMargin: pad
      };
    });

    const pdfBuffer = await page.pdf({
      width:           `${docInfo.totalWidth}px`,
      height:          `${docInfo.totalHeight}px`,
      printBackground: true,
      preferCSSPageSize: false,
      margin: docInfo.marginZero
        ? { top: '0px', bottom: '0px', left: '0px', right: '0px' }
        : {
            top:    `${docInfo.topBottomMargin}px`,
            bottom: `${docInfo.topBottomMargin}px`,
            left:   `${docInfo.sideMargin}px`,
            right:  `${docInfo.sideMargin}px`
          }
    });

    return Buffer.from(pdfBuffer);
  } finally {
    page.close().catch(() => {});
  }
}
