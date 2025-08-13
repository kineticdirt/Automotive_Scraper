// The Scraper Worker ("Stealth" Version)

const fs = require('fs').promises;
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const { Pool } = require('pg');
const cliProgress = require('cli-progress');
const { parentPort, workerData } = require('worker_threads');

// Apply the stealth plugin to make Puppeteer look more like a real user
puppeteer.use(StealthPlugin());

// --- Configuration & State ---
const CONCURRENCY_LIMIT = 3; // Using a full browser is heavy, so we reduce concurrency.
const { target, workerId } = workerData;
let isShuttingDown = false;

// --- Database Connection Pool ---
const pgPool = new Pool({
    user: process.env.DB_USER || 'automotive_scraper_app',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'automotive_db',
    password: process.env.DB_PASSWORD || 'automotive',
    port: process.env.DB_PORT || 5432,
});

// --- Helper Functions ---
function updateManagerStatus(status, message, stats = {}) {
    parentPort.postMessage({ workerId, status, message, stats });
}

// --- Main Worker Logic ---
async function run() {
    process.on('SIGINT', () => { isShuttingDown = true; });

    // Launch a single, persistent browser for this worker to use.
    const browser = await puppeteer.launch({ headless: true });

    try {
        await processTarget(target, browser);
    } catch (error) {
        updateManagerStatus('error', `Critical error: ${error.message}`);
        // Create a debug directory if it doesn't exist
        await fs.mkdir('debug', { recursive: true });
        await fs.writeFile(`debug/worker_${workerId}_critical_error.txt`, error.stack, 'utf8');
        process.exit(1);
    } finally {
        await browser.close();
        await pgPool.end();
    }
}

async function processTarget(target, browser) {
    let currentPageUrl = target.startUrl;
    let pageCount = 1;
    let totalRelevantInTarget = 0;
    const page = await browser.newPage(); // This is our main tab for browsing forum pages.
    await page.setViewport({ width: 1920, height: 1080 }); // Appear as a standard desktop browser.

    while (currentPageUrl && !isShuttingDown) {
        try {
            updateManagerStatus('scraping', `Navigating to Page ${pageCount}`);
            await page.goto(currentPageUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            const html = await page.content();
            const $ = cheerio.load(html);

            const threadLinks = [];
            $(target.threadLinkSelector).each((i, element) => {
                const title = $(element).text().trim();
                const url = $(element).attr('href');
                if (title && url) {
                    threadLinks.push({ title, url: new URL(url, target.startUrl).href });
                }
            });

            if (threadLinks.length > 0) {
                updateManagerStatus('processing', `Page ${pageCount}: Found ${threadLinks.length} threads.`);
                
                const progressBar = new cliProgress.SingleBar({
                    format: `[Worker ${workerId} | ${target.sourceName}] Page ${pageCount} [{bar}] {percentage}% | Found: {relevant} | {title}`,
                }, cliProgress.Presets.shades_classic);
                progressBar.start(threadLinks.length, 0, { relevant: totalRelevantInTarget, title: "Initializing..." });

                for (let i = 0; i < threadLinks.length; i += CONCURRENCY_LIMIT) {
                    if (isShuttingDown) break;
                    const chunk = threadLinks.slice(i, i + CONCURRENCY_LIMIT);
                    // We pass the main browser instance to the scraper function.
                    const promises = chunk.map(thread => scrapeThreadIfRelevant(thread, target, browser));
                    const results = await Promise.allSettled(promises);

                    let lastTitleInChunk = "N/A";
                    for (const result of results) {
                        if (result.status === 'fulfilled' && result.value) {
                            if (result.value.isRelevant) {
                                totalRelevantInTarget++;
                                updateManagerStatus('processing', `Page ${pageCount} Update`, { newRelevantFound: 1 });
                            }
                            lastTitleInChunk = result.value.title;
                        }
                    }
                    progressBar.increment(chunk.length, { relevant: totalRelevantInTarget, title: lastTitleInChunk.substring(0, 45) });
                }
                progressBar.stop();
            }

            const nextPageHref = $(target.nextPageSelector).attr('href');
            if (nextPageHref && !isShuttingDown) {
                currentPageUrl = new URL(nextPageHref, target.startUrl).href;
                pageCount++;
            } else {
                currentPageUrl = null;
            }
        } catch (error) {
            console.error(`\n[Worker ${workerId}] Failed on page ${currentPageUrl}: ${error.message}`);
            currentPageUrl = null;
        }
    }
    await page.close();
}

// This is the new "smart" scraper function. It opens a new browser tab for each thread.
async function scrapeThreadIfRelevant(thread, target, browser) {
    let threadPage;
    try {
        // Using a new tab for each thread provides isolation.
        threadPage = await browser.newPage();
        await threadPage.setViewport({ width: 1920, height: 1080 });
        await threadPage.goto(thread.url, { waitUntil: 'networkidle2', timeout: 45000 });
        const html = await threadPage.content();
        const $ = cheerio.load(html);

        let postText = "";
        // Try every possible selector until we find one that returns content.
        for (const selector of target.postContentSelectors) {
            postText = $(selector).first().text();
            if (postText) break; // Found it, stop trying other selectors.
        }
        
        // If we still have no text, something is wrong. Save a debug snapshot.
        if (!postText) {
            await fs.mkdir('debug', { recursive: true });
            await threadPage.screenshot({ path: `debug/${target.sourceName}_no_content_found.png` });
            await fs.writeFile(`debug/${target.sourceName}_no_content_found.html`, html, 'utf8');
            return { isRelevant: false, title: thread.title };
        }

        const isRelevant = target.keywords.some(kw => postText.toLowerCase().includes(kw.toLowerCase()));

        if (isRelevant) {
            const insertQuery = `
                INSERT INTO scraped_threads (source_forum, thread_title, thread_url, post_text)
                VALUES ($1, $2, $3, $4) ON CONFLICT (thread_url) DO NOTHING;
            `;
            await pgPool.query(insertQuery, [target.sourceName, thread.title, thread.url, postText.trim()]);
        }
        return { isRelevant, title: thread.title };
    } catch (error) {
        return { isRelevant: false, title: `[ERROR] ${thread.title}` };
    } finally {
        // This is crucial to prevent memory leaks from hundreds of open tabs.
        if (threadPage) await threadPage.close();
    }
}

run();