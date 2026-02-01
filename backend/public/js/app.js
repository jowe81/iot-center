const deviceSelect = document.getElementById('deviceSelect');
const fieldSelect = document.getElementById('fieldSelect');
const timeframeSelect = document.getElementById('timeframeSelect');
const accuracySelect = document.getElementById('accuracySelect');
const interpolationSelect = document.getElementById('interpolationSelect');
const ctx = document.getElementById('dataChart').getContext('2d');

const colors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#E7E9ED', '#767676'];

let chart;

// Initialize Chart
function initChart() {
    chart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: []
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'minute',
                        displayFormats: {
                            minute: 'HH:mm'
                        }
                    },
                    title: {
                        display: true,
                        text: 'Time'
                    }
                },
                y: {
                    beginAtZero: false
                }
            }
        }
    });
}

// Fetch Devices
async function loadDevices() {
    try {
        const res = await fetch('/api/devices');
        const devices = await res.json();
        
        devices.forEach(device => {
            const option = document.createElement('option');
            option.value = device;
            option.textContent = device;
            deviceSelect.appendChild(option);
        });

        const urlParams = new URLSearchParams(window.location.search);
        const deviceId = urlParams.get('deviceId');
        if (deviceId && devices.includes(deviceId)) {
            deviceSelect.value = deviceId;
            loadKeys(deviceId);
        }
    } catch (err) {
        console.error('Failed to load devices', err);
    }
}

// Fetch Keys for Device
async function loadKeys(deviceId) {
    fieldSelect.innerHTML = '';
    fieldSelect.disabled = true;
    
    if (!deviceId) return;

    try {
        const res = await fetch(`/api/device/${deviceId}/keys`);
        const keys = await res.json();
        
        keys.forEach(key => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = key;
            fieldSelect.appendChild(option);
        });
        fieldSelect.disabled = false;
    } catch (err) {
        console.error('Failed to load keys', err);
    }
}

// Fetch Data and Update Chart
async function updateChart() {
    const deviceId = deviceSelect.value;
    const selectedOptions = Array.from(fieldSelect.selectedOptions).map(opt => opt.value);

    if (!deviceId || selectedOptions.length === 0) return;

    const timeframe = timeframeSelect.value;
    const accuracy = accuracySelect.value;
    const interpolation = interpolationSelect.value;
    const fieldsParam = selectedOptions.join(',');

    try {
        const res = await fetch(`/api/device/${deviceId}/data?fields=${fieldsParam}&timeframe=${timeframe}&accuracy=${accuracy}`);
        const dataMap = await res.json();

        let tension = 0;
        let stepped = false;
        if (interpolation === 'smooth') tension = 0.4;
        if (interpolation === 'stepped') stepped = true;

        chart.data.datasets = selectedOptions.map((field, index) => ({
            label: field,
            data: dataMap[field],
            borderColor: colors[index % colors.length],
            backgroundColor: colors[index % colors.length],
            tension: tension,
            stepped: stepped,
            pointRadius: 0,
            borderWidth: 2
        }));
        chart.update();
    } catch (err) {
        console.error('Failed to load data', err);
    }
}

// Event Listeners
deviceSelect.addEventListener('change', (e) => loadKeys(e.target.value));
fieldSelect.addEventListener('change', updateChart);
timeframeSelect.addEventListener('change', updateChart);
accuracySelect.addEventListener('change', updateChart);
interpolationSelect.addEventListener('change', updateChart);

// Start
initChart();
loadDevices();
