const CLIENT_ID = '23PXJV';
const REDIRECT_URI = 'https://foxxo.github.io/fitdash/';
const AUTH_URL = `https://www.fitbit.com/oauth2/authorize?response_type=token&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=activity%20heartrate%20sleep%20profile&expires_in=604800`;
const NETLIFY_BASE = "https://fitdashproxy.netlify.app/.netlify/functions/fitbit-proxy";

const DRINKS_SHEET_ID = '1L0SoHJxTgcAC4EaV5kdM05FIprhEHlqa8_C13LnQ_VI';
const DRINKS_SHEET_URL = `https://docs.google.com/spreadsheets/d/${DRINKS_SHEET_ID}/export?format=csv`;

function parseCsv(text) {
    const rows = [];
    let row = [], cur = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { cur += '"'; i++; }
                else inQuotes = false;
            } else cur += ch;
        } else if (ch === '"') inQuotes = true;
        else if (ch === ',') { row.push(cur); cur = ''; }
        else if (ch === '\r') { /* skip */ }
        else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
        else cur += ch;
    }
    if (cur.length || row.length) { row.push(cur); rows.push(row); }
    return rows;
}

function parseSheetDate(raw) {
    if (!raw) return null;
    const s = raw.trim();
    if (!s) return null;
    // Sheet dates come in as "M/D" with no year — assume the current year.
    const md = s.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (md) {
        const d = new Date(new Date().getFullYear(), parseInt(md[1], 10) - 1, parseInt(md[2], 10));
        if (isNaN(d.getTime())) return null;
        return getLocalDateString(d);
    }
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return getLocalDateString(d);
}

// Order matters: more-specific patterns first.
const DRINK_EMOJI_RULES = [
    [/champagne|prosecco|sparkling|cava|bubbly/i, '🍾'],
    [/sake/i, '🍶'],
    [/wine|red|white|ros[eé]|merlot|cab(ernet)?|chardonnay|pinot|riesling|sauvignon/i, '🍷'],
    [/beer|ale|lager|ipa|stout|pilsner|porter|hefeweizen|saison/i, '🍺'],
    [/cocktail|martini|margarita|mojito|daiquiri|negroni|manhattan|old.?fashioned|spritz|sour|highball|julep|gimlet|cosmo/i, '🍸'],
    [/vodka|gin|rum|tequila|mezcal/i, '🍸'],
];

function emojiForDrink(label) {
    for (const [re, emoji] of DRINK_EMOJI_RULES) {
        if (re.test(label)) return emoji;
    }
    return '🥃'; // default: whisky/cognac/pickleback/etc.
}

// Returns { emoji, count } or null. Counts may be fractional (e.g. "1.5 beers").
function parseDrinkItem(item) {
    const s = item.trim();
    if (!s) return null;
    const m = s.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
    const rawCount = m ? parseFloat(m[1]) : 1;
    const count = Math.max(0, Math.min(99, rawCount));
    if (!(count > 0)) return null;
    const label = m ? m[2] : s;
    return { emoji: emojiForDrink(label), count };
}

function parseDrinksList(cell) {
    if (!cell) return [];
    return cell.split(',').map(parseDrinkItem).filter(Boolean);
}

function formatDrinkCount(n) {
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// Convert parsed items to a flat list of render segments. Counts > 3 collapse
// to "<emoji> ×N"; smaller counts render full emojis plus an optional half.
function drinksToSegments(items) {
    const segments = [];
    for (const { emoji, count } of items) {
        if (count > 3) {
            segments.push({ type: 'emoji', text: emoji });
            segments.push({ type: 'text', text: `×${formatDrinkCount(count)}` });
            continue;
        }
        const full = Math.floor(count);
        const frac = count - full;
        for (let i = 0; i < full; i++) segments.push({ type: 'emoji', text: emoji });
        if (frac >= 0.75) segments.push({ type: 'emoji', text: emoji });
        else if (frac >= 0.25) segments.push({ type: 'half', text: emoji });
    }
    return segments;
}

async function fetchDrinksByDate() {
    let text;
    try {
        const res = await fetch(DRINKS_SHEET_URL, { redirect: 'follow' });
        if (!res.ok) {
            console.warn('fetchDrinksByDate non-OK', res.status);
            return {};
        }
        text = await res.text();
    } catch (e) {
        console.warn('fetchDrinksByDate error', e);
        return {};
    }
    const rows = parseCsv(text);
    const map = {};
    for (const row of rows) {
        const dateKey = parseSheetDate(row[0]);
        if (!dateKey) continue;
        const items = parseDrinksList(row[1] || ''); // column B
        if (items.length) map[dateKey] = items;
    }
    return map;
}

async function fitbitFetch(targetUrl, init = {}) {
    // prefer header passed in, otherwise attach stored token
    const token = localStorage.getItem('fitbit_access_token');
    const authHeader =
        (init.headers && (init.headers.Authorization || init.headers.authorization)) ||
        (token ? `Bearer ${token}` : undefined);

    const payload = {
        url: targetUrl,
        method: init.method || 'GET',
        headers: authHeader ? { Authorization: authHeader } : {},
        // NOTE: If you ever need to proxy a POST with a body to Fitbit, add: body: init.body
    };

    const res = await fetch(NETLIFY_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'follow',
    });

    // Forward non-2xx for easier debugging
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.warn('fitbitFetch proxy error', res.status, txt);
    }
    return res;
}



let currentStartDate = new Date();
currentStartDate.setHours(0, 0, 0, 0);

const loadedDates = new Set();
const loadedOverlayDates = new Set();

// Dates currently in the load queue or in-flight. Painted as stripes so the
// chart shows what's actively being worked on; cleared once a date's fetch
// finishes (success, empty, or error). Stripes ⇔ "we're working on it".
const queuedOrLoadingDates = new Set();
const loadQueue = [];
let isProcessingLoadQueue = false;
let _heartRateChart = null;

function getLocalDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Hot path: line segment color callback runs per drawn segment. Cache the
// resting-HR lookup per local day so we skip the Date->string->dict-lookup
// chain on every call. Cleared whenever restingHRByDate gets new entries.
const _restingHRByLocalDay = new Map();
function invalidateRestingHRCache() {
    _restingHRByLocalDay.clear();
}
function getCachedRestingHR(timestampMs) {
    const d = new Date(timestampMs);
    const bucket = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    const cached = _restingHRByLocalDay.get(bucket);
    if (cached !== undefined) return cached;
    const dateStr = getLocalDateString(d);
    const rhr = window.fitdashOverlayData?.restingHRByDate?.[dateStr] ?? 66;
    _restingHRByLocalDay.set(bucket, rhr);
    return rhr;
}

// Sleep-phase lookup index. Tooltip fires on every mousemove and previously
// scanned the full phase list; with 5+ days loaded that's hundreds of entries
// per pointer event. Phases are bucketed by local day (under both their start
// and end day so phases that span midnight are findable from either side) and
// pre-decorated with numeric timestamps so the tooltip avoids Date coercion.
const _sleepPhasesByDay = new Map();
function indexSleepPhase(phase) {
    if (phase._indexed) return;
    phase.startMs = phase.start.getTime();
    phase.endMs = phase.end.getTime();
    phase._indexed = true;
    const startKey = getLocalDateString(phase.start);
    let bucket = _sleepPhasesByDay.get(startKey);
    if (!bucket) { bucket = []; _sleepPhasesByDay.set(startKey, bucket); }
    bucket.push(phase);
    const endKey = getLocalDateString(phase.end);
    if (endKey !== startKey) {
        let endBucket = _sleepPhasesByDay.get(endKey);
        if (!endBucket) { endBucket = []; _sleepPhasesByDay.set(endKey, endBucket); }
        endBucket.push(phase);
    }
}
function findSleepPhaseAt(timestampMs) {
    const key = getLocalDateString(new Date(timestampMs));
    const bucket = _sleepPhasesByDay.get(key);
    if (!bucket) return null;
    for (const phase of bucket) {
        if (timestampMs >= phase.startMs && timestampMs <= phase.endMs) return phase;
    }
    return null;
}

async function fetchWorkoutSessions(date) {
    const accessToken = localStorage.getItem('fitbit_access_token');
    const formattedDate = getLocalDateString(date);

    const response = await fitbitFetch(`https://api.fitbit.com/1/user/-/activities/list.json?afterDate=${formattedDate}T00:00:00&sort=asc&limit=100&offset=0`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) return [];

    const data = await response.json();
    return data.activities.map(act => ({
        start: new Date(act.startTime),
        end: new Date(new Date(act.startTime).getTime() + act.duration),
        activityName: act.activityName || '',
        calories: act.calories,
    }));
}

