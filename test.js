// test.js
const axios = require('axios');
const cheerio = require('cheerio');

const TEST_URL = 'https://honda-tech.com/forums/honda-accord-1990-2002-2/';
const LINK_SELECTOR = ".structItem-title > a";

async function runTest() {
    try {
        console.log(`Requesting ${TEST_URL}...`);
        
        // Add a realistic User-Agent header. This is a very common fix.
        const response = await axios.get(TEST_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        console.log(`Status Code: ${response.status}`);
        console.log(`Received ${response.data.length} bytes of data.`);

        const $ = cheerio.load(response.data);
        const linksFound = $(LINK_SELECTOR);

        console.log(`Cheerio found ${linksFound.length} links using the selector.`);

        if (linksFound.length > 0) {
            console.log("First link found:", linksFound.first().text().trim());
        }

    } catch (error) {
        console.error("Test failed:", error.message);
    }
}

runTest();