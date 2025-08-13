-- schema.sql
-- Scripts for running the Automotive Scraper database schema.

CREATE TABLE IF NOT EXISTS scraped_threads (
    id SERIAL PRIMARY KEY,
    source_forum VARCHAR(255),
    thread_title TEXT,
    thread_url VARCHAR(2048) UNIQUE,
    post_text TEXT,
    discovered_at TIMESTAMPTZ DEFAULT NOW()
);