async function fetchHRVSummary(date) {
    const accessToken = localStorage.getItem('fitbit_access_token');
    const d = getLocalDateString(date);

    // First try the 1d form
    let res = await fitbitFetch(`https://api.fitbit.com/1/user/-/hrv/date/${d}/1d.json`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    // Fallback to the plain date form if needed
    if (!res.ok) {
        res = await fitbitFetch(`https://api.fitbit.com/1/user/-/hrv/date/${d}.json`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
    }

    if (!res.ok) return null;

    const data = await res.json();
    // The shape typically looks like:
    // { "hrv": [ { "dateTime": "YYYY-MM-DD", "value": { "dailyRmssd": 34, "deepRmssd": 42 } } ] }
    const item = (data.hrv && data.hrv[0]) || null;
    const value = item?.value || {};
    return {
        date: d,
        dailyRmssd: value.dailyRmssd ?? null,
        deepRmssd: value.deepRmssd ?? null,
    };
}


// Plugin text uses fixed pixel sizes; on narrow viewports those become huge
// relative to the chart. Scale by chart width against a 1200px design width,
// clamped so labels stay legible but don't dominate.
function getChartFontScale(chart) {
    const w = chart?.width || chart?.chartArea?.width || 1200;
    return Math.max(0.55, Math.min(1, w / 1200));
}

// Interactive bubble state. The summary plugin populates _bubbleHitRegions
// each redraw; the chart's onClick handler hit-tests against them and toggles
// _expandedBubbleDate. An expanded bubble draws full-content + enlarged on top.
let _expandedBubbleDate = null;
const _bubbleHitRegions = [];

function scaledFont(spec, scale) {
    return spec.replace(/(\d+)px/, (_, n) => `${Math.max(8, Math.round(parseInt(n, 10) * scale))}px`);
}

const WORKOUT_EMOJI = new Map([
    ["treadmill", "🏃"],
    ["run", "🏃"],
    ["jog", "🏃"],
    ["walk", "👟"],
    ["hike", "🥾"],
    ["stairs", "🪜"],
    ["elliptical", "⚙️"],
    ["spinning", "🚴"],
    ["mountain bike", "🚵"],
    ["bike", "🚴"],
    ["cycl", "🚴"],
    ["swim", "🏊"],
    ["row", "🚣"],
    ["kayak", "🛶"],
    ["paddle", "🛶"],
    ["surf", "🏄"],
    ["ski", "⛷️"],
    ["snowboard", "🏂"],
    ["skate", "⛸️"],
    ["climb", "🧗"],
    ["yoga", "🧘"],
    ["pilates", "🧘"],
    ["stretch", "🤸"],
    ["weight", "🏋️"],
    ["strength", "🏋️"],
    ["crossfit", "🏋️"],
    ["hiit", "🔥"],
    ["circuit", "🔥"],
    ["bootcamp", "🪖"],
    ["box", "🥊"],
    ["kickbox", "🥊"],
    ["martial", "🥋"],
    ["karate", "🥋"],
    ["judo", "🥋"],
    ["tennis", "🎾"],
    ["pickleball", "🥒"],
    ["badminton", "🏸"],
    ["golf", "⛳"],
    ["basketball", "🏀"],
    ["soccer", "⚽"],
    ["football", "🏈"],
    ["baseball", "⚾"],
    ["volleyball", "🏐"],
    ["hockey", "🏒"],
    ["rugby", "🏉"],
    ["cricket", "🏏"],
    ["bowling", "🎳"],
    ["dance", "💃"],
    ["zumba", "💃"],
    ["aerobic", "🕺"],
    ["sport", "🤺"],
    ["fenc", "🤺"],
    ["archery", "🏹"],
    ["horse", "🏇"],
    ["frisb", "🥏"],
]);

function getWorkoutEmoji(activityName) {
    const name = activityName.toLowerCase();
    for (const [keyword, emoji] of WORKOUT_EMOJI) {
        if (name.includes(keyword)) return emoji;
    }
    return "💪";
}

const workoutEmojiPlugin = {
    id: 'workoutEmojiPlugin',
    afterDatasetsDraw(chart) {
        const workouts = window.fitdashOverlayData?.workouts || [];
        const { ctx, chartArea: area, scales: { x } } = chart;
        const xMin = x.min, xMax = x.max;
        const scale = getChartFontScale(chart);
        const emojiPx = Math.max(14, Math.round(32 * scale));
        const labelPx = Math.max(9, Math.round(12 * scale));

        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        workouts.forEach(({ start, activityName, calories, end }) => {
            const startMs = start.getTime();
            const endMs = end.getTime();
            if (endMs < xMin || startMs > xMax) return;
            const xPos = (x.getPixelForValue(startMs) + x.getPixelForValue(endMs)) / 2;
            if (xPos >= area.left && xPos <= area.right) {
                const emoji = getWorkoutEmoji(activityName);
                const emojiY = area.bottom + 4;
                const textY = emojiY + emojiPx;

                ctx.fillStyle = 'rgb(255,255,255)';
                ctx.font = `${emojiPx}px sans-serif`;
                ctx.fillText(emoji, xPos, emojiY);
                ctx.font = `${labelPx}px sans-serif`;
                ctx.fillText(`${Math.round(calories)} cal`, xPos, textY);
            }
        });

        ctx.restore();
    }
};


async function fetchSleepPhases(date) {
    const accessToken = localStorage.getItem('fitbit_access_token');
    const formattedDate = getLocalDateString(date);

    const response = await fitbitFetch(`https://api.fitbit.com/1.2/user/-/sleep/date/${formattedDate}.json`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) return { phases: [], summary: null };

    const data = await response.json();
    const sleepEntries = data.sleep || [];
    const phases = [];
    // `asleep` comes from Fitbit's classic-mode tracking (naps / short sessions); it counts toward total.
    const summaryTotals = { light: 0, deep: 0, rem: 0, asleep: 0 };

    for (const session of sleepEntries) {
        if (session.levels) {
            if (session.levels.data) {
                for (const stage of session.levels.data) {
                    phases.push({
                        start: new Date(stage.dateTime),
                        end: new Date(new Date(stage.dateTime).getTime() + stage.seconds * 1000),
                        stage: stage.level
                    });
                }
            }
            if (session.levels.summary) {
                for (const stage of ['light', 'deep', 'rem', 'asleep']) {
                    summaryTotals[stage] += session.levels.summary[stage]?.minutes ?? 0;
                }
            }
        }
    }

    const summaryTotal = summaryTotals.light + summaryTotals.deep + summaryTotals.rem + summaryTotals.asleep;
    const summary = summaryTotal > 0 ? { total: summaryTotal, ...summaryTotals } : null;

    return { phases, summary };
}

async function fetchDailySummary(date) {
    const accessToken = localStorage.getItem('fitbit_access_token');
    const formattedDate = getLocalDateString(date);

    const response = await fitbitFetch(`https://api.fitbit.com/1/user/-/activities/heart/date/${formattedDate}/1d.json`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) return { restingHR: null, calories: null };

    const data = await response.json();
    const value = data['activities-heart']?.[0]?.value || {};

    const restingHR = value.restingHeartRate || null;
    const calories = (value.heartRateZones || []).reduce((sum, zone) => sum + (zone.caloriesOut || 0), 0);

    return { restingHR, calories: Math.round(calories) };
}

async function fetchHeartRateDataForDate(date) {
    const accessToken = localStorage.getItem('fitbit_access_token');
    const formattedDate = getLocalDateString(date);
    if (loadedDates.has(formattedDate)) return [];
    loadedDates.add(formattedDate);

    try {
        const response = await fitbitFetch(`https://api.fitbit.com/1/user/-/activities/heart/date/${formattedDate}/1d/1min.json`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!response.ok) throw new Error('Failed to fetch HR');

        const data = await response.json();
        return data["activities-heart-intraday"].dataset || [];
    } catch (err) {
        loadedDates.delete(formattedDate);
        return [];
    }
}

async function fetchOverlayDataForDate(date) {
    const formattedDate = getLocalDateString(date);
    if (loadedOverlayDates.has(formattedDate)) return;
    loadedOverlayDates.add(formattedDate);

    const [workouts, { phases: sleepPhases, summary: sleepSummary }, dailySummary, hrv] = await Promise.all([
        fetchWorkoutSessions(date),
        fetchSleepPhases(date),
        fetchDailySummary(date),
        fetchHRVSummary(date)
    ]);

    const { restingHR, calories } = dailySummary;
    if (!window.fitdashOverlayData) window.fitdashOverlayData = {};

    window.fitdashOverlayData.workouts = [...(window.fitdashOverlayData.workouts || []), ...workouts];
    window.fitdashOverlayData.sleepPhases = [...(window.fitdashOverlayData.sleepPhases || []), ...sleepPhases];
    for (const phase of sleepPhases) indexSleepPhase(phase);
    if (sleepSummary) {
        window.fitdashOverlayData.sleepStatsByDate = {
            ...(window.fitdashOverlayData.sleepStatsByDate || {}),
            [formattedDate]: sleepSummary
        };
    }
    window.fitdashOverlayData.restingHRByDate = {
        ...(window.fitdashOverlayData.restingHRByDate || {}),
        [formattedDate]: restingHR
    };
    invalidateRestingHRCache();
    window.fitdashOverlayData.dailySummaries = {
        ...(window.fitdashOverlayData.dailySummaries || {}),
        [formattedDate]: { restingHR, calories }
    };
    window.fitdashOverlayData.hrvByDate = {
        ...(window.fitdashOverlayData.hrvByDate || {}),
        [formattedDate]: hrv // { dailyRmssd, deepRmssd } or null
    };
}

// Append new data to the chart. Caller is responsible for triggering a redraw
// (processLoadQueue does this in its per-date finally block).
function addDataToChart(chart, newData, date) {
    const formattedDate = getLocalDateString(date);
    const newPoints = newData.map(entry => ({
        x: new Date(`${formattedDate}T${entry.time}`).getTime(),
        y: entry.value,
    }));
    chart.data.datasets[0].data = [...newPoints, ...chart.data.datasets[0].data];
}

const summaryBubblePlugin = {
    id: 'summaryBubblePlugin',
    beforeDatasetsDraw(chart) {
        const { ctx, chartArea: area, scales: { x } } = chart;
        const summaries = window.fitdashOverlayData?.dailySummaries || {};
        const scale = getChartFontScale(chart);
        const compact = chart.width < 560;
        const bubbleTopOffset = Math.round(22 * scale);
        const BUBBLE_GAP = 6;

        _bubbleHitRegions.length = 0;

        // Build the draw queue: one entry per visible per-day bubble (anchored
        // at the next day's midnight) plus the "Now" bubble at the live cursor.
        const queue = [];
        const summaryDates = Object.keys(summaries).sort();
        for (let i = 0; i < summaryDates.length - 1; i++) {
            const dateStr = summaryDates[i];
            const summary = summaries[dateStr];
            if (summary?.calories == null) continue;
            const xPos = x.getPixelForValue(new Date(`${summaryDates[i + 1]}T00:00:00`));
            if (xPos < area.left || xPos > area.right) continue;
            queue.push({
                x: xPos,
                labelDate: new Date(`${dateStr}T00:00:00`),
                calories: summary.calories,
                highlight: false,
                dateKey: dateStr,
                respectOverlap: true,
            });
        }
        const now = new Date();
        const todayStr = getLocalDateString(now);
        const todaySummary = summaries[todayStr];
        const latestX = x.getPixelForValue(now);
        if (latestX >= area.left && latestX <= area.right && todaySummary?.calories != null) {
            queue.push({
                x: latestX,
                labelDate: new Date(`${todayStr}T00:00:00`),
                calories: todaySummary.calories,
                highlight: true,
                dateKey: todayStr,
                respectOverlap: false,
            });
        }

        ctx.save();
        ctx.textAlign = 'center';
        ctx.font = scaledFont('bold 12px sans-serif', scale);
        ctx.textBaseline = 'bottom';

        // Pass 1: draw every non-expanded bubble. Per-day bubbles respect the
        // overlap chain; the "Now" bubble ignores it so the live readout
        // always wins. The expanded bubble (if any) is deferred to pass 2.
        let minLeft = -Infinity;
        let expandedSpec = null;
        for (const spec of queue) {
            if (spec.dateKey === _expandedBubbleDate) {
                expandedSpec = spec;
                continue;
            }
            const limit = spec.respectOverlap ? minLeft : -Infinity;
            const drawn = drawBubble(
                ctx, spec.x, area.top + bubbleTopOffset,
                spec.labelDate, spec.calories,
                spec.highlight, scale, compact, limit
            );
            if (drawn) {
                _bubbleHitRegions.push({ dateKey: spec.dateKey, ...drawn });
                if (spec.respectOverlap) minLeft = drawn.right + BUBBLE_GAP;
            }
        }

        // Pass 2: the expanded bubble draws last so it sits on top, ignores
        // overlap, clamps to the chart area, and runs in full (non-compact) mode.
        if (expandedSpec) {
            const clampX = { min: area.left + 4, max: area.right - 4 };
            const drawn = drawBubble(
                ctx, expandedSpec.x, area.top + bubbleTopOffset,
                expandedSpec.labelDate, expandedSpec.calories,
                expandedSpec.highlight, scale, false, -Infinity, true, clampX
            );
            if (drawn) _bubbleHitRegions.push({ dateKey: expandedSpec.dateKey, ...drawn });
        }

        ctx.restore();
    }
};

function formatDuration(minutes) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function drawBubble(ctx, x, y, dateStr, calories, highlight = false, scale = 1, compact = false, minLeft = -Infinity, expanded = false, clampX = null) {
    const date = new Date(dateStr);
    // Expanded always uses the long date; compact short-form only when not expanded.
    const label = (compact && !expanded)
        ? date.toLocaleDateString('en-US', { weekday: 'short' })
        : date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    const dateKey = getLocalDateString(new Date(dateStr));
    const rhr = window.fitdashOverlayData?.restingHRByDate?.[dateKey];
    const hrv = window.fitdashOverlayData?.hrvByDate?.[dateKey];
    const sleep = window.fitdashOverlayData?.sleepStatsByDate?.[dateKey];
    const drinks = window.fitdashOverlayData?.drinksByDate?.[dateKey];

    // Per-line font floors keep bubble text readable when the global scale
    // would otherwise crush it below ~8px on phone-sized chart widths.
    // Expanded mode bumps everything to at least 1.1× so the "popped" bubble
    // is visibly bigger than its neighbors even on a desktop where scale=1.
    const effectiveScale = expanded ? Math.max(1.1, scale) : scale;
    const HEADER = scaledFont('bold 13px sans-serif', Math.max(effectiveScale, 11 / 13));
    const BODY = scaledFont('12px sans-serif', Math.max(effectiveScale, 10 / 12));
    const DIM = scaledFont('10px sans-serif', Math.max(effectiveScale, 9 / 10));

    const lines = [
        { text: `${label} · ${calories.toLocaleString()} cal`, font: HEADER, color: '#222' }
    ];

    if (compact) {
        // Tight viewport: one combined stat line (HR + sleep total), no HRV,
        // no per-stage breakdown. Keep drinks since they're a single short row.
        const parts = [];
        if (rhr) parts.push(`❤ ${rhr}`);
        if (sleep?.total > 0) parts.push(`💤 ${formatDuration(sleep.total)}`);
        if (parts.length) lines.push({ text: parts.join('  '), font: BODY, color: '#333' });
    } else {
        const hrParts = [];
        if (rhr) hrParts.push(`❤ ${rhr}`);
        if (hrv?.dailyRmssd != null) hrParts.push(`💓 ${Math.round(hrv.dailyRmssd)} / ${Math.round(hrv.deepRmssd)}`);
        if (hrParts.length) lines.push({ text: hrParts.join('   '), font: BODY, color: '#333' });

        if (sleep?.total > 0) {
            lines.push({ text: `💤 ${formatDuration(sleep.total)}`, font: BODY, color: '#333' });
            const hasStages = (sleep.light + sleep.deep + sleep.rem) > 0;
            if (hasStages) {
                let stages = `L ${formatDuration(sleep.light)}  D ${formatDuration(sleep.deep)}  R ${formatDuration(sleep.rem)}`;
                if (sleep.asleep > 0) stages += `  A ${formatDuration(sleep.asleep)}`;
                lines.push({ text: stages, font: DIM, color: '#666' });
            }
        }
    }

    if (drinks && drinks.length) {
        lines.push({ type: 'drinks', segments: drinksToSegments(drinks), font: BODY, color: '#333' });
    }

    const padding = 6;
    const lineHeightFor = font => parseInt(font.match(/(\d+)px/)[1], 10) + 3;

    // Drinks line: dark inset bubble for emoji/×N contrast.
    const DRINKS_INSET_PAD_X = 6;
    const DRINKS_INSET_PAD_Y = 2;
    const DRINKS_INSET_RADIUS = 4;

    const segmentWidth = (seg) => {
        const full = ctx.measureText(seg.text).width;
        return seg.type === 'half' ? full / 2 : full;
    };
    const drinksLineWidth = (line) => line.segments.reduce((sum, s) => sum + segmentWidth(s), 0);
    const lineExtraHeight = (line) => line.type === 'drinks' ? DRINKS_INSET_PAD_Y * 2 : 0;
    const lineWidth = (line) => {
        ctx.font = line.font;
        if (line.type !== 'drinks') return ctx.measureText(line.text).width;
        return drinksLineWidth(line) + DRINKS_INSET_PAD_X * 2;
    };

    let maxWidth = 0;
    let height = padding * 2;
    for (const line of lines) {
        const w = lineWidth(line);
        if (w > maxWidth) maxWidth = w;
        height += lineHeightFor(line.font) + lineExtraHeight(line);
    }
    const width = maxWidth + padding * 2;

    const radius = 6;
    let left = x - width / 2;
    const top = y;

    // Expanded bubble may overflow the chart area near edges; clamp inward so
    // the full content stays visible. Non-expanded bubbles ignore this.
    if (clampX) {
        if (left < clampX.min) left = clampX.min;
        else if (left + width > clampX.max) left = clampX.max - width;
    }

    // Caller passes minLeft (previous bubble's right edge + gap) to suppress
    // overlap; if we'd collide, skip drawing entirely and signal that.
    if (left < minLeft) return null;

    // Bubble background
    ctx.fillStyle = highlight ? 'rgba(255, 255, 200, 0.9)' : 'rgba(230, 240, 255, 0.85)';
    ctx.beginPath();
    ctx.moveTo(left + radius, top);
    ctx.lineTo(left + width - radius, top);
    ctx.quadraticCurveTo(left + width, top, left + width, top + radius);
    ctx.lineTo(left + width, top + height - radius);
    ctx.quadraticCurveTo(left + width, top + height, left + width - radius, top + height);
    ctx.lineTo(left + radius, top + height);
    ctx.quadraticCurveTo(left, top + height, left, top + height - radius);
    ctx.lineTo(left, top + radius);
    ctx.quadraticCurveTo(left, top, left + radius, top);
    ctx.closePath();
    ctx.fill();

    // Bubble text
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let cursorY = top + padding;
    for (const line of lines) {
        ctx.font = line.font;
        ctx.fillStyle = line.color;
        if (line.type === 'drinks') {
            const lineHeight = lineHeightFor(line.font);
            const segWidth = drinksLineWidth(line);
            const insetWidth = segWidth + DRINKS_INSET_PAD_X * 2;
            const insetHeight = lineHeight + DRINKS_INSET_PAD_Y * 2;
            const insetLeft = x - insetWidth / 2;
            const insetTop = cursorY;
            const r = DRINKS_INSET_RADIUS;

            // Inset background
            ctx.fillStyle = 'rgba(40, 40, 60, 0.85)';
            ctx.beginPath();
            ctx.moveTo(insetLeft + r, insetTop);
            ctx.lineTo(insetLeft + insetWidth - r, insetTop);
            ctx.quadraticCurveTo(insetLeft + insetWidth, insetTop, insetLeft + insetWidth, insetTop + r);
            ctx.lineTo(insetLeft + insetWidth, insetTop + insetHeight - r);
            ctx.quadraticCurveTo(insetLeft + insetWidth, insetTop + insetHeight, insetLeft + insetWidth - r, insetTop + insetHeight);
            ctx.lineTo(insetLeft + r, insetTop + insetHeight);
            ctx.quadraticCurveTo(insetLeft, insetTop + insetHeight, insetLeft, insetTop + insetHeight - r);
            ctx.lineTo(insetLeft, insetTop + r);
            ctx.quadraticCurveTo(insetLeft, insetTop, insetLeft + r, insetTop);
            ctx.closePath();
            ctx.fill();

            // Segments. Emoji glyphs render as colored bitmaps regardless of
            // fillStyle; white fill only affects the "×N" text segments.
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'left';
            const segCursorY = cursorY + DRINKS_INSET_PAD_Y;
            let cursorX = x - segWidth / 2;
            for (const seg of line.segments) {
                const fullW = ctx.measureText(seg.text).width;
                if (seg.type === 'half') {
                    const halfW = fullW / 2;
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(cursorX, segCursorY, halfW, lineHeight);
                    ctx.clip();
                    ctx.fillText(seg.text, cursorX, segCursorY);
                    ctx.restore();
                    cursorX += halfW;
                } else {
                    ctx.fillText(seg.text, cursorX, segCursorY);
                    cursorX += fullW;
                }
            }
            ctx.textAlign = 'center';
        } else {
            ctx.fillText(line.text, x, cursorY);
        }
        cursorY += lineHeightFor(line.font) + lineExtraHeight(line);
    }

    return { left, right: left + width, top, bottom: top + height };
}

const _stripePatternByCtx = new WeakMap();
function getLoadingStripePattern(ctx) {
    const cached = _stripePatternByCtx.get(ctx);
    if (cached) return cached;
    const off = document.createElement('canvas');
    const TILE = 12;
    off.width = TILE;
    off.height = TILE;
    const octx = off.getContext('2d');
    octx.fillStyle = 'rgba(120, 120, 120, 0.18)';
    octx.fillRect(0, 0, TILE, TILE);
    octx.strokeStyle = 'rgba(220, 220, 220, 0.22)';
    octx.lineWidth = 2;
    octx.beginPath();
    octx.moveTo(-2, TILE + 2); octx.lineTo(TILE + 2, -2);
    octx.moveTo(-2, TILE * 2 + 2); octx.lineTo(TILE + 2, TILE - 2);
    octx.stroke();
    const pattern = ctx.createPattern(off, 'repeat');
    _stripePatternByCtx.set(ctx, pattern);
    return pattern;
}

const loadingStripesPlugin = {
    id: 'loadingStripesPlugin',
    beforeDatasetsDraw(chart) {
        if (!queuedOrLoadingDates.size) return;
        const { ctx, chartArea: area, scales: { x } } = chart;
        const pattern = getLoadingStripePattern(ctx);
        if (!pattern) return;
        const MS_PER_DAY = 86400000;
        ctx.save();
        ctx.fillStyle = pattern;
        for (const dateStr of queuedOrLoadingDates) {
            const dayStart = new Date(`${dateStr}T00:00:00`);
            const dayEnd = new Date(dayStart.getTime() + MS_PER_DAY);
            const xStart = x.getPixelForValue(dayStart);
            const xEnd = x.getPixelForValue(dayEnd);
            if (xEnd < area.left || xStart > area.right) continue;
            const left = Math.max(area.left, xStart);
            const right = Math.min(area.right, xEnd);
            ctx.fillRect(left, area.top, right - left, area.bottom - area.top);
        }
        ctx.restore();
    }
};

const workoutOverlayPlugin = {
    id: 'workoutOverlayPlugin',
    beforeDatasetsDraw(chart) {
        const workouts = window.fitdashOverlayData?.workouts || [];
        const { ctx, chartArea: area, scales: { x } } = chart;
        const xMin = x.min, xMax = x.max;

        ctx.save();
        ctx.fillStyle = 'rgba(123,253,109,0.51)'; // orange

        workouts.forEach(({ start, end }) => {
            const startMs = start.getTime();
            const endMs = end.getTime();
            if (endMs < xMin || startMs > xMax) return;
            const xStart = x.getPixelForValue(startMs);
            const xEnd = x.getPixelForValue(endMs);
            ctx.fillRect(xStart, area.top, xEnd - xStart, area.bottom - area.top);
        });

        ctx.restore();
    }
};

const sleepOverlayPlugin = {
    id: 'sleepOverlayPlugin',
    beforeDatasetsDraw(chart) {
        const sleepPhases = window.fitdashOverlayData?.sleepPhases || [];
        const { ctx, chartArea: area, scales: { x } } = chart;
        const xMin = x.min, xMax = x.max;

        const stageColors = {
            light:  'rgba(70,130,200,0.35)', // steel blue
            deep:   'rgba(60,20,140,0.65)',  // indigo
            rem:    'rgba(180,80,220,0.55)', // violet
            wake:   'rgba(200,160,40,0.45)', // amber
            asleep: 'rgba(90,160,190,0.45)', // teal — classic-mode "asleep" (no stage breakdown)
        };

        ctx.save();

        sleepPhases.forEach(({ start, end, stage }) => {
            const startMs = start.getTime();
            const endMs = end.getTime();
            if (endMs < xMin || startMs > xMax) return;
            const xStart = x.getPixelForValue(startMs);
            const xEnd = x.getPixelForValue(endMs);
            ctx.fillStyle = stageColors[stage] || 'rgba(0,0,0,0.05)';
            ctx.fillRect(xStart, area.top, xEnd - xStart, area.bottom - area.top);
        });

        ctx.restore();
    }
};

const restingHrPlugin = {
    id: 'restingHrPlugin',
    beforeDraw(chart) {
        const { ctx, chartArea: area, scales: { x, y } } = chart;
        const restingHRs = window.fitdashOverlayData?.restingHRByDate || {};

        ctx.save();
        ctx.strokeStyle = 'rgba(0,255,224,0.88)';
        ctx.setLineDash([4, 4]);

        for (const [dateStr, hr] of Object.entries(restingHRs)) {
            if (!hr) continue;

            const hrY = y.getPixelForValue(hr);
            const date = new Date(dateStr + 'T00:00:00');
            const startX = x.getPixelForValue(date);
            const endX = x.getPixelForValue(new Date(date.getTime() + 24 * 60 * 60 * 1000));

            if (endX >= area.left && startX <= area.right) {
                ctx.beginPath();
                ctx.moveTo(startX, hrY);
                ctx.lineTo(endX, hrY);
                ctx.stroke();
            }
        }

        ctx.restore();
    }
};

const _midnightLabelCache = new Map();
function getMidnightLabel(midnight) {
    const key = midnight.getTime();
    if (_midnightLabelCache.has(key)) return _midnightLabelCache.get(key);
    const label = midnight.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric'
    });
    _midnightLabelCache.set(key, label);
    return label;
}

