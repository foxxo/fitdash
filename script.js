const CLIENT_ID = '23PXJV';
const REDIRECT_URI = 'https://foxxo.github.io/fitdash/';
const AUTH_URL = `https://www.fitbit.com/oauth2/authorize?response_type=token&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=activity%20heartrate%20sleep%20profile&expires_in=604800`;

let currentStartDate = new Date();  // Start with today
currentStartDate.setHours(0, 0, 0, 0);  // Set to midnight for consistency
const fitbitApiBaseUrl = `https://api.fitbit.com/1/user/-/activities/heart/date/`;
const loadedDates = new Set();  // Track dates that have already been fetched


async function fetchWorkoutSessions(date) {
    const accessToken = localStorage.getItem('fitbit_access_token');
    const formattedDate = date.toISOString().split('T')[0];

    const response = await fetch(`https://api.fitbit.com/1/user/-/activities/list.json?afterDate=${formattedDate}T00:00:00&sort=asc&limit=100&offset=0`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!response.ok) {
        console.error('Error fetching workout data:', response.statusText);
        return [];
    }

    const data = await response.json();

    // Return simplified array with start/end dates
    return data.activities.map(act => ({
        start: new Date(act.startTime),
        end: new Date(new Date(act.startTime).getTime() + act.duration)
    }));
}
async function fetchSleepPhases(date) {
    const accessToken = localStorage.getItem('fitbit_access_token');
    const formattedDate = date.toISOString().split('T')[0];

    const response = await fetch(`https://api.fitbit.com/1.2/user/-/sleep/date/${formattedDate}.json`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!response.ok) {
        console.error('Error fetching sleep data:', response.statusText);
        return [];
    }

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
async function fetchSleepPhases(date) {
    const accessToken = localStorage.getItem('fitbit_access_token');
    const formattedDate = date.toISOString().split('T')[0];

    const response = await fetch(`https://api.fitbit.com/1.2/user/-/sleep/date/${formattedDate}.json`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!response.ok) {
        console.error('Error fetching sleep data:', response.statusText);
        return [];
    }

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
async function fetchRestingHeartRate(date) {
    const accessToken = localStorage.getItem('fitbit_access_token');
    const formattedDate = date.toISOString().split('T')[0];

    const response = await fetch(`https://api.fitbit.com/1/user/-/activities/heart/date/${formattedDate}/1d.json`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!response.ok) {
        console.error('Error fetching resting heart rate:', response.statusText);
        return null;
    }

    const data = await response.json();
    const resting = data['activities-heart']?.[0]?.value?.restingHeartRate;
    return resting || null;
}

// Fetch heart rate data for a given date
async function fetchHeartRateDataForDate(date) {
    const accessToken = localStorage.getItem('fitbit_access_token');
    const formattedDate = date.toISOString().split('T')[0];  // Format as YYYY-MM-DD

    // Skip if this date has already been fetched
    if (loadedDates.has(formattedDate)) {
        console.log(`Data for ${formattedDate} already being fetched or loaded.`);
        return [];
    }

    // Add date to prevent duplicate calls
    loadedDates.add(formattedDate);

    try {
        const response = await fetch(`${fitbitApiBaseUrl}${formattedDate}/1d/1min.json`, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });

        if (!response.ok) {
            console.error(`Error fetching data for ${formattedDate}: ${response.statusText} (status ${response.status})`);
            throw new Error('Failed to fetch Fitbit heart rate data');
        }

        const data = await response.json();
        return data["activities-heart-intraday"].dataset || [];

    } catch (error) {
        console.error(`Error fetching data for ${formattedDate}:`, error);
        // Remove the date from the set so it can be retried if needed
        loadedDates.delete(formattedDate);
        return [];
    }
}

// Function to add new data to the chart
function addDataToChart(chart, newData, date) {
    const formattedDate = date.toISOString().split('T')[0];
    const timeLabels = newData.map(entry => `${formattedDate}T${entry.time}`);
    const heartRateValues = newData.map(entry => entry.value);

    // Convert times to Date objects and prepend to chart data
    const fullDateLabels = timeLabels.map(time => new Date(time));
    chart.data.labels.unshift(...fullDateLabels);
    chart.data.datasets[0].data.unshift(...heartRateValues);

    chart.update();
}

const dayBackgroundPlugin = {
    id: 'dayBackgroundPlugin',
    beforeDatasetsDraw(chart, args, pluginOptions) {
        const { ctx, chartArea: area, scales: { x } } = chart;

        const start = x.getUserBounds().min;
        const end = x.getUserBounds().max;

        const startDate = new Date(start);
        startDate.setHours(0, 0, 0, 0);  // Align to midnight

        const MS_PER_DAY = 24 * 60 * 60 * 1000;
        const numDays = Math.ceil((end - startDate.getTime()) / MS_PER_DAY);

        for (let i = 0; i <= numDays; i++) {
            const dayStart = new Date(startDate.getTime() + i * MS_PER_DAY);
            const dayEnd = new Date(dayStart.getTime() + MS_PER_DAY);

            const xStart = x.getPixelForValue(dayStart);
            const xEnd = x.getPixelForValue(dayEnd);

            if (xEnd < area.left || xStart > area.right) continue; // Skip if off screen

            // Alternate light gray shading
            ctx.fillStyle = i % 2 === 0 ? 'rgba(240, 240, 240, 0.5)' : 'rgba(255, 255, 255, 0)';
            ctx.fillRect(xStart, area.top, xEnd - xStart, area.bottom - area.top);
        }
    }
};

const workoutOverlayPlugin = {
    id: 'workoutOverlayPlugin',
    beforeDatasetsDraw(chart) {
        const workouts = window.fitdashOverlayData?.workouts || [];
        const { ctx, chartArea: area, scales: { x } } = chart;

        ctx.save();
        ctx.fillStyle = 'rgba(255, 165, 0, 0.2)';

        workouts.forEach(({ start, end }) => {
            const xStart = x.getPixelForValue(start);
            const xEnd = x.getPixelForValue(end);
            ctx.fillRect(xStart, area.top, xEnd - xStart, area.bottom - area.top);
        });

        ctx.restore();
    }
};


const sleepOverlayPlugin = {
    id: 'sleepOverlayPlugin',
    beforeDatasetsDraw(chart) {
        const { ctx, chartArea: area, scales: { x } } = chart;

        const phases = window.fitdashOverlayData?.sleepPhases || [];

        const stageColors = {
            light: 'rgba(173, 216, 230, 0.2)', // light blue
            deep: 'rgba(138, 43, 226, 0.2)',   // purple
            rem:  'rgba(255, 182, 193, 0.2)'   // pink
        };

        ctx.save();

        phases.forEach(({ start, end, stage }) => {
            const xStart = x.getPixelForValue(start);
            const xEnd = x.getPixelForValue(end);
            ctx.fillStyle = stageColors[stage] || 'rgba(200, 200, 200, 0.2)';
            ctx.fillRect(xStart, area.top, xEnd - xStart, area.bottom - area.top);
        });

        ctx.restore();
    }
};


const restingHrPlugin = {
    id: 'restingHrPlugin',
    beforeDraw(chart) {
        const restingHR = window.fitdashOverlayData?.restingHR;
        const { ctx, chartArea: area, scales: { y } } = chart;

        const yRest = y.getPixelForValue(restingHR);

        ctx.save();
        ctx.strokeStyle = 'rgba(0, 0, 255, 0.4)';
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(area.left, yRest);
        ctx.lineTo(area.right, yRest);
        ctx.stroke();
        ctx.restore();
    }
};


const hrZonePlugin = {
    id: 'hrZonePlugin',
    beforeDraw(chart) {
        const { ctx, chartArea: area, scales: { y } } = chart;

        const zones = [
            { label: 'Fat Burn', min: 90, max: 120, color: 'rgba(255, 255, 0, 0.08)' },
            { label: 'Cardio', min: 120, max: 150, color: 'rgba(255, 140, 0, 0.08)' },
            { label: 'Peak', min: 150, max: 200, color: 'rgba(255, 0, 0, 0.08)' }
        ];

        ctx.save();

        zones.forEach(({ min, max, color }) => {
            const yTop = y.getPixelForValue(max);
            const yBottom = y.getPixelForValue(min);
            ctx.fillStyle = color;
            ctx.fillRect(area.left, yTop, area.right - area.left, yBottom - yTop);
        });

        ctx.restore();
    }
};



function displayHeartRateChart(labels, data) {
    const fullDateLabels = labels.map(time => {
        const [hours, minutes] = time.split(':').map(Number);
        const today = new Date();
        today.setHours(hours, minutes, 0, 0);  // Set the time (hours and minutes)
        return today;  // Return a Date object
    });

    const ctx = document.getElementById('heartrateChart').getContext('2d');

    Chart.register(
        dayBackgroundPlugin,
        workoutOverlayPlugin,
        sleepOverlayPlugin,
        restingHrPlugin,
        hrZonePlugin
    );

    new Chart(ctx, {
        type: 'line',
        data: {
            labels: fullDateLabels,
            datasets: [{
                label: 'Heart Rate (BPM)',
                data: data,
                borderColor: 'rgba(255, 99, 132, 1)',
                backgroundColor: 'rgba(255, 99, 132, 0.2)',
                pointRadius: 1,
                fill: false,
                tension: 0.1,
            }],
        },
        options: {
            responsive: true,
            interaction: {
                mode: 'nearest',
                intersect: false,
            },
            plugins: {
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
                    display: true,
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
                    ticks: {
                        autoSkip: true,
                        maxTicksLimit: 10,
                        callback: (function () {
                            let lastDate = null;

                            return function (value, index) {
                                const date = new Date(value);
                                const dateStr = date.toDateString();

                                // Always show full date + time on the first tick
                                if (index === 0 || dateStr !== lastDate) {
                                    lastDate = dateStr;
                                    return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
                                        hour: 'numeric',
                                        minute: '2-digit',
                                        hour12: true
                                    })}`;
                                }

                                // Otherwise, just time
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
        if (newData.length > 0) {
            addDataToChart(chart, newData, newDate);
            currentStartDate = newDate;  // Update start date to include the new data
        } else {
            console.log(`No data available for ${newDate.toISOString().split('T')[0]}.`);
        }

        // Force chart update immediately after data is added
        chart.update('none');
    }
}


// Main function to fetch today's data and render the chart
async function fetchHeartRateData() {
    const today = new Date();

    const [heartRateData, workouts, sleepPhases, restingHR] = await Promise.all([
        fetchHeartRateDataForDate(today),
        fetchWorkoutSessions(today),
        fetchSleepPhases(today),
        fetchRestingHeartRate(today)
    ]);

    if (heartRateData.length === 0) {
        alert("No heart rate data available for today.");
        return;
    }

    const timeLabels = heartRateData.map(entry => entry.time);
    const heartRateValues = heartRateData.map(entry => entry.value);

    // Store fetched overlays for plugins
    window.fitdashOverlayData = {
        workouts,
        sleepPhases,
        restingHR
    };

    displayHeartRateChart(timeLabels, heartRateValues);  // Render the chart
}


document.getElementById('fetchData').addEventListener('click', fetchHeartRateData);
document.getElementById('heartrateChart').addEventListener('mousedown', (event) => {
    event.preventDefault();  // Prevent browser from selecting or dragging the chart element
});

window.onload = function () {
    const hash = window.location.hash;
    if (hash) {
        const tokenMatch = hash.match(/access_token=([^&]*)/);
        if (tokenMatch) {
            localStorage.setItem('fitbit_access_token', tokenMatch[1]);
            window.location.hash = '';  // Clean up URL
            location.reload();  // Reload page with the new token
        }
    }
};
