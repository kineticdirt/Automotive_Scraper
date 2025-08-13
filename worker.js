// worker scraper

const fs = require('fs').promises;
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const { Pool } = require('pg');
const cliProgress = require('cli-progress');
const { parentPort, workerData } = require('worker_threads');

// use stealth
puppeteer.use(StealthPlugin());

// --- Config ---
const MAX_TABS = 3; // browser is heavy, keep this low
const { target, workerId } = workerData;
let shuttingDown = false;

// --- DB Stuff ---
const db = new Pool({
    user: process.env.DB_USER || 'automotive_scraper_app',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'automotive_db',
    password: process.env.DB_PASSWORD || 'automotive',
    port: process.env.DB_PORT || 5432,
});

// --- Helpers ---
function sendStatus(status, message, stats = {}) {
    parentPort.postMessage({ workerId, status, message, stats });
}

// --- Main ---
async function run() {
    process.on('SIGINT', () => { shuttingDown = true; });

    // start one browser for this worker
    const browser = await puppeteer.launch({ headless: true });

    try {
        await scrapeSite(target, browser);
    } catch (error) {
        sendStatus('error', `Critical error: ${error.message}`);
        // save debug file
        await fs.mkdir('debug', { recursive: true });
        await fs.writeFile(`debug/worker_${workerId}_critical_error.txt`, error.stack, 'utf8');
        process.exit(1);
    } finally {
        await browser.close();
        await db.end();
    }
}

async function scrapeSite(target, browser) {
    let currentUrl = target.startUrl;
    let pageNum = 1;
    let relevantCount = 0;
    const page = await browser.newPage(); // main tab
    await page.setViewport({ width: 1920, height: 1080 }); // look like a normal user

    while (currentUrl && !shuttingDown) {
        try {
            sendStatus('scraping', `Navigating to Page ${pageNum}`);
            await page.goto(currentUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            const html = await page.content();
            const $ = cheerio.load(html);

            const links = [];
            $(target.threadLinkSelector).each((i, element) => {
                const title = $(element).text().trim();
                const url = $(element).attr('href');
                if (title && url) {
                    links.push({ title, url: new URL(url, target.startUrl).href });
                }
            });

            if (links.length > 0) {
                sendStatus('processing', `Page ${pageNum}: Found ${links.length} threads.`);
                
                const bar = new cliProgress.SingleBar({
                    format: `[Worker ${workerId} | ${target.sourceName}] Page ${pageNum} [{bar}] {percentage}% | Found: {relevant} | {title}`,
                }, cliProgress.Presets.shades_classic);
                bar.start(links.length, 0, { relevant: relevantCount, title: "Initializing..." });

                for (let i = 0; i < links.length; i += MAX_TABS) {
                    if (shuttingDown) break;
                    const chunk = links.slice(i, i + MAX_TABS);
                    // pass browser instance to scraper func
                    const promises = chunk.map(thread => checkThread(thread, target, browser));
                    const results = await Promise.allSettled(promises);

                    let lastTitle = "N/A";
                    for (const result of results) {
                        if (result.status === 'fulfilled' && result.value) {
                            if (result.value.isRelevant) {
                                relevantCount++;
                                sendStatus('processing', `Page ${pageNum} Update`, { newRelevantFound: 1 });
                            }
                            lastTitle = result.value.title;
                        }
                    }
                    bar.increment(chunk.length, { relevant: relevantCount, title: lastTitle.substring(0, 45) });
                }
                bar.stop();
            }

            const nextPageLink = $(target.nextPageSelector).attr('href');
            if (nextPageLink && !shuttingDown) {
                currentUrl = new URL(nextPageLink, target.startUrl).href;
                pageNum++;
            } else {
                currentUrl = null; // no more pages
            }
        } catch (error) {
            console.error(`\n[Worker ${workerId}] Failed on page ${currentUrl}: ${error.message}`);
            currentUrl = null; // stop on error
        }
    }
    await page.close();
}

// this opens a new tab for each thread
async function checkThread(thread, target, browser) {
    let tab;
    try {
        // new tab for each thread for safety
        tab = await browser.newPage();
        await tab.setViewport({ width: 1920, height: 1080 });
        await tab.goto(thread.url, { waitUntil: 'networkidle2', timeout: 45000 });
        const html = await tab.content();
        const $ = cheerio.load(html);

        let text = "";
        // try to find post text
        for (const selector of target.postContentSelectors) {
            text = $(selector).first().text();
            if (text) break; // found it
        }
        
        // if no text, save debug html/screenshot
        if (!text) {
            await fs.mkdir('debug', { recursive: true });
            await tab.screenshot({ path: `debug/${target.sourceName}_no_content_found.png` });
            await fs.writeFile(`debug/${target.sourceName}_no_content_found.html`, html, 'utf8');
            return { isRelevant: false, title: thread.title };
        }

        const isRelevant = target.keywords.some(kw => text.toLowerCase().includes(kw.toLowerCase()));

        if (isRelevant) {
            const query = `
                INSERT INTO scraped_threads (source_forum, thread_title, thread_url, post_text)
                VALUES ($1, $2, $3, $4) ON CONFLICT (thread_url) DO NOTHING;
            `;
            await db.query(query, [target.sourceName, thread.title, thread.url, text.trim()]);
        }
        return { isRelevant, title: thread.title };
    } catch (error) {
        return { isRelevant: false, title: `[ERROR] ${thread.title}` };
    } finally {
        // MUST close tab to prevent memory leaks
        if (tab) await tab.close();
    }
}

run();