const midnightMarkerPlugin = {
    id: 'midnightMarkerPlugin',
    beforeDatasetsDraw(chart) {
        const { ctx, chartArea: area, scales: { x } } = chart;

        const start = x.getUserBounds().min;
        const end = x.getUserBounds().max;

        const startDate = new Date(start);
        startDate.setHours(0, 0, 0, 0);

        const MS_PER_DAY = 24 * 60 * 60 * 1000;
        const numDays = Math.ceil((end - startDate) / MS_PER_DAY);

        ctx.save();
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = 'rgba(146,146,255,0.78)';
        ctx.fillStyle = 'rgba(103,220,255,0.9)';
        ctx.font = scaledFont('12px sans-serif', getChartFontScale(chart));
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        for (let i = 0; i <= numDays; i++) {
            const midnight = new Date(startDate.getTime() + i * MS_PER_DAY);
            const xPos = x.getPixelForValue(midnight);

            if (xPos >= area.left && xPos <= area.right) {
                // Draw vertical line
                ctx.beginPath();
                ctx.moveTo(xPos, area.top);
                ctx.lineTo(xPos, area.bottom);
                ctx.stroke();

                const label = getMidnightLabel(midnight);

                // Draw label above the line
                ctx.fillText(label, xPos, area.top + 4);
            }
        }

        ctx.restore();
    }
};



