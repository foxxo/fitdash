// Netlify runtime: Node 18+ (fetch is built-in)
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',                 // or your GH Pages origin for tighter security
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
    // Preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: CORS_HEADERS, body: '' };
    }

    try {
        // Require an Authorization header from the browser
        const auth = event.headers.authorization || event.headers.Authorization || '';
        if (!auth.startsWith('Bearer ')) {
            return {
                statusCode: 401,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: 'Missing or invalid Authorization header' }),
            };
        }

        // Only allow whitelisted Fitbit endpoints via a "path" query param
        // Example: /1/user/-/activities/heart/date/2025-03-25/1d/1min.json
        const qs = event.queryStringParameters || {};
        const path = qs.path || '';
        if (!path || !/^\/1(\.|\/)/.test(path)) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: 'Invalid or missing Fitbit API path' }),
            };
        }

        // Optional: forward querystring for Fitbit endpoints (?afterDate=..., etc.)
        // Accept pass-through params in "forward" (URL-encoded "k=v&k2=v2")
        const forward = qs.forward ? `?${qs.forward}` : '';

        const url = `https://api.fitbit.com${path}${forward}`;

        const resp = await fetch(url, {
            method: 'GET',
            headers: { Authorization: auth },
        });

        const text = await resp.text(); // pipe body as-is
        return {
            statusCode: resp.status,
            headers: {
                ...CORS_HEADERS,
                'Content-Type': resp.headers.get('content-type') || 'application/json',
            },
            body: text,
        };
    } catch (err) {
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: 'Proxy error', details: String(err) }),
        };
    }
};
