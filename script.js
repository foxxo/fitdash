const CLIENT_ID = '23PXJV';
const REDIRECT_URI = 'https://foxxo.github.io/fitdash/';
const AUTH_URL = `https://www.fitbit.com/oauth2/authorize?response_type=token&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=activity%20heartrate%20sleep%20profile&expires_in=604800`;

Chart.defaults.plugins.zoom = {
    pan: {
        enabled: true,
        mode: 'x',
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
};


const today = new Date();
const year = today.getFullYear();
const month = String(today.getMonth() + 1).padStart(2, '0');
const day = String(today.getDate()).padStart(2, '0');
const formattedDate = `${year}-${month}-${day}`;


const fitbitUrl = `https://api.fitbit.com/1/user/-/activities/heart/date/${formattedDate}/1d/1min.json`;

async function fetchHeartRateData() {
    const accessToken = localStorage.getItem('fitbit_access_token');

    if (!accessToken) {
        alert('Please log in through Fitbit to continue.');
    }

    try {
        const response = await fetch(fitbitUrl, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });

        if (!response.ok) {
            console.error(`Error: ${response.statusText} (status ${response.status})`);
            throw new Error('Failed to fetch Fitbit heart rate data');
        }

        const data = await response.json();
        const heartRateData = data["activities-heart-intraday"].dataset;

        if (!heartRateData || heartRateData.length === 0) {
            alert("No heart rate data available for today.");
            return;
        }

        const timeLabels = heartRateData.map(entry => entry.time);
        const heartRateValues = heartRateData.map(entry => entry.value);

        displayHeartRateChart(timeLabels, heartRateValues);  // Render the chart
    } catch (error) {
        console.error('Fetch error:', error);
        alert('Error fetching Fitbit data. Try logging in again.');
    }
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
                tension: 0.1,  // Slight curve in the line
            }],
        },
        options: {
            responsive: true,
            interaction: {
                mode: 'nearest',  // Ensure interaction is triggered near the mouse cursor
                intersect: false,
            },
            plugins: {
                zoom: {
                    pan: {
                        enabled: true,
                        mode: 'x',  // Pan only along the x-axis (time)
                        threshold: 0,  // Minimum drag distance to trigger panning
                        onPan: function({chart}) {
                            console.log('Panning:', chart);
                        },
                    },
                    zoom: {
                        wheel: {
                            enabled: true,  // Enable zoom with the mouse wheel
                        },
                        pinch: {
                            enabled: true,  // Enable pinch-to-zoom on touchscreens
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
                    type: 'time',  // Ensure the x-axis uses time-based data
                    time: {
                        unit: 'minute',
                        displayFormats: {
                            minute: 'HH:mm',
                        },
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
                    suggestedMin: 40,  // Lower limit for y-axis
                    suggestedMax: 200,  // Upper limit for y-axis
                },
            },
        },
    });



}

document.getElementById('fetchData').addEventListener('click', fetchHeartRateData);
document.getElementById('heartrateChart').addEventListener('mousedown', (event) => {
    event.preventDefault();  // Prevent browser from selecting or dragging the chart element
});

// Store token after redirect
window.onload = function () {
    const hash = window.location.hash;
    if (hash) {
        const tokenMatch = hash.match(/access_token=([^&]*)/);
        if (tokenMatch) {
            localStorage.setItem('fitbit_access_token', tokenMatch[1]);
            window.location.hash = '';  // Clean up URL
        }
    }
};
