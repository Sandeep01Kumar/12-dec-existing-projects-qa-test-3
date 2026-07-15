const express = require('express');

const app = express();
const hostname = '127.0.0.1';
const port = 3000;

// Root route — preserves the original greeting for backward compatibility (R3).
// res.type('text/plain') is set explicitly so the Content-Type matches the
// original http-module server (Express's res.send would otherwise default a
// string body to text/html). The body is byte-for-byte 'Hello, World!\n',
// including the single trailing newline, exactly as the original endpoint.
app.get('/', (req, res) => {
  res.type('text/plain').send('Hello, World!\n');
});

// New route (R4) — returns the plain-text 'Good evening' response.
// Note: no trailing newline here, unlike the root route. text/plain is set
// for consistency with the root endpoint.
app.get('/good-evening', (req, res) => {
  res.type('text/plain').send('Good evening');
});

app.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});
