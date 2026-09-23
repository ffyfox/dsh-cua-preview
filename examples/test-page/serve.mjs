/**
 * Serve the local CUA test page.
 *
 * A stable, offline target for `browser_act`. Unlike a public site it never has TLS hiccups, and
 * it is guaranteed to expose the three selectors the examples use.
 *
 * Usage:  node examples/test-page/serve.mjs [--port 3097] [--host 127.0.0.1]
 *
 * The page is served from this directory, so editing `index.html` needs no restart.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname)

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag)
  if (index === -1 || index + 1 >= process.argv.length) return fallback
  return process.argv[index + 1]
}

const port = Number(argValue('--port', process.env.CUA_TEST_PORT ?? '3097'))
const host = argValue('--host', '127.0.0.1')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}`)
  const requested = url.pathname === '/' ? '/index.html' : url.pathname

  // Contain every request under ROOT: normalize first, then verify the prefix.
  const target = join(ROOT, normalize(requested).replace(/^(\.\.[/\\])+/, ''))
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden')
    return
  }

  try {
    const body = await readFile(target)
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
  }
})

server.listen(port, host, () => {
  console.log(`CUA test page: http://${host}:${port}/`)
  console.log('selectors: #click-target  #name-input  #submit-button  #demo-form  #status')
  console.log('stop with Ctrl-C')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    // Do not wait on keep-alive sockets.
    setTimeout(() => process.exit(0), 500).unref()
  })
}