const _hrColorCache = new Map();
function getHRGradientColor(hr, restingHR = 60) {
    const key = hr * 1000 + restingHR;
    if (_hrColorCache.has(key)) return _hrColorCache.get(key);

    let result;
    if (hr < restingHR) {
        // Below resting: blue → purple
        const minHR = 40;  // minimum expected HR
        const ratio = Math.max(0, Math.min(1, (hr - minHR) / (restingHR - minHR)));
        const hue = 270 - (70 * ratio);  // 270 → 200
        result = `hsl(${hue}, 100%, 50%)`;
    } else {
        // Above resting: standard zone colors
        const zones = [
            { min: restingHR, max: 111, startHue: 200, endHue: 200 },
            { min: 111, max: 136, startHue: 200, endHue: 50 },
            { min: 136, max: 162, startHue: 50, endHue: 25 },
            { min: 162, max: 220, startHue: 25, endHue: 0 }
        ];

        result = 'hsl(0, 100%, 50%)'; // max red fallback
        for (const zone of zones) {
            if (hr < zone.max) {
                const ratio = (hr - zone.min) / (zone.max - zone.min);
                const hue = zone.startHue + (zone.endHue - zone.startHue) * ratio;
                result = `hsl(${hue}, 100%, 50%)`;
                break;
            }
        }
    }

    _hrColorCache.set(key, result);
    return result;
}



