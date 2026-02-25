const deviceList = document.getElementById('deviceList');
const deviceStats = document.getElementById('deviceStats');

let lastStats = null;
const ws = new WebSocket(`ws://${window.location.host}`);

ws.onopen = () => {
    const params = new URLSearchParams(window.location.search);
    const deviceId = params.get('deviceId');
    if (deviceId) {
        requestStats(deviceId);
    }
};

ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const params = new URLSearchParams(window.location.search);
    if (msg.type === 'STATS' && msg.deviceId === params.get('deviceId')) {
        renderStats(msg.payload);
    }
};

async function loadDevices() {
    try {
        const res = await fetch('/api/devices');
        const devices = await res.json();
        
        deviceList.innerHTML = '';
        devices.forEach(device => {
            const badge = document.createElement('a');
            badge.href = '#';
            badge.className = 'device-badge';
            badge.textContent = device.name;
            badge.dataset.id = device.id;
            badge.onclick = (e) => {
                e.preventDefault();
                selectDevice(device.id);
            };
            deviceList.appendChild(badge);
        });

        const urlParams = new URLSearchParams(window.location.search);
        const deviceId = urlParams.get('deviceId');
        if (deviceId && devices.some(d => d.id === deviceId)) {
            selectDevice(deviceId);
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

async function loadSchedules(deviceId) {
    try {
        const res = await fetch(`/api/schedules?deviceId=${deviceId}`);
        const schedules = await res.json();
        renderSchedules(schedules);
    } catch (err) {
        console.error('Failed to load schedules', err);
    }
}

function renderSchedules(schedules) {
    let schedulesDiv = document.getElementById('deviceSchedules');

    if (schedules.length === 0) {
        if (schedulesDiv) {
            schedulesDiv.style.display = 'none';
        }
        return;
    }

    if (!schedulesDiv) {
        schedulesDiv = document.createElement('div');
        schedulesDiv.id = 'deviceSchedules';
        schedulesDiv.style.marginTop = '20px';
        schedulesDiv.style.padding = '15px';
        schedulesDiv.style.backgroundColor = '#fff';
        schedulesDiv.style.borderRadius = '8px';
        schedulesDiv.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
        
        const header = document.createElement('h3');
        header.textContent = 'Configured Schedules';
        header.style.marginTop = '0';
        schedulesDiv.appendChild(header);

        const list = document.createElement('ul');
        list.id = 'schedulesList';
        list.style.paddingLeft = '20px';
        list.style.listStyle = 'none';
        schedulesDiv.appendChild(list);

        if (deviceStats && deviceStats.parentNode) {
            deviceStats.parentNode.insertBefore(schedulesDiv, deviceStats.nextSibling);
        } else {
             document.body.appendChild(schedulesDiv);
        }
    }

    const list = document.getElementById('schedulesList');
    list.innerHTML = '';

    schedules.forEach(schedule => {
        const item = document.createElement('li');
        item.style.marginBottom = '5px';
        
        let triggerText = '';
        if (schedule.trigger.type === 'daily') {
            triggerText = `Daily at ${schedule.trigger.time}`;
        } else if (schedule.trigger.type === 'celestial') {
            const offset = schedule.trigger.offsetMinutes;
            const offsetStr = offset ? (offset > 0 ? `+${offset}m` : `${offset}m`) : '';
            triggerText = `${schedule.trigger.event} ${offsetStr}`;
        } else {
            triggerText = schedule.trigger.type;
        }
        
        const status = schedule.enabled ? '<span style="color:green">●</span>' : '<span style="color:red">○</span>';
        
        const deviceTargets = schedule.targets.filter(t => t.deviceId === new URLSearchParams(window.location.search).get('deviceId'));
        const actions = deviceTargets.map(t => {
             if (t.command && typeof t.command === 'object') return JSON.stringify(t.command);
             return `${t.subDevice} -> ${t.command}(${t.argument})`;
        }).join(', ');

        item.innerHTML = `${status} <strong>${schedule.name}</strong>: ${triggerText} <br><small style="color:#555; margin-left: 15px;">Action: ${actions}</small>`;
        list.appendChild(item);
    });

    schedulesDiv.style.display = 'block';
}

function selectDevice(deviceId) {
    const badges = deviceList.querySelectorAll('.device-badge');
    badges.forEach(b => {
        if (b.dataset.id === deviceId) b.classList.add('active');
        else b.classList.remove('active');
    });
    
    // Update URL
    const params = new URLSearchParams(window.location.search);
    if (deviceId) params.set('deviceId', deviceId);
    else params.delete('deviceId');
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);

    // Notify other scripts
    document.dispatchEvent(new CustomEvent('device-selected', { detail: { deviceId } }));

    if (deviceId) {
        requestStats(deviceId);
        loadSchedules(deviceId);
    } else {
        deviceStats.style.display = 'none';
        const schedulesDiv = document.getElementById('deviceSchedules');
        if (schedulesDiv) schedulesDiv.style.display = 'none';
    }
}

loadDevices();
setInterval(updateLastSeen, 1000);