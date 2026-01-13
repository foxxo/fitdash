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
const loadingDates = new Set(); // Track in-progress loads
const loadingOverlayDates = new Set(); // Track in-progress overlay loads

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

    if (loadedDates.has(formattedDate) || loadingDates.has(formattedDate)) {
        return [];
    }

    loadingDates.add(formattedDate);

    try {
        const response = await fitbitFetch(`https://api.fitbit.com/1/user/-/activities/heart/date/${formattedDate}/1d/1min.json`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!response.ok) throw new Error('Failed to fetch HR');

        const data = await response.json();
        loadedDates.add(formattedDate);
        return data["activities-heart-intraday"].dataset || [];
    } catch (err) {
        console.error(`Error loading HR data for ${formattedDate}:`, err);
        return [];
    } finally {
        loadingDates.delete(formattedDate);
    }
}

async function fetchOverlayDataForDate(date) {
    const formattedDate = getLocalDateString(date);

    if (loadedOverlayDates.has(formattedDate) || loadingOverlayDates.has(formattedDate)) {
        return;
    }

    loadingOverlayDates.add(formattedDate);

    try {
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
            [formattedDate]: hrv
        };

        loadedOverlayDates.add(formattedDate);
    } catch (err) {
        console.error(`Error loading overlay data for ${formattedDate}:`, err);
    } finally {
        loadingOverlayDates.delete(formattedDate);
    }
}

function addDataToChart(chart, rawData, targetDate) {
    if (rawData.length === 0) return;

    const dateString = getLocalDateString(targetDate);
    const formattedData = rawData.map(entry => ({
        x: new Date(`${dateString}T${entry.time}`),
        y: entry.value
    }));

    chart.data.datasets[0].data = [...formattedData, ...chart.data.datasets[0].data];
    chart.data.datasets[0].data.sort((a, b) => a.x - b.x);
}

const sleepPhasePlugin = {
    id: 'sleepPhasePlugin',
    beforeDatasetsDraw(chart) {
        const sleepPhases = window.fitdashOverlayData?.sleepPhases || [];
        const { ctx, chartArea: area, scales: { x, y } } = chart;

        ctx.save();

        sleepPhases.forEach(phase => {
            const start = x.getPixelForValue(phase.start);
            const end = x.getPixelForValue(phase.end);

            if (start <= area.right && end >= area.left) {
                let color;
                switch (phase.stage) {
                    case 'deep': color = 'rgba(0, 0, 139, 0.2)'; break;
                    case 'light': color = 'rgba(135, 206, 250, 0.2)'; break;
                    case 'rem': color = 'rgba(148, 0, 211, 0.2)'; break;
                    case 'wake': color = 'rgba(255, 255, 0, 0.2)'; break;
                    default: color = 'rgba(200, 200, 200, 0.1)';
                }

                ctx.fillStyle = color;
                ctx.fillRect(
                    Math.max(start, area.left),
                    area.top,
                    Math.min(end, area.right) - Math.max(start, area.left),
                    area.bottom - area.top
                );
            }
        });

        ctx.restore();
    }
};

