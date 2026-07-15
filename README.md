# hao-backprop-test

Minimal Node.js HTTP server built with Express.

## Requirements

- Node.js 18 or higher (Express 5 requires `node >= 18`)

## Install

```bash
npm install
```

## Run

```bash
node server.js
# or
npm start
```

The server listens at http://127.0.0.1:3000/.

## Endpoints

Both endpoints respond with `Content-Type: text/plain`.

| Method | Path            | Response        |
|--------|-----------------|-----------------|
| GET    | `/`             | `Hello, World!` |
| GET    | `/good-evening` | `Good evening`  |

The exact response bodies differ only by a trailing newline: `GET /` returns `Hello, World!\n` (one trailing newline), while `GET /good-evening` returns `Good evening` (no trailing newline).

```bash
curl http://127.0.0.1:3000/
curl http://127.0.0.1:3000/good-evening
```
