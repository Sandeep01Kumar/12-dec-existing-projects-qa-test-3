'use strict';                                                              // SK
// SK
const { spawn } = require('node:child_process');                           // SK
const path = require('node:path');                                         // SK
// SK
const BASE_URL = 'http://127.0.0.1:3000';                                  // SK
const EXPECTED_ROOT_BODY = 'Hello, World!\n';                              // SK
const EXPECTED_EVENING_BODY = 'Good evening';                              // SK
// SK
const READY_LINE = 'Server running at http://127.0.0.1:3000/';             // SK
const STARTUP_TIMEOUT_MS = 10000;                                          // SK
const REPO_ROOT = path.resolve(__dirname, '..', '..');                     // SK
// SK
let child = null;                                                          // SK
// SK
function startServer() {                                                   // SK
  return new Promise((resolve, reject) => {                                // SK
    child = spawn('node', ['server.js'], { cwd: REPO_ROOT });              // SK
    let stdoutBuffer = '';                                                 // SK
    let settled = false;                                                   // SK
    const timer = setTimeout(() => {                                       // SK
      if (settled) return;                                                 // SK
      settled = true;                                                      // SK
      reject(new Error('Server startup timed out after ' + STARTUP_TIMEOUT_MS + 'ms')); // SK
    }, STARTUP_TIMEOUT_MS);                                                // SK
    child.stdout.on('data', (chunk) => {                                   // SK
      stdoutBuffer += chunk.toString();                                    // SK
      if (!settled && stdoutBuffer.includes(READY_LINE)) {                 // SK
        settled = true;                                                    // SK
        clearTimeout(timer);                                               // SK
        resolve(child);                                                    // SK
      }                                                                    // SK
    });                                                                    // SK
    child.on('error', (err) => {                                           // SK
      if (settled) return;                                                 // SK
      settled = true;                                                      // SK
      clearTimeout(timer);                                                 // SK
      reject(err);                                                         // SK
    });                                                                    // SK
    child.on('exit', (code) => {                                           // SK
      if (settled) return;                                                 // SK
      settled = true;                                                      // SK
      clearTimeout(timer);                                                 // SK
      reject(new Error('Server process exited before readiness (code ' + code + ')')); // SK
    });                                                                    // SK
  });                                                                      // SK
}                                                                          // SK
// SK
function stopServer() {                                                    // SK
  return new Promise((resolve) => {                                        // SK
    if (!child || child.exitCode !== null || child.signalCode !== null) {  // SK
      resolve();                                                           // SK
      return;                                                              // SK
    }                                                                      // SK
    child.once('exit', () => resolve());                                   // SK
    child.kill('SIGTERM');                                                 // SK
  });                                                                      // SK
}                                                                          // SK
// SK
module.exports = {                                                         // SK
  startServer,                                                             // SK
  stopServer,                                                              // SK
  BASE_URL,                                                                // SK
  EXPECTED_ROOT_BODY,                                                      // SK
  EXPECTED_EVENING_BODY,                                                   // SK
};                                                                         // SK