const restingHRLinePlugin = {
    id: 'restingHRLinePlugin',
    afterDatasetsDraw(chart) {
        if (!window.fitdashOverlayData?.restingHRByDate) return;

        const { ctx, chartArea: area, scales: { x, y } } = chart;
        ctx.save();

        const minDate = new Date(x.min);
        const maxDate = new Date(x.max);
        const startDate = new Date(minDate);
        startDate.setHours(0, 0, 0, 0);
        const endDate = new Date(maxDate);
        endDate.setHours(23, 59, 59, 999);

        const segments = [];
        let currentDate = new Date(startDate);

        while (currentDate <= endDate) {
            const dateStr = getLocalDateString(currentDate);
            const rhr = window.fitdashOverlayData.restingHRByDate[dateStr];

            if (rhr != null) {
                const segmentStart = new Date(currentDate);
                segmentStart.setHours(0, 0, 0, 0);
                const segmentEnd = new Date(currentDate);
                segmentEnd.setHours(23, 59, 59, 999);

                segments.push({
                    start: Math.max(segmentStart.getTime(), minDate.getTime()),
                    end: Math.min(segmentEnd.getTime(), maxDate.getTime()),
                    rhr
                });
            }

            currentDate.setDate(currentDate.getDate() + 1);
        }

        segments.forEach(seg => {
            const xStart = x.getPixelForValue(seg.start);
            const xEnd = x.getPixelForValue(seg.end);
            const yVal = y.getPixelForValue(seg.rhr);

            if (xStart <= area.right && xEnd >= area.left && yVal >= area.top && yVal <= area.bottom) {
                ctx.strokeStyle = 'rgba(255, 165, 0, 0.8)';
                ctx.lineWidth = 2;
                ctx.setLineDash([5, 3]);
                ctx.beginPath();
                ctx.moveTo(Math.max(xStart, area.left), yVal);
                ctx.lineTo(Math.min(xEnd, area.right), yVal);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        });

        ctx.restore();
    }
};

const dailySummaryPlugin = {
    id: 'dailySummaryPlugin',
    afterDatasetsDraw(chart) {
        const dailySummaries = window.fitdashOverlayData?.dailySummaries || {};
        const hrvByDate = window.fitdashOverlayData?.hrvByDate || {};
        const { ctx, chartArea: area, scales: { x } } = chart;

        ctx.save();

        const minDate = new Date(x.min);
        const maxDate = new Date(x.max);
        let currentDate = new Date(minDate);
        currentDate.setHours(0, 0, 0, 0);

        while (currentDate <= maxDate) {
            const dateStr = getLocalDateString(currentDate);
            const summary = dailySummaries[dateStr];
            const hrv = hrvByDate[dateStr];

            if (summary || hrv) {
                const dayStart = new Date(currentDate);
                dayStart.setHours(0, 0, 0, 0);
                const dayEnd = new Date(currentDate);
                dayEnd.setHours(23, 59, 59, 999);

                const xStart = x.getPixelForValue(dayStart);
                const xEnd = x.getPixelForValue(dayEnd);
                const xMid = (xStart + xEnd) / 2;

                if (xMid >= area.left && xMid <= area.right) {
                    const lines = [];
                    if (summary?.restingHR) lines.push(`RHR: ${summary.restingHR}`);
                    if (summary?.calories) lines.push(`Cal: ${summary.calories}`);
                    if (hrv?.dailyRmssd) lines.push(`HRV: ${hrv.dailyRmssd}`);

                    ctx.fillStyle = 'rgba(255,255,255,0.9)';
                    ctx.font = '11px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'top';

                    let yOffset = area.top + 5;
                    lines.forEach(line => {
                        ctx.fillText(line, xMid, yOffset);
                        yOffset += 14;
                    });
                }
            }

            currentDate.setDate(currentDate.getDate() + 1);
        }

        ctx.restore();
    }
};

function displayHeartRateChart(timeLabels, heartRateValues) {
    const ctx = document.getElementById('heartrateChart').getContext('2d');

    const formattedData = timeLabels.map((time, index) => ({
        x: new Date(`${getLocalDateString(currentStartDate)}T${time}`),
        y: heartRateValues[index],
    }));

    window.heartRateChart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: 'Heart Rate',
                data: formattedData,
                borderColor: 'rgba(255, 99, 132, 1)',
                backgroundColor: 'rgba(255, 99, 132, 0.2)',
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.3,
            }],
        },
        plugins: [sleepPhasePlugin, restingHRLinePlugin, dailySummaryPlugin, workoutEmojiPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        label: function (context) {
                            const hr = context.parsed.y;
                            const time = new Date(context.parsed.x);
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
                        onPan: onPan,
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
                            minute: 'h:mm a',
                        },
                        tooltipFormat: 'MMMM d, h:mm a',
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

// Get all dates that need data in the visible range
function getDatesInRange(startDate, endDate) {
    const dates = [];
    let current = new Date(startDate);
    current.setHours(0, 0, 0, 0);

    const end = new Date(endDate);
    end.setHours(0, 0, 0, 0);

    while (current <= end) {
        dates.push(new Date(current));
        current.setDate(current.getDate() + 1);
    }

    return dates;
}

// Load data for all visible dates
async function loadVisibleData(chart) {
    const xScale = chart.scales.x;
    const minDate = new Date(xScale.min);
    const maxDate = new Date(xScale.max);

    const datesToLoad = getDatesInRange(minDate, maxDate);

    // Filter to only dates we haven't loaded or aren't loading
    const newDates = datesToLoad.filter(date => {
        const dateStr = getLocalDateString(date);
        return !loadedDates.has(dateStr) && !loadingDates.has(dateStr);
    });

    const newOverlayDates = datesToLoad.filter(date => {
        const dateStr = getLocalDateString(date);
        return !loadedOverlayDates.has(dateStr) && !loadingOverlayDates.has(dateStr);
    });

    if (newDates.length === 0 && newOverlayDates.length === 0) {
        return;
    }

    console.log(`Loading data for ${newDates.length} new dates:`, newDates.map(d => getLocalDateString(d)));

    // Load all dates in parallel
    const hrPromises = newDates.map(async date => {
        const data = await fetchHeartRateDataForDate(date);
        if (data.length > 0) {
            addDataToChart(chart, data, date);
            if (date < currentStartDate) {
                currentStartDate = date;
            }
        }
        return { date, data };
    });

    const overlayPromises = newOverlayDates.map(date => fetchOverlayDataForDate(date));

    // Wait for all to complete
    await Promise.all([...hrPromises, ...overlayPromises]);

    // Update chart once after all data is loaded
    chart.update('none');
}

// Handle panning: load data for visible range
async function onPan({ chart }) {
    await loadVisibleData(chart);
}

// Handle zooming: load data for visible range
async function onZoom({ chart }) {
    await loadVisibleData(chart);
}

// Main function to fetch initial data (now loads 3 days) and render the chart
async function fetchHeartRateData() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Load data for today and the previous 2 days (3 days total)
    const dates = [];
    for (let i = 2; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        dates.push(date);
    }

    console.log('Loading initial 3 days of data:', dates.map(d => getLocalDateString(d)));

    // Load all dates in parallel
    const allPromises = dates.map(async date => {
        const [heartRateData, workouts, sleepPhases, dailySummary, hrv] = await Promise.all([
            fetchHeartRateDataForDate(date),
            fetchWorkoutSessions(date),
            fetchSleepPhases(date),
            fetchDailySummary(date),
            fetchHRVSummary(date)
        ]);

        return { date, heartRateData, workouts, sleepPhases, dailySummary, hrv };
    });

    const results = await Promise.all(allPromises);

    // Combine all data
    let allHeartRateData = [];
    let allWorkouts = [];
    let allSleepPhases = [];
    const restingHRByDate = {};
    const dailySummaries = {};
    const hrvByDate = {};

    results.forEach(({ date, heartRateData, workouts, sleepPhases, dailySummary, hrv }) => {
        const dateStr = getLocalDateString(date);

        // Convert heart rate data to absolute timestamps
        const formattedHR = heartRateData.map(entry => ({
            x: new Date(`${dateStr}T${entry.time}`),
            y: entry.value
        }));
        allHeartRateData = [...allHeartRateData, ...formattedHR];

        allWorkouts = [...allWorkouts, ...workouts];
        allSleepPhases = [...allSleepPhases, ...sleepPhases];

        const { restingHR, calories } = dailySummary;
        restingHRByDate[dateStr] = restingHR;
        dailySummaries[dateStr] = { restingHR, calories };
        hrvByDate[dateStr] = hrv;

        loadedDates.add(dateStr);
        loadedOverlayDates.add(dateStr);
    });

    // Sort heart rate data by time
    allHeartRateData.sort((a, b) => a.x - b.x);

    if (allHeartRateData.length === 0) {
        alert("Failed to get heart rate data");
        return;
    }

    // Set current start date to earliest date
    currentStartDate = dates[0];

    window.fitdashOverlayData = {
        workouts: allWorkouts,
        sleepPhases: allSleepPhases,
        restingHRByDate,
        dailySummaries,
        hrvByDate
    };

    // Create chart with combined data
    const ctx = document.getElementById('heartrateChart').getContext('2d');

    window.heartRateChart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: 'Heart Rate',
                data: allHeartRateData,
                borderColor: 'rgba(255, 99, 132, 1)',
                backgroundColor: 'rgba(255, 99, 132, 0.2)',
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.3,
            }],
        },
        plugins: [sleepPhasePlugin, restingHRLinePlugin, dailySummaryPlugin, workoutEmojiPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        label: function (context) {
                            const hr = context.parsed.y;
                            const time = new Date(context.parsed.x);
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
                        onPan: onPan,
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
                            minute: 'h:mm a',
                        },
                        tooltipFormat: 'MMMM d, h:mm a',
                    },
                    grid: {
                        color: 'rgba(255,255,255,0.1)',
                    },
                    ticks: {
                        color: '#ccc',
                        autoSkip: true,
                        maxTicksLimit: 10,
                        callback: function (value, index) {
                            const date = new Date(value);
                            return date.toLocaleTimeString([], {
                                hour: 'numeric',
                                minute: '2-digit',
                                hour12: true
                            });
                        }
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


document.getElementById('heartrateChart').addEventListener('mousedown', (event) => {
    event.preventDefault();
});

function getHashParam(name) {
    const m = window.location.hash.match(new RegExp(`${name}=([^&]*)`));
    return m ? decodeURIComponent(m[1]) : null;
}

function safeRedirectToAuth() {
    localStorage.setItem('auth_in_progress', '1');
    window.location.href = AUTH_URL;
}

async function testToken(token) {
    try {
        const res = await fitbitFetch('https://api.fitbit.com/1/user/-/profile.json', {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (res.status === 401) return false;
        if (!res.ok) {
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
    const accessFromHash = getHashParam('access_token');
    if (accessFromHash) {
        localStorage.setItem('fitbit_access_token', accessFromHash);
        localStorage.removeItem('auth_in_progress');
        history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    const token = localStorage.getItem('fitbit_access_token');

    if (!token) {
        const cameFromFitbit = document.referrer && document.referrer.includes('fitbit.com');
        const alreadyAuthing = localStorage.getItem('auth_in_progress') === '1';

        if (cameFromFitbit || alreadyAuthing) {
            console.error('Auth failed or cancelled. Not redirecting again.');
            return;
        }

        safeRedirectToAuth();
        return;
    }

    const valid = await testToken(token);
    if (!valid) {
        localStorage.removeItem('fitbit_access_token');
        safeRedirectToAuth();
        return;
    }

    fetchHeartRateData();
}
window.onload = initApp;

document.getElementById('reauthBtn').addEventListener('click', () => {
    localStorage.removeItem('fitbit_access_token');
    localStorage.removeItem('auth_in_progress');
    safeRedirectToAuth();
});