function displayHeartRateChart(points) {
    const ctx = document.getElementById('heartrateChart').getContext('2d');

    Chart.register(
        loadingStripesPlugin,
        workoutOverlayPlugin,
        sleepOverlayPlugin,
        restingHrPlugin,
        midnightMarkerPlugin,
        summaryBubblePlugin,
        workoutEmojiPlugin
    );

    _heartRateChart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: 'Heart Rate (BPM)',
                data: points,
                parsing: false,    // points are already {x, y} — skip Chart.js parsing
                normalized: true,  // tell Chart.js the data is sorted by x
                borderColor: 'rgba(99, 160, 255, 1)',  // fallback
                pointRadius: 0,
                pointRadiusOnHover: 0,
                fill: false,
                tension: 0,

                segment: {
                    borderColor: ctx => {
                        const hr = ctx.p1.parsed.y;
                        const restingHR = getCachedRestingHR(ctx.p1.parsed.x);
                        return getHRGradientColor(hr, restingHR);
                    }
                }
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,  // let CSS-sized container govern dimensions
            animation: false,  // skip the initial-render animation
            // Tap/click toggles the daily-summary bubble between compact and
            // expanded (full info, enlarged, on top). Hit-tests against the
            // bounds collected by summaryBubblePlugin on its last draw.
            // Iterates back-to-front so the expanded bubble (pushed last)
            // wins ties with whatever it overlaps.
            onClick: (event, _elements, chart) => {
                const px = event.x, py = event.y;
                if (px == null || py == null) return;
                for (let i = _bubbleHitRegions.length - 1; i >= 0; i--) {
                    const r = _bubbleHitRegions[i];
                    if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
                        _expandedBubbleDate = _expandedBubbleDate === r.dateKey ? null : r.dateKey;
                        chart.update('none');
                        return;
                    }
                }
                if (_expandedBubbleDate != null) {
                    _expandedBubbleDate = null;
                    chart.update('none');
                }
            },
            interaction: {
                mode: 'nearest',
                intersect: false,
            },
            plugins: {
                decimation: {
                    enabled: true,
                    algorithm: 'lttb',
                    samples: 1500,
                },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            const hr = context.parsed.y;
                            const sleep = findSleepPhaseAt(context.parsed.x);

                            const lines = [`❤️ ${hr} BPM`];

                            if (sleep) {
                                const stageLabels = {
                                    light: 'Light', deep: 'Deep', rem: 'REM', wake: 'Awake',
                                    asleep: 'Asleep', awake: 'Awake', restless: 'Restless',
                                };
                                lines.push(`💤 ${stageLabels[sleep.stage] || sleep.stage}`);
                            }

                            return lines;
                        }
                    },
                },
                zoom: {
                    pan: {
                        enabled: true,
                        mode: 'x',
                        threshold: 5,
                        onPan: onPan,  // Handle panning to load previous dates
                    },
                    zoom: {
                        wheel: {
                            enabled: true,
                        },
                        pinch: {
                            enabled: true,
                        },
                        mode: 'x',
                        onZoom: onZoom,
                    },
                },
                legend: {
                    display: false,
                },
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'minute',
                        displayFormats: {
                            minute: 'h:mm a',  // AM/PM format
                        },
                        tooltipFormat: 'MMMM d, h:mm a',  // Full date and time in tooltip
                    },
                    grid: {
                        color: 'rgba(255,255,255,0.1)',
                    },
                    ticks: {
                        color: '#ccc',
                        autoSkip: true,
                        maxTicksLimit: 10,
                        callback: (function () {

                            return function (value, index) {
                                const date = new Date(value);
                                date.toDateString();
                                return date.toLocaleTimeString([], {
                                    hour: 'numeric',
                                    minute: '2-digit',
                                    hour12: true
                                });
                            };
                        })()
                    },
                    title: {
                        display: true,
                        text: 'Time of Day',
                    },
                },
                y: {
                    title: {
                        display: true,
                        text: 'Heart Rate (BPM)',
                    },
                    suggestedMin: 40,
                    suggestedMax: 200,
                },
            },
        },
    });
}



