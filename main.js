// multithreaded scraper

const fs = require('fs').promises;
const path = require('path');
const { Worker } = require('worker_threads');

// --- Config ---
const TARGETS_FILE = 'targets.json';
const WORKER_COUNT = 4;
const UI_REFRESH = 250; // screen refresh speed

// --- Live Stats ---
let workers = [];
let totalJobs = 0;
let jobsDone = 0;
let foundCount = 0;
let uiInterval;

// for colors
const color = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
};

// draws the dashboard
function renderDashboard() {
    console.clear();
    console.log(`${color.cyan}--- Multithreaded Scraper Dashboard ---${color.reset}`);
    console.log(`Progress: ${jobsDone} / ${totalJobs} targets processed | Total Relevant Found: ${color.green}${foundCount}${color.reset}\n`);

    workers.forEach(state => {
        let statusColor = color.yellow;
        if (state.status === 'finished') statusColor = color.green;
        if (state.status === 'error') statusColor = color.red;

        const workerId = `[Worker ${state.id}]`.padEnd(11);
        const sourceName = `(${state.sourceName})`.padEnd(20);
        const status = `[${state.status.toUpperCase()}]`.padEnd(12);
        
        console.log(`${workerId} ${sourceName} ${statusColor}${status}${color.reset} ${state.message}`);
    });

    console.log("\n(Press Ctrl+C to stop)");
}

// --- Main ---
async function main() {
    console.log(`--> Starting up...`);

    try {
        const targets = JSON.parse(await fs.readFile(TARGETS_FILE, 'utf8'));
        const workQueue = [...targets];
        totalJobs = targets.length;

        // setup initial worker states
        for (let i = 0; i < WORKER_COUNT; i++) {
            workers.push({
                id: i + 1, sourceName: 'Idle', status: 'idle', message: 'Waiting for a task...'
            });
        }
        
        // start drawing the UI
        uiInterval = setInterval(renderDashboard, UI_REFRESH);

        const allWorkFinished = new Promise((resolve, reject) => {
            
            // gives a worker a new task if there's any left
            const startTaskOnWorker = (workerId) => {
                if (workQueue.length === 0) {
                    workers[workerId - 1].status = 'finished';
                    workers[workerId - 1].message = 'All tasks complete.';
                    // check if everyone is done
                    if (workers.every(w => w.status === 'finished')) {
                        resolve();
                    }
                    return;
                }

                const target = workQueue.shift();
                workers[workerId - 1] = { ...workers[workerId - 1], sourceName: target.sourceName, status: 'starting', message: `Scraping ${target.sourceName}` };

                const worker = new Worker(path.join(__dirname, 'worker.js'), {
                    workerData: { target, workerId }
                });
                
                // listen for progress updates
                worker.on('message', (update) => {
                    workers[workerId - 1] = { ...workers[workerId - 1], ...update };
                    if (update.stats && update.stats.newRelevantFound) {
                        foundCount += update.stats.newRelevantFound;
                    }
                });

                // when a worker is done, give it more work
                worker.on('exit', (code) => {
                    jobsDone++;
                    if (code !== 0) {
                        workers[workerId - 1].status = 'error';
                        workers[workerId - 1].message = `Exited with error code ${code}`;
                    } else {
                        // get next job
                        startTaskOnWorker(workerId);
                    }
                });
                
                // handle bad errors
                worker.on('error', (err) => {
                    workers[workerId - 1].status = 'error';
                    workers[workerId - 1].message = err.message;
                    reject(err);
                });
            };
            
            // start all workers
            for (let i = 1; i <= WORKER_COUNT; i++) {
                startTaskOnWorker(i);
            }
        });

        await allWorkFinished;

    } catch (error) {
        console.error("\n--- MAIN PROCESS FAILED ---", error.message);
    } finally {
        // cleanup
        clearInterval(uiInterval);
        renderDashboard(); // final render
        console.log("\n--> All targets have been processed. Main process finished.");
    }
}

main();