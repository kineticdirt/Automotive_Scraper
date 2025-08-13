// Generic Forum Scraper Engine with Dashboard Progress and Graceful Shutdown

const fs = require('fs').promises;
const axios = require('axios');
const cheerio = require('cheerio');
const { Pool } = require('pg');
const cliProgress = require('cli-progress'); // The progress bar library

// --- Configuration ---
const CONFIG_FILE = 'targets.json';
const CONCURRENCY_LIMIT = 5;

// --- Global State ---
let isShuttingDown = false;
let totalRelevantThreads = 0; // Running total of relevant threads found

// --- Database Configuration ---
const pgPool = new Pool({
    user: process.env.DB_USER || 'automotive_scraper_app',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'automotive_db',
    password: process.env.DB_PASSWORD || 'automotive',
    port: process.env.DB_PORT || 5432,
});

// --- Main Execution Logic ---
async function main() {
    console.log("--> Starting Generic Scraper Engine...");
    console.log("    (Press Ctrl+C at any time to shut down gracefully)");

    // Graceful Shutdown Handler
    process.on('SIGINT', () => {
        if (isShuttingDown) {
            console.log("\nForcing immediate exit.");
            process.exit(1);
        }
        console.log("\n\n--> Shutdown signal received. Finishing current tasks, then exiting...");
        isShuttingDown = true;
    });

    try {
        const targets = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
        console.log(`--> Found ${targets.length} targets in ${CONFIG_FILE}.`);

        for (const target of targets) {
            if (isShuttingDown) break;
            await processTarget(target);
        }

    } catch (error) {
        if (!isShuttingDown) {
            console.error("\n--- A CRITICAL ERROR OCCURRED ---", error.message);
        }
    } finally {
        await pgPool.end();
        console.log("\n--> Process Complete. Database connection pool closed.");
    }
}

// Processes a single target from the config file, handling pagination.
async function processTarget(target) {
    console.log(`\n--------------------------------------------------`);
    console.log(`Processing Target: ${target.sourceName}`);
    console.log(`--------------------------------------------------`);

    let currentPageUrl = target.startUrl;
    let pageCount = 1;
    totalRelevantThreads = 0; // Reset for each new target

    while (currentPageUrl && !isShuttingDown) {
        try {
            const { data } = await axios.get(currentPageUrl, { headers: { 'User-Agent': 'MyGenericScraper/2.0' } });
            const $ = cheerio.load(data);

            const threadLinks = [];
            $(target.threadLinkSelector).each((i, element) => {
                const title = $(element).text().trim();
                const url = $(element).attr('href');
                if (title && url) {
                    threadLinks.push({ title, url: new URL(url, target.startUrl).href });
                }
            });

            if (threadLinks.length > 0) {
                console.log(`\n[Page ${pageCount}] Found ${threadLinks.length} threads. Scraping...`);
                
                // --- Dashboard Progress Bar Setup ---
                const progressBar = new cliProgress.SingleBar({
                    // The format defines our multi-part "dashboard"
                    format: 'Page Progress [{bar}] {percentage}% | Total Relevant: {relevant} | Current: {title}',
                    etaBuffer: 2000,
                    hideCursor: true
                }, cliProgress.Presets.shades_classic);

                progressBar.start(threadLinks.length, 0, {
                    relevant: totalRelevantThreads,
                    title: "Initializing..."
                });

                // Concurrently scrape and process threads in chunks
                for (let i = 0; i < threadLinks.length; i += CONCURRENCY_LIMIT) {
                    if (isShuttingDown) break;
                    const chunk = threadLinks.slice(i, i + CONCURRENCY_LIMIT);
                    const promises = chunk.map(thread => scrapeThreadIfRelevant(thread, target));
                    const results = await Promise.allSettled(promises);

                    // Process results of the chunk to update totals
                    let lastTitleInChunk = "N/A";
                    for (const result of results) {
                        if (result.status === 'fulfilled' && result.value) {
                            if (result.value.isRelevant) {
                                totalRelevantThreads++;
                            }
                            lastTitleInChunk = result.value.title;
                        }
                    }
                    
                    // Update the progress bar with the latest running totals and title
                    progressBar.increment(chunk.length, {
                        relevant: totalRelevantThreads,
                        title: lastTitleInChunk.substring(0, 50) // Truncate title to fit
                    });
                }
                progressBar.stop();
            } else {
                console.log(`\n[Page ${pageCount}] No threads found on this page.`);
            }

            // Find the "Next Page" link
            const nextPageHref = $(target.nextPageSelector).attr('href');
            if (nextPageHref && !isShuttingDown) {
                currentPageUrl = new URL(nextPageHref, target.startUrl).href;
                pageCount++;
            } else {
                if (!isShuttingDown) console.log("\nFinished this target.");
                currentPageUrl = null;
            }
        } catch (error) {
            console.error(`\n    Failed to process page ${currentPageUrl}: ${error.message}`);
            currentPageUrl = null;
        }
    }
}

// Scrapes a thread, checks relevance, inserts into DB, and returns the result.
async function scrapeThreadIfRelevant(thread, target) {
    try {
        const { data } = await axios.get(thread.url, { headers: { 'User-Agent': 'MyGenericScraper/2.0' } });
        const $ = cheerio.load(data);

        const postText = $(target.postContentSelector).first().text();
        if (!postText) {
            return { isRelevant: false, title: thread.title };
        }

        const postTextLower = postText.toLowerCase();
        const isRelevant = target.keywords.some(kw => postTextLower.includes(kw.toLowerCase()));

        if (isRelevant) {
            const insertQuery = `
                INSERT INTO scraped_threads (source_forum, thread_title, thread_url, post_text)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (thread_url) DO NOTHING;
            `;
            await pgPool.query(insertQuery, [target.sourceName, thread.title, thread.url, postText.trim()]);
        }
        // Always return a result object for the progress bar
        return { isRelevant, title: thread.title };
    } catch (error) {
        // On error, still return a value so the progress bar doesn't stall
        return { isRelevant: false, title: `[ERROR] ${thread.title}` };
    }
}

main();