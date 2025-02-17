const CLIENT_ID = '23PXJV';
const REDIRECT_URI = 'https://foxxo.github.io/fitdash/';
const AUTH_URL = `https://www.fitbit.com/oauth2/authorize?response_type=token&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=activity%20heartrate%20sleep%20profile&expires_in=604800`;

let currentStartDate = new Date();  // Start with today
currentStartDate.setHours(0, 0, 0, 0);  // Set to midnight for consistency
const fitbitApiBaseUrl = `https://api.fitbit.com/1/user/-/activities/heart/date/`;
const loadedDates = new Set();  // Track dates that have already been fetched

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

function displayHeartRateChart(labels, data) {
    const fullDateLabels = labels.map(time => {
        const [hours, minutes] = time.split(':').map(Number);
        const today = new Date();
        today.setHours(hours, minutes, 0, 0);  // Set the time (hours and minutes)
        return today;  // Return a Date object
    });

    const ctx = document.getElementById('heartrateChart').getContext('2d');

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
                        maxTicksLimit: 10,  // Control number of labels shown
                        callback: function (value, index, values) {
                            const tick = values[index];  // Visible tick values
                            return tick.label || '';  // Return the formatted label
                        },
                    },
                    afterBuildTicks: function (scale) {
                        let lastShownDate = null;

                        scale.ticks.forEach((tick, index) => {
                            const date = new Date(tick.value);

                            // First tick always shows the full date and time
                            if (index === 0) {
                                tick.label = `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}`;
                                lastShownDate = date.toDateString();
                            }
                            // Show the date at the first tick of each new day
                            else if (date.toDateString() !== lastShownDate) {
                                tick.label = `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}`;
                                lastShownDate = date.toDateString();
                            }
                            // Default: only show time in AM/PM
                            else {
                                tick.label = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
                            }
                        });
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
    const heartRateData = await fetchHeartRateDataForDate(today);

    if (heartRateData.length === 0) {
        alert("No heart rate data available for today.");
        return;
    }

    const timeLabels = heartRateData.map(entry => entry.time);
    const heartRateValues = heartRateData.map(entry => entry.value);

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
