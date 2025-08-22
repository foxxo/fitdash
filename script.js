const CLIENT_ID = '23PXJV';
const REDIRECT_URI = 'https://foxxo.github.io/fitdash/';
const AUTH_URL = `https://www.fitbit.com/oauth2/authorize?response_type=token&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=activity%20heartrate%20sleep%20profile&expires_in=604800`;
const NETLIFY_BASE = "https://fitdashproxy.netlify.app/.netlify/functions/fitbit-proxy";

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

function getLocalDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
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


function getWorkoutEmoji(activityName) {
    const name = activityName.toLowerCase();
    if (name.includes("walk")) return "👟";
    if (name.includes("sport")) return "🤺";
    if (name.includes("aerobic")) return "🕺";

    return "💪";
}

const workoutEmojiPlugin = {
    id: 'workoutEmojiPlugin',
    afterDatasetsDraw(chart) {
        const workouts = window.fitdashOverlayData?.workouts || [];
        const { ctx, chartArea: area, scales: { x } } = chart;

        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        workouts.forEach(({ start, activityName, calories, end }) => {
            const xPos = (x.getPixelForValue(start) + x.getPixelForValue(end)) / 2;
            if (xPos >= area.left && xPos <= area.right) {
                const emoji = getWorkoutEmoji(activityName);
                const emojiY = area.bottom + 4;
                const textY = emojiY + 32; // Push second line down

                ctx.fillStyle = 'rgb(255,255,255)'; // Ensure full opacity
                ctx.font = '32px sans-serif';
                ctx.fillText(emoji, xPos, emojiY);
                ctx.font = '12px sans-serif'; // Smaller for text
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

    if (!response.ok) return [];

    const data = await response.json();
    const sleepEntries = data.sleep || [];
    const phases = [];

    for (const session of sleepEntries) {
        if (session.levels && session.levels.data) {
            for (const stage of session.levels.data) {
                phases.push({
                    start: new Date(stage.dateTime),
                    end: new Date(new Date(stage.dateTime).getTime() + stage.seconds * 1000),
                    stage: stage.level
                });
            }
        }
    }
    return phases;
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

    const [workouts, sleepPhases, dailySummary, hrv] = await Promise.all([
        fetchWorkoutSessions(date),
        fetchSleepPhases(date),
        fetchDailySummary(date),
        fetchHRVSummary(date)
    ]);

    const { restingHR, calories } = dailySummary;
    if (!window.fitdashOverlayData) window.fitdashOverlayData = {};

    window.fitdashOverlayData.workouts = [...(window.fitdashOverlayData.workouts || []), ...workouts];
    window.fitdashOverlayData.sleepPhases = [...(window.fitdashOverlayData.sleepPhases || []), ...sleepPhases];
    window.fitdashOverlayData.restingHRByDate = {
        ...(window.fitdashOverlayData.restingHRByDate || {}),
        [formattedDate]: restingHR
    };
    window.fitdashOverlayData.dailySummaries = {
        ...(window.fitdashOverlayData.dailySummaries || {}),
        [formattedDate]: { restingHR, calories }
    };
    window.fitdashOverlayData.hrvByDate = {
        ...(window.fitdashOverlayData.hrvByDate || {}),
        [formattedDate]: hrv // { dailyRmssd, deepRmssd } or null
    };
}

// Function to add new data to the chart
function addDataToChart(chart, newData, date) {
    const formattedDate = getLocalDateString(date);
    const timeLabels = newData.map(entry => `${formattedDate}T${entry.time}`);
    const heartRateValues = newData.map(entry => entry.value);

    // Convert times to Date objects and prepend to chart data
    const fullDateLabels = timeLabels.map(time => new Date(time));
    chart.data.labels.unshift(...fullDateLabels);
    chart.data.datasets[0].data.unshift(...heartRateValues);

    chart.update();
}

const summaryBubblePlugin = {
    id: 'summaryBubblePlugin',
    beforeDatasetsDraw(chart) {
        const { ctx, chartArea: area, scales: { x } } = chart;
        const summaries = window.fitdashOverlayData?.dailySummaries || {};

        const summaryDates = Object.keys(summaries).sort(); // Ensure date order

        ctx.save();
        ctx.textAlign = 'center';
        ctx.font = 'bold 12px sans-serif';
        ctx.textBaseline = 'bottom';

        for (let i = 0; i < summaryDates.length - 1; i++) {
            const dateStr = summaryDates[i]; // previous day
            const nextDateStr = summaryDates[i + 1]; // midnight of the next day

            const nextMidnight = new Date(`${nextDateStr}T00:00:00`);
            const xPos = x.getPixelForValue(nextMidnight);

            const summary = summaries[dateStr];

            if (xPos >= area.left && xPos <= area.right && summary?.calories != null) {
                const labelDate = new Date(`${dateStr}T00:00:00`);
                drawBubble(ctx, xPos, area.top + 22, labelDate, summary.calories);
            }
        }

        // "Now" bubble
        const now = new Date();
        const todayStr = getLocalDateString(now);
        const todaySummary = summaries[todayStr];
        const latestX = x.getPixelForValue(now);

        if (latestX >= area.left && latestX <= area.right && todaySummary?.calories != null) {
            const labelDate = new Date(`${todayStr}T00:00:00`);
            drawBubble(ctx, latestX, area.top + 22, labelDate, todaySummary.calories, true);
        }

        ctx.restore();
    }
};

function drawBubble(ctx, x, y, dateStr, calories, highlight = false) {
    const date = new Date(dateStr);
    const label = date.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric'
    });
    const calText = `${calories.toLocaleString()} cal`;

    // RHR for the day
    const dateKey = getLocalDateString(new Date(dateStr));
    const rhr = window.fitdashOverlayData?.restingHRByDate?.[dateKey];
    const hrv = window.fitdashOverlayData?.hrvByDate?.[dateKey];
    const hrvText = (hrv?.dailyRmssd != null) ? `Headline HRV : ${Math.round(hrv.dailyRmssd)}\nDeep HRV : ${Math.round(hrv.deepRmssd)}` : null;




    const text = `${label}\n${calText}\nRHR - ${rhr}`;
    const lines = text.split('\n');
    if (hrvText) lines.push(hrvText);
    const padding = 6;
    const lineHeight = 16;
    const width = Math.max(...lines.map(line => ctx.measureText(line).width)) + padding * 2;
    const height = lineHeight * lines.length + padding * 2;

    const radius = 6;
    const left = x - width / 2;
    const top = y;

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
    ctx.fillStyle = '#333';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    lines.forEach((line, index) => {
        ctx.fillText(line, x, top + padding + index * lineHeight);
    });
}

const workoutOverlayPlugin = {
    id: 'workoutOverlayPlugin',
    beforeDatasetsDraw(chart) {
        const workouts = window.fitdashOverlayData?.workouts || [];
        const { ctx, chartArea: area, scales: { x } } = chart;

        ctx.save();
        ctx.fillStyle = 'rgba(123,253,109,0.51)'; // orange

        workouts.forEach(({ start, end }) => {
            const xStart = x.getPixelForValue(start);
            const xEnd = x.getPixelForValue(end);

            if (xEnd >= area.left && xStart <= area.right) {
                ctx.fillRect(xStart, area.top, xEnd - xStart, area.bottom - area.top);
            }
        });

        ctx.restore();
    }
};

const sleepOverlayPlugin = {
    id: 'sleepOverlayPlugin',
    beforeDatasetsDraw(chart) {
        const sleepPhases = window.fitdashOverlayData?.sleepPhases || [];
        const { ctx, chartArea: area, scales: { x } } = chart;

        const stageColors = {
            light: 'rgba(105,218,255,0.4)', // light blue
            deep: 'rgba(138,43,226,0.74)',   // purple
            rem:  'rgba(233,113,248,0.66)',  // pink
            wake: 'rgba(255,228,152,0.66)'  // light gray
        };

        ctx.save();

        sleepPhases.forEach(({ start, end, stage }) => {
            const xStart = x.getPixelForValue(start);
            const xEnd = x.getPixelForValue(end);

            if (xEnd >= area.left && xStart <= area.right) {
                ctx.fillStyle = stageColors[stage] || 'rgba(0,0,0,0.05)';
                ctx.fillRect(xStart, area.top, xEnd - xStart, area.bottom - area.top);
            }
        });

        ctx.restore();
    }
};

const restingHrPlugin = {
    id: 'restingHrPlugin',
    beforeDraw(chart) {
        const { ctx, chartArea: area, scales: { x, y } } = chart;
        const restingHRs = window.fitdashOverlayData?.restingHRByDate || {};

        for (const [dateStr, hr] of Object.entries(restingHRs)) {
            if (!hr) continue;

            const hrY = y.getPixelForValue(hr);
            ctx.save();
            ctx.strokeStyle = 'rgba(0,255,224,0.88)';
            ctx.setLineDash([4, 4]);

            // Draw line only if visible
            const date = new Date(dateStr + 'T00:00:00');
            const startX = x.getPixelForValue(date);
            const endX = x.getPixelForValue(new Date(date.getTime() + 24 * 60 * 60 * 1000));

            if (endX >= area.left && startX <= area.right) {
                ctx.beginPath();
                ctx.moveTo(startX, hrY);
                ctx.lineTo(endX, hrY);
                ctx.stroke();
            }

            ctx.restore();
        }
    }
};

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
        ctx.font = '12px sans-serif';
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

                // Format label: "Mon, Mar 24"
                const label = midnight.toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric'
                });

                // Draw label above the line
                ctx.fillText(label, xPos, area.top + 4);
            }
        }

        ctx.restore();
    }
};



