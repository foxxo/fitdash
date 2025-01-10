const CLIENT_ID = '23PXJV';
const REDIRECT_URI = 'https://foxxo.github.io/fitdash/';
const AUTH_URL = `https://www.fitbit.com/oauth2/authorize?response_type=token&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=activity%20heartrate%20sleep%20profile&expires_in=604800`;

const today = new Date();
const year = today.getFullYear();
const month = String(today.getMonth() + 1).padStart(2, '0');
const day = String(today.getDate()).padStart(2, '0');
const formattedDate = `${year}-${month}-${day}`;

// Fitbit API URL with dynamic date instead of "today.json"
const fitbitUrl = `https://api.fitbit.com/1/user/-/activities/date/${formattedDate}.json`;

document.getElementById('fetchData').addEventListener('click', () => {
    if (!localStorage.getItem('fitbit_access_token')) {
        window.location.href = AUTH_URL;  // Direct user to Fitbit login page
    } else {
        fetchFitbitData();
    }
});

async function fetchFitbitData() {
    const accessToken = localStorage.getItem('fitbit_access_token');
    if (!accessToken) {
        alert('Please log in through Fitbit to continue.');
        return;
    }

    try {
        const response = await fetch(`${fitbitUrl}`, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });
        const data = await response.json();
        displayData(data);
    } catch (error) {
        console.error('Error fetching data:', error);
        alert('Error fetching Fitbit data. Try logging in again.');
    }
}

function displayData(data) {
    const dataDisplay = document.getElementById('dataDisplay');
    dataDisplay.innerHTML = `
    <h2>Today's Summary</h2>
    <p><strong>Steps:</strong> ${data.summary.steps}</p>
    <p><strong>Calories Burned:</strong> ${data.summary.caloriesOut} kcal</p>
    <p><strong>Active Minutes:</strong> ${data.summary.veryActiveMinutes} mins</p>
  `;
}

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
