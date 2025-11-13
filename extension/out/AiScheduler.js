"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initScheduler = initScheduler;
exports.runAI = runAI;
let jobQueue = [];
let isRunning = false;
let lastCallTime = 0;
const MIN_DELAY = 21000; // 21 seconds for 3 RPM model
let statusBarItem = null;
let cooldownInterval = null;
function initScheduler(statusItem) {
    statusBarItem = statusItem;
}
async function runAI(fn, priority = 1) {
    return new Promise((resolve, reject) => {
        jobQueue.push({ fn, resolve, reject, priority });
        jobQueue.sort((a, b) => b.priority - a.priority);
        processQueue();
    });
}
async function processQueue() {
    if (isRunning)
        return;
    if (jobQueue.length === 0)
        return;
    const now = Date.now();
    const diff = now - lastCallTime;
    if (diff < MIN_DELAY) {
        const wait = MIN_DELAY - diff;
        startCooldown(wait);
        await sleep(wait);
    }
    stopCooldown();
    const job = jobQueue.shift();
    if (!job)
        return;
    isRunning = true;
    try {
        const result = await job.fn();
        lastCallTime = Date.now();
        job.resolve(result);
    }
    catch (err) {
        job.reject(err);
    }
    isRunning = false;
    if (jobQueue.length > 0)
        processQueue();
}
function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
}
function startCooldown(ms) {
    if (!statusBarItem)
        return;
    let remaining = Math.ceil(ms / 1000);
    statusBarItem.text = `⏳ AI Cooldown: ${remaining}s`;
    cooldownInterval = setInterval(() => {
        remaining--;
        if (remaining <= 0)
            return stopCooldown();
        statusBarItem.text = `⏳ AI Cooldown: ${remaining}s`;
    }, 1000);
}
function stopCooldown() {
    if (!statusBarItem)
        return;
    if (cooldownInterval)
        clearInterval(cooldownInterval);
    cooldownInterval = null;
    statusBarItem.text = "$(check) AI Ready";
}
//# sourceMappingURL=AiScheduler.js.map