const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // 1. Cabeçalhos CORS Universais
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Rota de teste/saúde (Ping)
  const host = req.headers.host || `localhost:${PORT}`;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const selfOrigin = `${protocol}://${host}`;

  const reqUrl = new URL(req.url, selfOrigin);
  let targetUrl = reqUrl.searchParams.get('url');

  if (!targetUrl && req.url.startsWith('/proxy/')) {
    targetUrl = req.url.replace('/proxy/', '');
  }

  if (!targetUrl) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Laranjeira TV Relay Online! Use /?url=URL_DO_STREAM');
    return;
  }

  try {
    fetchStream(targetUrl, req, res, selfOrigin, 0);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Erro interno: ' + err.message);
  }
});

function fetchStream(targetUrl, req, res, selfOrigin, redirectCount) {
  if (redirectCount > 5) {
    res.writeHead(508, { 'Content-Type': 'text/plain' });
    res.end('Demasiados redirecionamentos.');
    return;
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('URL de destino inválido.');
    return;
  }

  const client = parsedTarget.protocol === 'https:' ? https : http;

  const forwardHeaders = {
    'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
    'Accept': '*/*',
    'Connection': 'keep-alive',
  };

  if (req.headers.range) {
    forwardHeaders['Range'] = req.headers.range;
  }

  const proxyReq = client.get(targetUrl, { headers: forwardHeaders, timeout: 12000 }, (proxyRes) => {
    // 2. Tratar Redirecionamentos (301, 302, 307, 308)
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      const redirectLocation = new URL(proxyRes.headers.location, targetUrl).href;
      fetchStream(redirectLocation, req, res, selfOrigin, redirectCount + 1);
      return;
    }

    const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
    const isM3u8 = targetUrl.toLowerCase().includes('.m3u8') ||
                   contentType.includes('mpegurl') ||
                   contentType.includes('application/x-mpegurl');

    // 3. Se for lista M3U8, reescrevemos as linhas para os pedaços passarem no relay
    if (isM3u8 && proxyRes.statusCode === 200) {
      let bodyData = [];
      proxyRes.on('data', chunk => bodyData.push(chunk));
      proxyRes.on('end', () => {
        const text = Buffer.concat(bodyData).toString('utf8');
        const lines = text.split('\n');

        const rewritten = lines.map(line => {
          const trimmed = line.trim();
          if (!trimmed) return line;

          if (trimmed.startsWith('#')) {
            if (trimmed.includes('URI="')) {
              return line.replace(/URI="([^"]+)"/g, (match, uri) => {
                try {
                  const abs = new URL(uri, targetUrl).href;
                  return `URI="${selfOrigin}/?url=${encodeURIComponent(abs)}"`;
                } catch (e) { return match; }
              });
            }
            return line;
          }

          try {
            const abs = new URL(trimmed, targetUrl).href;
            return `${selfOrigin}/?url=${encodeURIComponent(abs)}`;
          } catch (e) {
            return line;
          }
        }).join('\n');

        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        res.end(rewritten);
      });
      return;
    }

    // 4. Streaming Contínuo (MPEG-TS, áudio, fragmentos de vídeo)
    const resHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': proxyRes.headers['content-type'] || 'video/mp2t',
      'Cache-Control': 'no-cache',
    };

    if (proxyRes.headers['content-range']) resHeaders['Content-Range'] = proxyRes.headers['content-range'];
    if (proxyRes.headers['accept-ranges']) resHeaders['Accept-Ranges'] = proxyRes.headers['accept-ranges'];
    if (proxyRes.headers['content-length']) resHeaders['Content-Length'] = proxyRes.headers['content-length'];

    res.writeHead(proxyRes.statusCode, resHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Falha ao ligar ao servidor IPTV: ' + err.message);
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'text/plain' });
      res.end('Timeout de ligação ao stream.');
    }
  });
}

server.listen(PORT, () => {
  console.log(`Relay Laranjeira TV escutando na porta ${PORT}`);
});