function getHRGradientColor(hr, restingHR = 60) {
    if (hr < restingHR) {
        // Below resting: blue → purple
        const minHR = 40;  // minimum expected HR
        const ratio = Math.max(0, Math.min(1, (hr - minHR) / (restingHR - minHR)));
        const hue = 270 - (70 * ratio);  // 270 → 200
        return `hsl(${hue}, 100%, 50%)`;
    }

    // Above resting: standard zone colors
    const zones = [
        { min: restingHR, max: 111, startHue: 200, endHue: 200 },
        { min: 111, max: 136, startHue: 200, endHue: 50 },
        { min: 136, max: 162, startHue: 50, endHue: 25 },
        { min: 162, max: 220, startHue: 25, endHue: 0 }
    ];

    for (const zone of zones) {
        if (hr < zone.max) {
            const ratio = (hr - zone.min) / (zone.max - zone.min);
            const hue = zone.startHue + (zone.endHue - zone.startHue) * ratio;
            return `hsl(${hue}, 100%, 50%)`;
        }
    }

    return 'hsl(0, 100%, 50%)'; // max red fallback
}



function displayHeartRateChart(labels, data) {
    const fullDateLabels = labels.map(time => {
        const [hours, minutes] = time.split(':').map(Number);
        const today = new Date();
        today.setHours(hours, minutes, 0, 0);  // Set the time (hours and minutes)
        return today;  // Return a Date object
    });

    const ctx = document.getElementById('heartrateChart').getContext('2d');

    Chart.register(
        workoutOverlayPlugin,
        sleepOverlayPlugin,
        restingHrPlugin,
        midnightMarkerPlugin,
        summaryBubblePlugin,
        workoutEmojiPlugin
    );

    new Chart(ctx, {
        type: 'line',
        data: {
            labels: fullDateLabels,
            datasets: [{
                label: 'Heart Rate (BPM)',
                data: data,
                borderColor: 'rgba(99, 160, 255, 1)',  // fallback
                pointRadius: 0,
                pointRadiusOnHover: 0,
                fill: false,
                tension: 0.1,

                segment: {
                    borderColor: ctx => {
                        const hr = ctx.p1.parsed.y;
                        const point = ctx.p1;
                        const time = new Date(point.parsed.x);
                        const dateStr = getLocalDateString(time);
                        const restingHR = window.fitdashOverlayData?.restingHRByDate?.[dateStr] || 66;
                        return getHRGradientColor(hr, restingHR);
                    }
                }
            }]
        },
        options: {
            responsive: true,
            interaction: {
                mode: 'nearest',
                intersect: false,
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            const hr = context.parsed.y;
                            const time = new Date(context.parsed.x);

                            // Sleep phase at this time
                            const sleepPhases = window.fitdashOverlayData?.sleepPhases || [];
                            const sleep = sleepPhases.find(phase =>
                                time >= phase.start && time <= phase.end
                            );

                            const lines = [`❤️ ${hr} BPM`];

                            if (sleep) lines.push(`💤 Sleep: ${sleep.stage}`);

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



// Handle panning: fetch previous day's data if necessary and force an update
async function onPan({ chart }) {
    const xScale = chart.scales.x;
    const minDate = new Date(xScale.min);  // Visible minimum date

    if (minDate < currentStartDate) {
        console.log("Panned left: fetching previous day's data...");

        // Fetch data for the previous day
        const newDate = new Date(currentStartDate);
        newDate.setDate(newDate.getDate() - 1);  // Go one day back

        const newData = await fetchHeartRateDataForDate(newDate);
        await fetchOverlayDataForDate(newDate);
        if (newData.length > 0) {
            addDataToChart(chart, newData, newDate);
            currentStartDate = newDate;  // Update start date to include the new data
        } else {
            console.log(`No data available for ${getLocalDateString(newDate)}.`);
        }

        // Force chart update immediately after data is added
        chart.update('none');
    }
}

// Main function to fetch today's data and render the chart
async function fetchHeartRateData() {
    const today = new Date();

    const [heartRateData, workouts, sleepPhases, dailySummary, hrv] = await Promise.all([
        fetchHeartRateDataForDate(today),
        fetchWorkoutSessions(today),
        fetchSleepPhases(today),
        fetchDailySummary(today),
        fetchHRVSummary(today)
    ]);

    if (heartRateData.length === 0) {
        alert("Failed to get today's data");
        return;
    }

    const timeLabels = heartRateData.map(entry => entry.time);
    const heartRateValues = heartRateData.map(entry => entry.value);
    const { restingHR, calories } = dailySummary;

    window.fitdashOverlayData = {
        workouts,
        sleepPhases,
        restingHRByDate: { [getLocalDateString(today)]: restingHR },
        dailySummaries: {
            [getLocalDateString(today)]: { restingHR, calories }
        }
    };
    window.fitdashOverlayData.hrvByDate = {
        ...(window.fitdashOverlayData.hrvByDate || {}),
        [getLocalDateString(today)]: hrv // { dailyRmssd, deepRmssd } or null
    };

    displayHeartRateChart(timeLabels, heartRateValues);  // Render the chart
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
