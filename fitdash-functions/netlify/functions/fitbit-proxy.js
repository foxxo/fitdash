// Netlify runtime: Node 18+ (fetch is built-in)
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',                 // or your GH Pages origin for tighter security
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// netlify/functions/fitbit-proxy.js
export async function handler(event) {
    // CORS for your GitHub Pages origin
    const allowedOrigin = 'https://foxxo.github.io';

    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204,
            headers: {
                'Access-Control-Allow-Origin': allowedOrigin,
                'Access-Control-Allow-Headers': 'content-type',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Max-Age': '86400',
            },
        };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 400,
            headers: { 'Access-Control-Allow-Origin': allowedOrigin },
            body: 'Use POST with JSON: { url, method, headers, body? }',
        };
    }

    try {
        const { url, method = 'GET', headers = {}, body } = JSON.parse(event.body || '{}');
        if (!url) {
            return {
                statusCode: 400,
                headers: { 'Access-Control-Allow-Origin': allowedOrigin },
                body: 'Missing "url"',
            };
        }

        // Only forward safe headers (Authorization)
        const fwdHeaders = {};
        if (headers.Authorization || headers.authorization) {
            fwdHeaders.Authorization = headers.Authorization || headers.authorization;
        }

        const upstream = await fetch(url, {
            method,
            headers: fwdHeaders,
            body: body ?? undefined,
        });

        const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
        const text = await upstream.text();

        return {
            statusCode: upstream.status,
            headers: {
                'Access-Control-Allow-Origin': allowedOrigin,
                'content-type': contentType,
            },
            body: text,
        };
    } catch (err) {
        return {
            statusCode: 500,
            headers: { 'Access-Control-Allow-Origin': allowedOrigin },
            body: `Proxy error: ${err.message}`,
        };
    }
}
