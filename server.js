const express = require('express');

const app = express();

// Disable Express's default `X-Powered-By: Express` response header so the
// service does not advertise the underlying framework on any response
// (information-disclosure hardening, CWE-200). This removes one header only
// and changes no route behavior, response body, host, or port.
app.disable('x-powered-by');

const hostname = '127.0.0.1';
const port = 3000;

// Root route — preserves the original greeting for backward compatibility (R3).
// res.type('text/plain') is set explicitly so the Content-Type matches the
// original http-module server (Express's res.send would otherwise default a
// string body to text/html). The body is byte-for-byte 'Hello, World!\n',
// including the single trailing newline, exactly as the original endpoint.
app.get('/', (req, res) => {
  // Advertise MIME-sniffing protection on this 200 response so it carries the
  // same X-Content-Type-Options: nosniff header Express already applies to its
  // error responses (defense-in-depth; success/error parity). res.set() returns
  // res, so it chains ahead of the existing res.type().send() call.
  res.set('X-Content-Type-Options', 'nosniff').type('text/plain').send('Hello, World!\n');
});

// New route (R4) — returns the plain-text 'Good evening' response.
// Note: no trailing newline here, unlike the root route. text/plain is set
// for consistency with the root endpoint.
app.get('/good-evening', (req, res) => {
  // nosniff on this 200 response as well (parity with the root route above).
  res.set('X-Content-Type-Options', 'nosniff').type('text/plain').send('Good evening');
});

// Start listening on the configured host/port. In Express 5 (Node's net
// stack) the listen callback fires even when the underlying bind FAILS — for
// example when the port is already in use: the callback runs with
// `server.listening === false` while a separate 'error' event carries the
// actual failure (e.g. EADDRINUSE). With no 'error' handler that error is
// swallowed, the event loop drains, and the process exits 0 after printing a
// misleading "Server running" line. To make startup failures observable and
// correctly signalled, the success log is guarded on `server.listening` and a
// dedicated 'error' handler surfaces the failure to stderr with a non-zero
// exit code.
const server = app.listen(port, hostname, () => {
  // Only announce a successful start once the socket is actually bound and
  // listening. A failed bind still invokes this callback, but with
  // `server.listening === false`, so this guard suppresses the false-success
  // message in that case (the 'error' handler below reports the real cause).
  if (server.listening) {
    console.log(`Server running at http://${hostname}:${port}/`);
  }
});

// Surface bind/startup failures (such as EADDRINUSE when the port is already
// in use) to stderr and terminate with a non-zero status, so a failed launch
// is never reported as success. Setting `process.exitCode` (rather than
// calling `process.exit`) lets any pending output flush and the event loop
// unwind cleanly while still exiting non-zero.
server.on('error', (err) => {
  console.error(`Failed to start server at http://${hostname}:${port}/: ${err.message}`);
  process.exitCode = 1;
});
