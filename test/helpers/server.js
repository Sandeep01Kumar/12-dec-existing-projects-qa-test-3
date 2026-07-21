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
// Deterministically terminate a specific child and RESOLVE only once it has  // SK
// actually exited ('exit'/'close'). Tolerates kill() throwing or returning   // SK
// false (undelivered signal) and a child 'error' event WITHOUT prematurely   // SK
// resolving or rejecting a still-live child; escalates SIGTERM -> SIGKILL     // SK
// after a grace window; and REJECTS only on a hard deadline with the child    // SK
// still alive, so teardown never hangs yet never falsely reports a live       // SK
// child as gone. Always clears its listeners and timers before settling.      // SK
function terminateChild(target) {                                          // SK
  return new Promise((resolve, reject) => {                                // SK
    if (!target || target.exitCode !== null || target.signalCode !== null) { // SK
      resolve();                                                           // SK
      return;                                                              // SK
    }                                                                      // SK
    let finished = false;                                                  // SK
    let graceTimer = null;                                                 // SK
    let hardTimer = null;                                                  // SK
    // Non-fatal errors seen while the child is still alive (a kill() throw   // SK
    // or a child 'error' event) are RECORDED here rather than used to        // SK
    // settle: an error does not prove the process exited, so settling on it  // SK
    // would wrongly report a still-live child as terminated. It is surfaced  // SK
    // only if the hard deadline is ultimately reached.                       // SK
    let lastError = null;                                                  // SK
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
    // Success path: settle (resolve) ONLY when the child has actually       // SK
    // exited. This is the core F3 guarantee — callers release ownership      // SK
    // exclusively after a CONFIRMED exit, never on a mere signal send.       // SK
    function onDone() {                                                    // SK
      settle();                                                            // SK
    }                                                                      // SK
    // A child 'error' event does not imply the process is gone: record it   // SK
    // for diagnostics and keep waiting/escalating rather than settling.     // SK
    function onError(err) {                                                // SK
      lastError = err;                                                     // SK
    }                                                                      // SK
    target.once('exit', onDone);                                           // SK
    target.once('close', onDone);                                          // SK
    target.on('error', onError);                                           // SK
    // Hard deadline: the ONLY rejection path. Reached only when the child   // SK
    // is STILL alive after the full SIGTERM -> SIGKILL escalation, i.e. a    // SK
    // genuinely un-killable process; it surfaces any recorded lastError.    // SK
    hardTimer = setTimeout(function onHardDeadline() {                     // SK
      const base = 'Server did not terminate within ' + (STOP_TIMEOUT_MS * 2) + 'ms'; // SK
      settle(new Error(lastError ? base + ': ' + lastError.message : base)); // SK
    }, STOP_TIMEOUT_MS * 2);                                               // SK
    try {                                                                  // SK
      const delivered = target.kill('SIGTERM');                           // SK
      if (delivered === false && target.exitCode === null && target.signalCode === null) { // SK
        target.kill('SIGKILL');                                           // SK
      }                                                                    // SK
    } catch (err) {                                                        // SK
      // Do NOT settle: the child may still be alive. Record the error and   // SK
      // fall through so the grace timer can escalate and the hard deadline  // SK
      // stays the sole rejection path.                                     // SK
      lastError = err;                                                     // SK
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
        // Record-only again; the hard deadline remains the sole rejection. // SK
        lastError = err;                                                   // SK
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
    // Readiness is gated on parsing COMPLETE, newline-delimited stdout lines // SK
    // and matching the ready text EXACTLY (not a loose substring), so a      // SK
    // prefixed or partial write can never be mistaken for readiness.        // SK
    // `pendingLine` accumulates the not-yet-terminated tail; readyLineCount  // SK
    // counts exact matches and is surfaced to the caller for an exact-once   // SK
    // assertion.                                                             // SK
    let pendingLine = '';                                                  // SK
    let readyLineCount = 0;                                                // SK
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
    // Resolve with the spawned child AND the observed readyLineCount so the  // SK
    // suite can assert the ready line appeared EXACTLY once. The module's    // SK
    // public export list is unchanged (still five names); only startServer's // SK
    // resolved value shape carries this metadata, and nothing internal       // SK
    // depends on it.                                                         // SK
    function succeed() {                                                   // SK
      if (settled) {                                                       // SK
        return;                                                            // SK
      }                                                                    // SK
      settled = true;                                                      // SK
      detach();                                                            // SK
      state = 'running';                                                   // SK
      resolve({ child: spawnedChild, readyLineCount });                    // SK
    }                                                                      // SK
    // Terminate the owned child BEFORE rejecting. On a CONFIRMED exit,       // SK
    // release ownership and return to 'idle'. If cleanup could NOT confirm   // SK
    // the child exited, RETAIN ownership and leave the module non-idle       // SK
    // ('stopping') so a later stopServer() can retry termination and a       // SK
    // concurrent startServer() is refused — never orphaning a live process   // SK
    // that still holds port 3000. Both failures are surfaced together.      // SK
    function fail(err) {                                                   // SK
      if (settled) {                                                       // SK
        return;                                                            // SK
      }                                                                    // SK
      settled = true;                                                      // SK
      detach();                                                            // SK
      terminateChild(spawnedChild).then(function afterCleanup() {          // SK
        clearOwnership();                                                  // SK
        reject(err);                                                       // SK
      }, function afterCleanupError(cleanupErr) {                          // SK
        // Cleanup failed with the child still alive: keep child ===         // SK
        // spawnedChild (do NOT clearOwnership) and mark 'stopping' so the    // SK
        // single-owner guard still blocks a new start and stopServer() can   // SK
        // retry termination later.                                          // SK
        state = 'stopping';                                                // SK
        reject(new AggregateError([err, cleanupErr], 'Startup failed and cleanup could not confirm the server exited')); // SK
      });                                                                  // SK
    }                                                                      // SK
    function onStdout(chunk) {                                             // SK
      stdoutBuffer = appendCapture(stdoutBuffer, chunk);                   // SK
      // Assemble COMPLETE lines from the raw stream: append the chunk, then  // SK
      // consume each newline-terminated line, tolerating Windows CRLF by     // SK
      // stripping a trailing '\r'. Only a line EXACTLY equal to READY_LINE   // SK
      // counts toward readiness, so a substring or prefixed write cannot     // SK
      // spoof the ready signal.                                             // SK
      pendingLine += chunk.toString();                                     // SK
      let newlineIndex = pendingLine.indexOf('\n');                        // SK
      while (newlineIndex !== -1) {                                         // SK
        let line = pendingLine.slice(0, newlineIndex);                     // SK
        pendingLine = pendingLine.slice(newlineIndex + 1);                 // SK
        if (line.endsWith('\r')) {                                         // SK
          line = line.slice(0, -1);                                        // SK
        }                                                                  // SK
        if (line === READY_LINE) {                                         // SK
          readyLineCount += 1;                                             // SK
        }                                                                  // SK
        newlineIndex = pendingLine.indexOf('\n');                          // SK
      }                                                                    // SK
      // Bound the unterminated tail so a newline-less flood cannot grow it   // SK
      // without limit; keep only the most recent MAX_CAPTURE_BYTES chars.    // SK
      if (pendingLine.length > MAX_CAPTURE_BYTES) {                         // SK
        pendingLine = pendingLine.slice(-MAX_CAPTURE_BYTES);               // SK
      }                                                                    // SK
      if (!settled && readyLineCount >= 1) {                               // SK
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
// to terminateChild for signal escalation. On a CONFIRMED exit it clears     // SK
// ownership and returns to 'idle'. If termination could NOT confirm the      // SK
// child exited, it RETAINS ownership and stays non-idle ('stopping') — so a  // SK
// concurrent start is refused and a later stopServer() can retry — then      // SK
// re-throws so the caller observes the incomplete teardown.                  // SK
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
    // Termination could not confirm the child exited: RETAIN ownership      // SK
    // (leave child === target) and stay non-idle so the single-owner guard  // SK
    // keeps blocking a new start and a subsequent stopServer() can retry     // SK
    // the same process. Re-throw so the caller sees the incomplete teardown. // SK
    state = 'stopping';                                                    // SK
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