// Add a date to the load queue if it hasn't been fetched or queued yet.
// `loadedDates` is set inside fetchHeartRateDataForDate the moment a fetch
// starts (and only cleared on error), so it doubles as a "fetch already
// initiated" guard here.
function enqueueDate(dateStr) {
    if (loadedDates.has(dateStr)) return false;
    if (queuedOrLoadingDates.has(dateStr)) return false;
    if (dateStr > getLocalDateString(new Date())) return false;
    queuedOrLoadingDates.add(dateStr);
    loadQueue.push(dateStr);
    return true;
}

async function processLoadQueue(chart) {
    if (isProcessingLoadQueue) return;
    isProcessingLoadQueue = true;
    try {
        while (loadQueue.length) {
            const dateStr = loadQueue.shift();
            const date = new Date(`${dateStr}T00:00:00`);
            try {
                const data = await fetchHeartRateDataForDate(date);
                await fetchOverlayDataForDate(date);
                if (data.length > 0) {
                    addDataToChart(chart, data, date);
                    if (date < currentStartDate) currentStartDate = date;
                }
            } catch (e) {
                console.warn('queued load failed', dateStr, e);
            } finally {
                queuedOrLoadingDates.delete(dateStr);
                chart.update('none');
            }
        }
    } finally {
        isProcessingLoadQueue = false;
    }
}

