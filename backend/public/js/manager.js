const deviceSelect = document.getElementById('deviceSelect');
const managerActions = document.getElementById('managerActions');
const monitorLink = document.getElementById('monitorLink');
const controlLink = document.getElementById('controlLink');
const deviceStats = document.getElementById('deviceStats');

let lastStats = null;
const ws = new WebSocket(`ws://${window.location.host}`);

ws.onopen = () => {
    if (deviceSelect.value) {
        requestStats(deviceSelect.value);
    }
};

ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'STATS' && msg.deviceId === deviceSelect.value) {
        renderStats(msg.payload);
    }
};

async function loadDevices() {
    try {
        const res = await fetch('/api/devices');
        const devices = await res.json();
        
        devices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.id;
            option.textContent = device.name;
            deviceSelect.appendChild(option);
        });

        const urlParams = new URLSearchParams(window.location.search);
        const deviceId = urlParams.get('deviceId');
        if (deviceId && devices.some(d => d.id === deviceId)) {
            deviceSelect.value = deviceId;
            deviceSelect.dispatchEvent(new Event('change'));
        }
    } catch (err) {
        console.error('Failed to load devices', err);
    }
}

function requestStats(deviceId) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'GET_STATS', deviceId }));
    }
}

function renderStats(stats) {
        lastStats = stats;
        updateLastSeen();
        document.getElementById('statTotal').textContent = stats.totalRecords.toLocaleString();
        document.getElementById('statToday').textContent = stats.recordsToday.toLocaleString();
        document.getElementById('statAvg').textContent = stats.dailyAvg.toLocaleString();
        
        deviceStats.style.display = 'block';
}

function updateLastSeen() {
    if (lastStats && lastStats.lastSeen) {
        const diff = Date.now() - new Date(lastStats.lastSeen).getTime();
        document.getElementById('statLastSeen').textContent = `${formatDuration(diff)} ago`;
        document.getElementById('statLastSeen').title = new Date(lastStats.lastSeen).toLocaleString();
    } else {
        document.getElementById('statLastSeen').textContent = 'Never';
    }
}

deviceSelect.addEventListener('change', async () => {
    const deviceId = deviceSelect.value;
    
    // Update URL
    const params = new URLSearchParams(window.location.search);
    if (deviceId) params.set('deviceId', deviceId);
    else params.delete('deviceId');
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);

    if (deviceId) {
        monitorLink.href = `graph.html?deviceId=${deviceId}`;
        controlLink.href = `control.html?deviceId=${deviceId}`;
        managerActions.style.display = 'block';

        requestStats(deviceId);
    } else {
        managerActions.style.display = 'none';
        deviceStats.style.display = 'none';
    }
});

loadDevices();
setInterval(updateLastSeen, 1000);