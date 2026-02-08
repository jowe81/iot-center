const fieldSelect = document.getElementById('fieldSelect');
const timeframeSelect = document.getElementById('timeframeSelect');
const accuracySelect = document.getElementById('accuracySelect');
const interpolationSelect = document.getElementById('interpolationSelect');
const ctx = document.getElementById('dataChart').getContext('2d');

const colors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#E7E9ED', '#767676'];

let chart;
let deviceConfigs = {};

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

// Fetch All Keys from All Devices
async function loadAllKeys() {
    fieldSelect.innerHTML = '';
    fieldSelect.disabled = true;

    try {
        const resDevices = await fetch('/api/devices');
        const devices = await resDevices.json();

        const promises = devices.map(async (device) => {
            const deviceId = device.id;
            const [resKeys, resConfig] = await Promise.all([
                fetch(`/api/device/${deviceId}/keys`),
                fetch(`/api/device/${deviceId}/config`)
            ]);
            const keys = await resKeys.json();
            deviceConfigs[deviceId] = await resConfig.json();
            return keys.map(key => ({ deviceId, key }));
        });

        const results = await Promise.all(promises);
        const allKeys = results.flat();

        // Sort by deviceId then key
        allKeys.sort((a, b) => {
            if (a.deviceId !== b.deviceId) return a.deviceId.localeCompare(b.deviceId);
            const labelA = a.key.replace(/^data\./, '');
            const labelB = b.key.replace(/^data\./, '');
            return labelA.localeCompare(labelB);
        });

        allKeys.forEach(({ deviceId, key }) => {
            const option = document.createElement('option');
            option.value = `${deviceId}:${key}`;
            option.textContent = `${deviceId}: ${key.replace(/^data\./, '')}`;
            fieldSelect.appendChild(option);
        });
        fieldSelect.disabled = false;

        // Restore state from URL
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('timeframe')) timeframeSelect.value = urlParams.get('timeframe');
        if (urlParams.has('accuracy')) accuracySelect.value = urlParams.get('accuracy');
        if (urlParams.has('interpolation')) interpolationSelect.value = urlParams.get('interpolation');
        
        const fieldsParam = urlParams.get('fields');
        if (fieldsParam) {
            const fields = fieldsParam.split(',');
            Array.from(fieldSelect.options).forEach(opt => {
                if (fields.includes(opt.value)) opt.selected = true;
            });
            updateChart();
        }

    } catch (err) {
        console.error('Failed to load keys', err);
    }
}

// Fetch Data and Update Chart
async function updateChart() {
    const selectedOptions = Array.from(fieldSelect.selectedOptions).map(opt => opt.value);

    // Update URL parameters
    const params = new URLSearchParams(window.location.search);
    if (selectedOptions.length > 0) {
        params.set('fields', selectedOptions.join(','));
    } else {
        params.delete('fields');
    }
    params.set('timeframe', timeframeSelect.value);
    params.set('accuracy', accuracySelect.value);
    params.set('interpolation', interpolationSelect.value);
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);

    if (selectedOptions.length === 0) return;

    const timeframe = timeframeSelect.value;
    const accuracy = accuracySelect.value;
    const interpolation = interpolationSelect.value;

    try {
        // Group requests by deviceId
        const requests = {};
        selectedOptions.forEach(value => {
            const [deviceId, key] = value.split(':');
            if (!requests[deviceId]) requests[deviceId] = [];
            requests[deviceId].push(key);
        });

        const promises = Object.entries(requests).map(async ([deviceId, fields]) => {
            const fieldsParam = fields.join(',');
            const res = await fetch(`/api/device/${deviceId}/data?fields=${fieldsParam}&timeframe=${timeframe}&accuracy=${accuracy}`);
            const dataMap = await res.json();
            return { deviceId, dataMap };
        });

        const results = await Promise.all(promises);

        let tension = 0;
        let stepped = false;
        if (interpolation === 'smooth') tension = 0.4;
        if (interpolation === 'stepped') stepped = true;

        const datasets = [];
        let colorIndex = 0;

        results.forEach(({ deviceId, dataMap }) => {
            Object.entries(dataMap).forEach(([field, data]) => {
                datasets.push({
                    label: `${deviceId}: ${field.replace(/^data\./, '')}`,
                    data: data,
                    borderColor: colors[colorIndex % colors.length],
                    backgroundColor: colors[colorIndex % colors.length],
                    tension: tension,
                    stepped: stepped,
                    pointRadius: 0,
                    borderWidth: 2
                });

                // Check for target boundaries
                const parts = field.split('.');
                if (parts.length === 3 && parts[0] === 'data') {
                    const type = parts[1];
                    const key = parts[2];
                    const fieldConfig = deviceConfigs[deviceId]?.[type]?.[key];
                    
                    if (fieldConfig && fieldConfig.targetBoundaries && data && data.length > 0) {
                        const { low, high } = fieldConfig.targetBoundaries;
                        const startTime = data[0].x;
                        const endTime = data[data.length - 1].x;
                        const boundaryStyle = {
                            borderColor: 'red',
                            borderDash: [5, 5],
                            pointRadius: 0,
                            borderWidth: 1,
                            fill: false,
                            tension: 0
                        };

                        if (low !== undefined) {
                            datasets.push({ ...boundaryStyle, label: `${deviceId}: ${field.replace(/^data\./, '')} Low`, data: [{x: startTime, y: low}, {x: endTime, y: low}] });
                        }
                        if (high !== undefined) {
                            datasets.push({ ...boundaryStyle, label: `${deviceId}: ${field.replace(/^data\./, '')} High`, data: [{x: startTime, y: high}, {x: endTime, y: high}] });
                        }
                    }
                }
                colorIndex++;
            });
        });

        chart.data.datasets = datasets;
        chart.update();
    } catch (err) {
        console.error('Failed to load data', err);
    }
}

// Event Listeners
console.log('Add to ', fieldSelect)
fieldSelect.addEventListener('change', updateChart);
timeframeSelect.addEventListener('change', updateChart);
accuracySelect.addEventListener('change', updateChart);
interpolationSelect.addEventListener('change', updateChart);

// Start
initChart();
loadAllKeys();

// Auto-refresh data every minute
setInterval(updateChart, 60000);