// Enqueue every visible day (most-recent-first so the chart fills inward
// toward already-loaded data). Pass includePrior to also queue the day just
// before the leftmost visible date — used by the "Fetch visible" button so
// the user always has at least one day of headroom past the viewport.
function queueVisibleDates(chart, { includePrior = false } = {}) {
    if (!chart) return;
    const xScale = chart.scales.x;
    const xMin = xScale.min;
    const xMax = xScale.max;
    if (xMin == null || xMax == null) return;
    const startDay = new Date(xMin);
    startDay.setHours(0, 0, 0, 0);
    const MS_PER_DAY = 86400000;
    const days = [];
    for (let t = startDay.getTime(); t <= xMax; t += MS_PER_DAY) {
        days.push(getLocalDateString(new Date(t)));
    }
    if (includePrior && days.length) {
        const first = new Date(`${days[0]}T00:00:00`);
        first.setDate(first.getDate() - 1);
        days.unshift(getLocalDateString(first));
    }
    days.reverse();
    let queued = false;
    for (const d of days) {
        if (enqueueDate(d)) queued = true;
    }
    if (queued) {
        // Chart.js's zoom plugin already redraws per pan/zoom event, so we
        // skip an explicit update here. Callers outside that loop (e.g. the
        // manual "Fetch visible" button) must trigger their own redraw.
        processLoadQueue(chart);
    }
}

function onPan({ chart }) {
    queueVisibleDates(chart);
}

function onZoom({ chart }) {
    queueVisibleDates(chart);
}

// Main function to fetch today's data and render the chart
async function fetchHeartRateData() {
    const today = new Date();

    const [heartRateData, workouts, { phases: sleepPhases, summary: sleepSummary }, dailySummary, hrv, drinksByDate] = await Promise.all([
        fetchHeartRateDataForDate(today),
        fetchWorkoutSessions(today),
        fetchSleepPhases(today),
        fetchDailySummary(today),
        fetchHRVSummary(today),
        fetchDrinksByDate()
    ]);

    if (heartRateData.length === 0) {
        alert("Failed to get today's data");
        return;
    }

    const { restingHR, calories } = dailySummary;
    const todayKey = getLocalDateString(today);
    const points = heartRateData.map(entry => ({
        x: new Date(`${todayKey}T${entry.time}`).getTime(),
        y: entry.value,
    }));

    window.fitdashOverlayData = {
        workouts,
        sleepPhases,
        ...(sleepSummary ? { sleepStatsByDate: { [todayKey]: sleepSummary } } : {}),
        restingHRByDate: { [todayKey]: restingHR },
        dailySummaries: {
            [todayKey]: { restingHR, calories }
        }
    };
    for (const phase of sleepPhases) indexSleepPhase(phase);
    window.fitdashOverlayData.hrvByDate = {
        ...(window.fitdashOverlayData.hrvByDate || {}),
        [getLocalDateString(today)]: hrv // { dailyRmssd, deepRmssd } or null
    };
    window.fitdashOverlayData.drinksByDate = drinksByDate || {};
    invalidateRestingHRCache();

    displayHeartRateChart(points);
}


document.getElementById('heartrateChart').addEventListener('mousedown', (event) => {
    event.preventDefault();  // Prevent browser from selecting or dragging the chart element
});

function getHashParam(name) {
    const m = window.location.hash.match(new RegExp(`${name}=([^&]*)`));
    return m ? decodeURIComponent(m[1]) : null;
}

function safeRedirectToAuth() {
    // prevent loops
    localStorage.setItem('auth_in_progress', '1');
    window.location.href = AUTH_URL;
}

async function testToken(token) {
    try {
        const res = await fitbitFetch('https://api.fitbit.com/1/user/-/profile.json', {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (res.status === 401) return false;   // definitely invalid
        if (!res.ok) {
            // transient error (proxy hiccup, 5xx, etc.) -> don't invalidate token
            console.warn('testToken non-OK:', res.status);
            return true;
        }
        return true;
    } catch (e) {
        console.warn('testToken error (treat as transient):', e);
        return true;
    }
}

async function initApp() {
    // 1) Handle callback (hash) first
    const accessFromHash = getHashParam('access_token');
    if (accessFromHash) {
        localStorage.setItem('fitbit_access_token', accessFromHash);
        localStorage.removeItem('auth_in_progress');
        // Strip hash without reloading to avoid double-runs
        history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    const token = localStorage.getItem('fitbit_access_token');

    // 2) If no token…
    if (!token) {
        // If we just came from Fitbit and still no token, stop ping-ponging
        const cameFromFitbit = document.referrer && document.referrer.includes('fitbit.com');
        const alreadyAuthing = localStorage.getItem('auth_in_progress') === '1';

        if (cameFromFitbit || alreadyAuthing) {
            console.error('Auth failed or cancelled. Not redirecting again.');
            // (Optional) show a UI to retry auth
            return;
        }

        // Start one controlled auth attempt
        safeRedirectToAuth();
        return;
    }

    // 3) Validate token (but be forgiving on transient failures)
    const valid = await testToken(token);
    if (!valid) {
        // Only clear on confirmed 401 invalid token
        localStorage.removeItem('fitbit_access_token');
        safeRedirectToAuth();
        return;
    }

    // 4) Ready
    fetchHeartRateData();
}
window.onload = initApp;

document.getElementById('reauthBtn').addEventListener('click', () => {
    localStorage.removeItem('fitbit_access_token');
    localStorage.removeItem('auth_in_progress');
    safeRedirectToAuth();
});

document.getElementById('fetchVisibleBtn').addEventListener('click', () => {
    queueVisibleDates(_heartRateChart, { includePrior: true });
    _heartRateChart?.update('none');
});
