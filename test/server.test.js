'use strict';                                                              // SK
// SK
const { describe, it, before, after } = require('node:test');              // SK
const assert = require('node:assert');                                     // SK
const {                                                                    // SK
  startServer,                                                             // SK
  stopServer,                                                              // SK
  BASE_URL,                                                                // SK
  EXPECTED_ROOT_BODY,                                                      // SK
  EXPECTED_EVENING_BODY,                                                   // SK
  EXPECTED_MORNING_BODY,                                                   // SK
} = require('./helpers/server');                                           // SK
// SK
// Holds the object returned by startServer() so both the before() startup // SK
// assertion and the after() lifetime assertion can read the LIVE readiness// SK
// count the helper exposes. Module scope lets both hooks share it.        // SK
let started;                                                               // SK
// SK
before(async () => {                                                       // SK
  // Assert the readiness contract at STARTUP: by the time startup resolves// SK
  // the server must have emitted its ready line EXACTLY once (this also   // SK
  // catches a duplicate that arrives within the very first stdout chunk). // SK
  started = await startServer();                                           // SK
  assert.strictEqual(started.readyLineCount, 1);                           // SK
});                                                                        // SK
// SK
after(async () => {                                                        // SK
  // Stop the owned child, then RE-ASSERT the exact-once contract over the // SK
  // child's FULL lifetime. After teardown the helper has observed every   // SK
  // stdout line the server wrote, so a delayed duplicate readiness line   // SK
  // (emitted after startup resolved) is caught here, not silently missed. // SK
  await stopServer();                                                      // SK
  assert.strictEqual(started.readyLineCount, 1);                           // SK
});                                                                        // SK
// SK
describe('Root endpoint (GET /)', () => {                                  // SK
  it('responds 200 with byte-exact body and headers', async () => {        // SK
    const res = await fetch(`${BASE_URL}/`);                               // SK
    const body = await res.text();                                         // SK
    assert.strictEqual(res.status, 200);                                   // SK
    assert.strictEqual(body, EXPECTED_ROOT_BODY);                          // SK
    assert.strictEqual(body, 'Hello, World!\n');                           // SK
    assert.strictEqual(Buffer.byteLength(body), 14);                       // SK
    assert.strictEqual(res.headers.get('content-type'), 'text/plain; charset=utf-8'); // SK
    assert.strictEqual(res.headers.get('content-length'), '14');           // SK
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff'); // SK
    assert.strictEqual(res.headers.get('x-powered-by'), null);             // SK
  });                                                                      // SK
});                                                                        // SK
// SK
describe('Evening greeting (GET /good-evening)', () => {                   // SK
  it('responds 200 with 12-byte body and no trailing newline', async () => { // SK
    const res = await fetch(`${BASE_URL}/good-evening`);                   // SK
    const body = await res.text();                                         // SK
    assert.strictEqual(res.status, 200);                                   // SK
    assert.strictEqual(body, EXPECTED_EVENING_BODY);                       // SK
    assert.strictEqual(body, 'Good evening');                              // SK
    assert.strictEqual(body.endsWith('\n'), false);                        // SK
    assert.strictEqual(Buffer.byteLength(body), 12);                       // SK
    assert.strictEqual(res.headers.get('content-type'), 'text/plain; charset=utf-8'); // SK
    assert.strictEqual(res.headers.get('content-length'), '12');           // SK
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff'); // SK
    assert.strictEqual(res.headers.get('x-powered-by'), null);             // SK
  });                                                                      // SK
});                                                                        // SK
// SK
describe('Morning greeting (GET /good-morning)', () => {                   // SK
  it('responds 200 with 12-byte body and no trailing newline', async () => { // SK
    const res = await fetch(`${BASE_URL}/good-morning`);                   // SK
    const body = await res.text();                                         // SK
    assert.strictEqual(res.status, 200);                                   // SK
    assert.strictEqual(body, EXPECTED_MORNING_BODY);                       // SK
    assert.strictEqual(body, 'Good morning');                              // SK
    assert.strictEqual(body.endsWith('\n'), false);                        // SK
    assert.strictEqual(Buffer.byteLength(body), 12);                       // SK
    assert.strictEqual(res.headers.get('content-type'), 'text/plain; charset=utf-8'); // SK
    assert.strictEqual(res.headers.get('content-length'), '12');           // SK
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff'); // SK
    assert.strictEqual(res.headers.get('x-powered-by'), null);             // SK
  });                                                                      // SK
});                                                                        // SK
// SK
describe('Routing & negative cases', () => {                               // SK
  it('GET /nonexistent returns 404 with text/html content-type', async () => { // SK
    const res = await fetch(`${BASE_URL}/nonexistent`);                    // SK
    const body = await res.text();                                         // SK
    assert.strictEqual(res.status, 404);                                   // SK
    const contentType = res.headers.get('content-type');                   // SK
    assert.notStrictEqual(contentType, null, 'content-type header must be present on the 404 response'); // SK
    assert.ok(contentType.startsWith('text/html'), `expected a text/html content-type on 404, got: ${contentType}`); // SK
    assert.ok(body.length > 0);                                            // SK
  });                                                                      // SK
  it('POST / returns 404 (Express 5 method/route mismatch)', async () => { // SK
    const res = await fetch(`${BASE_URL}/`, { method: 'POST' });           // SK
    await res.text();                                                      // SK
    assert.strictEqual(res.status, 404);                                   // SK
  });                                                                      // SK
});                                                                        // SK
// SK
describe('Security headers', () => {                                       // SK
  it('all success routes carry x-content-type-options: nosniff', async () => { // SK
    const rootRes = await fetch(`${BASE_URL}/`);                           // SK
    await rootRes.text();                                                  // SK
    const eveningRes = await fetch(`${BASE_URL}/good-evening`);            // SK
    await eveningRes.text();                                               // SK
    const morningRes = await fetch(`${BASE_URL}/good-morning`);            // SK
    await morningRes.text();                                               // SK
    assert.strictEqual(rootRes.headers.get('x-content-type-options'), 'nosniff'); // SK
    assert.strictEqual(eveningRes.headers.get('x-content-type-options'), 'nosniff'); // SK
    assert.strictEqual(morningRes.headers.get('x-content-type-options'), 'nosniff'); // SK
  });                                                                      // SK
  it('no response exposes x-powered-by', async () => {                     // SK
    const rootRes = await fetch(`${BASE_URL}/`);                           // SK
    await rootRes.text();                                                  // SK
    const eveningRes = await fetch(`${BASE_URL}/good-evening`);            // SK
    await eveningRes.text();                                               // SK
    const morningRes = await fetch(`${BASE_URL}/good-morning`);            // SK
    await morningRes.text();                                               // SK
    const missingRes = await fetch(`${BASE_URL}/nonexistent`);             // SK
    await missingRes.text();                                               // SK
    // Include the POST / method-mismatch (Express 5 -> 404) response so   // SK
    // X-Powered-By suppression is verified on a non-GET path too.         // SK
    const postRes = await fetch(`${BASE_URL}/`, { method: 'POST' });       // SK
    await postRes.text();                                                  // SK
    assert.strictEqual(rootRes.headers.get('x-powered-by'), null);         // SK
    assert.strictEqual(eveningRes.headers.get('x-powered-by'), null);      // SK
    assert.strictEqual(morningRes.headers.get('x-powered-by'), null);      // SK
    assert.strictEqual(missingRes.headers.get('x-powered-by'), null);      // SK
    assert.strictEqual(postRes.headers.get('x-powered-by'), null);         // SK
  });                                                                      // SK
});                                                                        // SK
