'use strict';                                                              // SK
// SK
// Shared server lifecycle helper for the greenfield node:test integration  // SK
// suite. Contract: spawn exactly one `node server.js` child process, resolve // SK
// once its stdout emits the readiness line, then tear it down deterministically. // SK
// Design invariants that make the helper safe under the failure modes the   // SK
// review flagged (startup timeout, concurrent starts, teardown races, and   // SK
// discarded startup diagnostics):                                           // SK
//   * SINGLE OWNER: at most one child is owned at a time; `state` serializes // SK
//     the lifecycle so a second start cannot orphan the first (server.js     // SK
//     binds a fixed port, so only one instance can ever run).               // SK
//   * INVOCATION-LOCAL IDENTITY: every startup callback closes over the      // SK
//     child returned by its own spawn() call, never the module global, so    // SK
//     ownership can never be cross-wired even if module state is reassigned. // SK
//   * BOUNDED SETTLEMENT: every settle path (success, timeout, spawn error,  // SK
//     premature exit, stop) runs once, clears its listeners/timers, and      // SK
//     terminates the owned child before rejecting, so no run leaks a process // SK
//     or holds loopback port 3000.                                          // SK
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
const STOP_TIMEOUT_MS = 5000;                                              // SK
const MAX_CAPTURE_BYTES = 8192;                                            // SK
const REPO_ROOT = path.resolve(__dirname, '..', '..');                     // SK
// SK
// Owned-child state. `child` is the one process this module currently owns   // SK
// (null when idle); `state` is one of 'idle' | 'starting' | 'running' |      // SK
// 'stopping' and serializes lifecycle operations against each other.         // SK
let child = null;                                                          // SK
let state = 'idle';                                                        // SK
// SK
// Append a stream chunk to a capture buffer while retaining at most          // SK
// MAX_CAPTURE_BYTES, so a chatty or looping child can never grow the buffer  // SK
// without bound (bounded diagnostics for startup failures).                 // SK
function appendCapture(buffer, chunk) {                                    // SK
  if (buffer.length >= MAX_CAPTURE_BYTES) {                                // SK
    return buffer;                                                         // SK
  }                                                                        // SK
  return (buffer + chunk.toString()).slice(0, MAX_CAPTURE_BYTES);          // SK
}                                                                          // SK
// SK
// Deterministically terminate a specific child and resolve once it is gone.  // SK
// Settles EXACTLY once across 'exit'/'close'/'error'; tolerates kill()       // SK
// throwing or returning false (undelivered signal); escalates SIGTERM ->     // SK
// SIGKILL after a grace window; and rejects with context on a hard deadline  // SK
// so teardown can never hang indefinitely. Always removes its listeners.     // SK
function terminateChild(target) {                                          // SK
  return new Promise((resolve, reject) => {                                // SK
    if (!target || target.exitCode !== null || target.signalCode !== null) { // SK
      resolve();                                                           // SK
      return;                                                              // SK
    }                                                                      // SK
    let finished = false;                                                  // SK
    let graceTimer = null;                                                 // SK
    let hardTimer = null;                                                  // SK
    function settle(err) {                                                 // SK
      if (finished) {                                                      // SK
        return;                                                            // SK
      }                                                                    // SK
      finished = true;                                                     // SK
      if (graceTimer) {                                                    // SK
        clearTimeout(graceTimer);                                          // SK
      }                                                                    // SK
      if (hardTimer) {                                                     // SK
        clearTimeout(hardTimer);                                           // SK
      }                                                                    // SK
      target.removeListener('exit', onDone);                               // SK
      target.removeListener('close', onDone);                              // SK
      target.removeListener('error', onError);                             // SK
      if (err) {                                                           // SK
        reject(err);                                                       // SK
      } else {                                                             // SK
        resolve();                                                         // SK
      }                                                                    // SK
    }                                                                      // SK
    function onDone() {                                                    // SK
      settle();                                                            // SK
    }                                                                      // SK
    function onError(err) {                                                // SK
      settle(err);                                                         // SK
    }                                                                      // SK
    target.once('exit', onDone);                                           // SK
    target.once('close', onDone);                                          // SK
    target.once('error', onError);                                         // SK
    // Hard deadline: guarantees settlement even if every signal is ignored, // SK
    // converting a would-be hang into an actionable rejection.              // SK
    hardTimer = setTimeout(function onHardDeadline() {                     // SK
      settle(new Error('Server did not terminate within ' + (STOP_TIMEOUT_MS * 2) + 'ms')); // SK
    }, STOP_TIMEOUT_MS * 2);                                               // SK
    try {                                                                  // SK
      const delivered = target.kill('SIGTERM');                           // SK
      if (delivered === false && target.exitCode === null && target.signalCode === null) { // SK
        target.kill('SIGKILL');                                           // SK
      }                                                                    // SK
    } catch (err) {                                                        // SK
      settle(err);                                                         // SK
      return;                                                              // SK
    }                                                                      // SK
    // Bounded graceful window: escalate to SIGKILL if the child ignores     // SK
    // SIGTERM and is still alive when the grace timer fires.                // SK
    graceTimer = setTimeout(function onGraceExpiry() {                     // SK
      if (target.exitCode !== null || target.signalCode !== null) {        // SK
        return;                                                            // SK
      }                                                                    // SK
      try {                                                                // SK
        target.kill('SIGKILL');                                           // SK
      } catch (err) {                                                      // SK
        settle(err);                                                       // SK
      }                                                                    // SK
    }, STOP_TIMEOUT_MS);                                                   // SK
  });                                                                      // SK
}                                                                          // SK
// SK
// Spawn `node server.js` (from the repository root so it resolves the app    // SK
// file and node_modules) and resolve with the ChildProcess once its ready    // SK
// line appears on stdout. Rejects AFTER bounded cleanup on startup timeout,  // SK
// spawn error, or premature exit, attaching captured stderr/stdout as        // SK
// diagnostics. Refuses to start while another instance is starting, running, // SK
// or stopping (single-owner serialization).                                 // SK
function startServer() {                                                   // SK
  if (state !== 'idle') {                                                  // SK
    return Promise.reject(new Error('Server already ' + state + '; refusing concurrent start')); // SK
  }                                                                        // SK
  state = 'starting';                                                      // SK
  return new Promise((resolve, reject) => {                                // SK
    // Invocation-local handle used by EVERY callback below, so ownership     // SK
    // is never confused with a later start's child.                         // SK
    const spawnedChild = spawn('node', ['server.js'], { cwd: REPO_ROOT }); // SK
    child = spawnedChild;                                                  // SK
    let stdoutBuffer = '';                                                 // SK
    let stderrBuffer = '';                                                 // SK
    let settled = false;                                                   // SK
    let timer = null;                                                      // SK
    // Compose bounded, actionable diagnostics (e.g. the EADDRINUSE line the  // SK
    // unchanged server.js writes to stderr) to append to failure messages.  // SK
    function diagnostics() {                                               // SK
      let detail = '';                                                     // SK
      const errText = stderrBuffer.trim();                                 // SK
      const outText = stdoutBuffer.trim();                                 // SK
      if (errText) {                                                       // SK
        detail += '\n--- server stderr ---\n' + errText;                  // SK
      }                                                                    // SK
      if (outText) {                                                       // SK
        detail += '\n--- server stdout ---\n' + outText;                  // SK
      }                                                                    // SK
      return detail;                                                       // SK
    }                                                                      // SK
    // Remove this start's listeners and timer so they can never fire during // SK
    // a later teardown (prevents the stale start-listener defect).          // SK
    function detach() {                                                    // SK
      if (timer) {                                                         // SK
        clearTimeout(timer);                                               // SK
      }                                                                    // SK
      spawnedChild.stdout.removeListener('data', onStdout);                // SK
      spawnedChild.stderr.removeListener('data', onStderr);                // SK
      spawnedChild.removeListener('error', onError);                       // SK
      spawnedChild.removeListener('close', onClose);                       // SK
    }                                                                      // SK
    // Release ownership only if this invocation still owns the child, then   // SK
    // return the module to 'idle' so a later start is permitted.            // SK
    function clearOwnership() {                                            // SK
      if (child === spawnedChild) {                                        // SK
        child = null;                                                      // SK
      }                                                                    // SK
      state = 'idle';                                                      // SK
    }                                                                      // SK
    function succeed() {                                                   // SK
      if (settled) {                                                       // SK
        return;                                                            // SK
      }                                                                    // SK
      settled = true;                                                      // SK
      detach();                                                            // SK
      state = 'running';                                                   // SK
      resolve(spawnedChild);                                               // SK
    }                                                                      // SK
    // Terminate the owned child BEFORE rejecting, then clear ownership       // SK
    // regardless of cleanup outcome, so a failed startup never orphans a     // SK
    // process or holds port 3000.                                           // SK
    function fail(err) {                                                   // SK
      if (settled) {                                                       // SK
        return;                                                            // SK
      }                                                                    // SK
      settled = true;                                                      // SK
      detach();                                                            // SK
      terminateChild(spawnedChild).then(function afterCleanup() {          // SK
        clearOwnership();                                                  // SK
        reject(err);                                                       // SK
      }, function afterCleanupError() {                                    // SK
        clearOwnership();                                                  // SK
        reject(err);                                                       // SK
      });                                                                  // SK
    }                                                                      // SK
    function onStdout(chunk) {                                             // SK
      stdoutBuffer = appendCapture(stdoutBuffer, chunk);                   // SK
      if (!settled && stdoutBuffer.includes(READY_LINE)) {                 // SK
        succeed();                                                         // SK
      }                                                                    // SK
    }                                                                      // SK
    function onStderr(chunk) {                                             // SK
      stderrBuffer = appendCapture(stderrBuffer, chunk);                   // SK
    }                                                                      // SK
    function onError(err) {                                                // SK
      fail(err);                                                           // SK
    }                                                                      // SK
    // Key premature-exit failure on 'close' (not 'exit'): 'close' fires     // SK
    // only after the child's stdio has fully drained, so the captured        // SK
    // stderr (e.g. server.js's EADDRINUSE line) is complete when the         // SK
    // diagnostics are composed.                                             // SK
    function onClose(code, signal) {                                       // SK
      fail(new Error('Server process exited before readiness (code ' + code + ', signal ' + signal + ')' + diagnostics())); // SK
    }                                                                      // SK
    spawnedChild.stdout.on('data', onStdout);                             // SK
    spawnedChild.stderr.on('data', onStderr);                             // SK
    spawnedChild.on('error', onError);                                     // SK
    spawnedChild.on('close', onClose);                                     // SK
    timer = setTimeout(function onStartupTimeout() {                       // SK
      fail(new Error('Server startup timed out after ' + STARTUP_TIMEOUT_MS + 'ms' + diagnostics())); // SK
    }, STARTUP_TIMEOUT_MS);                                                // SK
  });                                                                      // SK
}                                                                          // SK
// SK
// Idempotent, bounded teardown of the owned child. Resolves immediately if   // SK
// nothing is running (never started, or already exited); otherwise delegates // SK
// to terminateChild for signal escalation and guaranteed settlement, and     // SK
// clears ownership on BOTH success and failure (re-throwing any cleanup       // SK
// error so callers can observe a teardown that could not complete).          // SK
function stopServer() {                                                    // SK
  const target = child;                                                    // SK
  if (!target || target.exitCode !== null || target.signalCode !== null) { // SK
    child = null;                                                          // SK
    state = 'idle';                                                        // SK
    return Promise.resolve();                                              // SK
  }                                                                        // SK
  state = 'stopping';                                                      // SK
  return terminateChild(target).then(function onStopped() {                // SK
    if (child === target) {                                                // SK
      child = null;                                                        // SK
    }                                                                      // SK
    state = 'idle';                                                        // SK
  }, function onStopFailed(err) {                                          // SK
    if (child === target) {                                                // SK
      child = null;                                                        // SK
    }                                                                      // SK
    state = 'idle';                                                        // SK
    throw err;                                                             // SK
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
