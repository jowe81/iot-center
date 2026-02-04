const deviceSelect = document.getElementById('deviceSelect');
const managerActions = document.getElementById('managerActions');
const monitorLink = document.getElementById('monitorLink');
const controlLink = document.getElementById('controlLink');
const deviceStats = document.getElementById('deviceStats');

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
            deviceSelect.dispatchEvent(new Event('change'));
        }
    } catch (err) {
        console.error('Failed to load devices', err);
    }
}

async function updateStats(deviceId) {
    try {
        const res = await fetch(`/api/device/${deviceId}/stats`);
        const stats = await res.json();
        
        if (stats.lastSeen) {
            const diff = Date.now() - new Date(stats.lastSeen).getTime();
            document.getElementById('statLastSeen').textContent = `${formatDuration(diff)} ago`;
            document.getElementById('statLastSeen').title = new Date(stats.lastSeen).toLocaleString();
        } else {
            document.getElementById('statLastSeen').textContent = 'Never';
        }
        document.getElementById('statTotal').textContent = stats.totalRecords.toLocaleString();
        document.getElementById('statToday').textContent = stats.recordsToday.toLocaleString();
        document.getElementById('statAvg').textContent = stats.dailyAvg.toLocaleString();
        
        deviceStats.style.display = 'block';
    } catch (err) {
        console.error('Failed to load stats', err);
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

        await updateStats(deviceId);
    } else {
        managerActions.style.display = 'none';
        deviceStats.style.display = 'none';
    }
});

loadDevices();

setInterval(() => {
    if (deviceSelect.value) {
        updateStats(deviceSelect.value);
    }
}, 60000);