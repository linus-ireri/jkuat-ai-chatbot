/**
 * Optional Netlify proxy to the Express VeritasRAG API.
 * Set RAG_SERVER_URL to the host running rag-server.js (without trailing path).
 * Browser calls: /.netlify/functions/veritas-rag-proxy/<path>
 *
 * Note: multipart uploads may hit Netlify payload limits; prefer calling
 * the Express host directly for Generic RAG uploads during demos.
 */
export const handler = async function (event) {
  const base = (process.env.RAG_SERVER_URL || '').replace(/\/ask\/?$/, '').replace(/\/$/, '');
  if (!base) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'RAG_SERVER_URL not configured' }),
    };
  }

  const suffix = (event.path || '').split('veritas-rag-proxy')[1] || '/meta';
  const url = `${base}/veritas-rag${suffix}${event.rawQuery ? `?${event.rawQuery}` : ''}`;

  try {
    const headers = { ...event.headers };
    delete headers.host;
    delete headers['content-length'];

    const res = await fetch(url, {
      method: event.httpMethod,
      headers,
      body: ['GET', 'HEAD'].includes(event.httpMethod) ? undefined : event.body,
    });
    const text = await res.text();
    return {
      statusCode: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Proxy failed', details: err.message }),
    };
  }
};
