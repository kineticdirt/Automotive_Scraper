// The Multithreaded Scraper Manager (Dashboard Version)

const fs = require('fs').promises;
const path = require('path');
const { Worker } = require('worker_threads');

// --- Script Configuration ---
// These are the core settings for the scraper operation.
const CONFIG_FILE = 'targets.json';
const NUM_WORKERS = 4;
const REFRESH_INTERVAL = 250; // The screen refresh rate for the dashboard, in milliseconds.

// --- Application State ---
// These variables hold the live data for the dashboard. They are updated by worker events.
let workerStates = [];
let totalTargets = 0;
let completedTargets = 0;
let totalRelevantFound = 0;
let renderInterval;

// --- Helper: Terminal Colors ---
const color = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
};

// This function is our "view" layer. It clears the console and redraws the entire
// dashboard based on the current data held in the `workerStates` array.
function renderDashboard() {
    console.clear();
    console.log(`${color.cyan}--- Multithreaded Scraper Dashboard ---${color.reset}`);
    console.log(`Progress: ${completedTargets} / ${totalTargets} targets processed | Total Relevant Found: ${color.green}${totalRelevantFound}${color.reset}\n`);

    workerStates.forEach(state => {
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

// --- Main Execution Logic ---
async function main() {
    console.log(`--> Initializing Scraper Manager...`);

    try {
        const targets = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
        const targetsQueue = [...targets];
        totalTargets = targets.length;

        // Initialize the data model for the dashboard view.
        for (let i = 0; i < NUM_WORKERS; i++) {
            workerStates.push({
                id: i + 1, sourceName: 'Idle', status: 'idle', message: 'Waiting for a task...'
            });
        }
        
        // Start the UI refresh loop.
        renderInterval = setInterval(renderDashboard, REFRESH_INTERVAL);

        // This promise resolves only when all targets in the queue have been processed by the workers.
        const allWorkDone = new Promise((resolve, reject) => {
            
            // This is the core of our dynamic pool. A worker calls this function when it finishes a task.
            // It checks if there's more work in the queue and, if so, starts a new task on the same worker thread.
            // This ensures workers are always busy if there's work to do.
            const launchWorkerIfNeeded = (workerId) => {
                if (targetsQueue.length === 0) {
                    workerStates[workerId - 1].status = 'finished';
                    workerStates[workerId - 1].message = 'All tasks complete.';
                    // If all workers have reported that the queue is empty, we're done.
                    if (workerStates.every(w => w.status === 'finished')) {
                        resolve();
                    }
                    return;
                }

                const target = targetsQueue.shift();
                workerStates[workerId - 1] = { ...workerStates[workerId - 1], sourceName: target.sourceName, status: 'starting', message: `Initializing scrape for ${target.sourceName}` };

                const worker = new Worker(path.join(__dirname, 'worker.js'), {
                    workerData: { target, workerId }
                });
                
                // Handles status updates from a worker (e.g., "Page 1: Found 33 threads").
                worker.on('message', (update) => {
                    workerStates[workerId - 1] = { ...workerStates[workerId - 1], ...update };
                    if (update.stats && update.stats.newRelevantFound) {
                        totalRelevantFound += update.stats.newRelevantFound;
                    }
                });

                // This is the most important part of the pool. When a worker finishes its current target,
                // we immediately tell it to try and get another one from the queue.
                worker.on('exit', (code) => {
                    completedTargets++;
                    if (code !== 0) {
                        workerStates[workerId - 1].status = 'error';
                        workerStates[workerId - 1].message = `Exited with error code ${code}`;
                    } else {
                        // This worker is now free. Recursively call the launch function to get more work.
                        launchWorkerIfNeeded(workerId);
                    }
                });
                
                // Handles critical, unrecoverable errors from a worker.
                worker.on('error', (err) => {
                    workerStates[workerId - 1].status = 'error';
                    workerStates[workerId - 1].message = err.message;
                    reject(err);
                });
            };
            
            // Kick off the process by telling all workers in the pool to start looking for tasks.
            for (let i = 1; i <= NUM_WORKERS; i++) {
                launchWorkerIfNeeded(i);
            }
        });

        await allWorkDone;

    } catch (error) {
        console.error("\n--- A CRITICAL MANAGER ERROR OCCURRED ---", error.message);
    } finally {
        // This cleanup is crucial to prevent the script from hanging on exit.
        clearInterval(renderInterval);
        renderDashboard(); // Perform one final render to show the finished state.
        console.log("\n--> All targets have been processed. Main process finished.");
    }
}

main();