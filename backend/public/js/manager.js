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
        loadActions(deviceId);
    } else {
        deviceStats.style.display = 'none';
        const schedulesDiv = document.getElementById('deviceSchedules');
        if (schedulesDiv) schedulesDiv.style.display = 'none';
    }
}

async function loadActions(deviceId) {
    try {
        const res = await fetch(`/api/device/${deviceId}/actions`);
        const actions = await res.json();
        renderActions(actions);
    } catch (err) {
        console.error('Failed to load actions', err);
    }
}

function renderActions(actions) {
    const container = document.getElementById('deviceActions');
    const list = document.getElementById('actionsList');
    list.innerHTML = '';

    if (actions.length === 0) {
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');

    actions.forEach(action => {
        const div = document.createElement('div');
        div.className = 'action-card';
        
        // Header with Enable Toggle
        const header = document.createElement('div');
        header.className = 'action-header';
        header.innerHTML = `<h4>${action.name}</h4>`;
        
        const toggle = document.createElement('label');
        toggle.className = 'switch';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = action.enabled;
        input.onchange = () => updateAction(action.name, { enabled: input.checked });
        
        const slider = document.createElement('span');
        slider.className = 'slider round';
        
        toggle.appendChild(input);
        toggle.appendChild(slider);
        header.appendChild(toggle);
        div.appendChild(header);

        // Options inputs
        const optionsDiv = document.createElement('div');
        optionsDiv.className = 'action-options';
        
        for (const [key, value] of Object.entries(action.options || {})) {
            if (key.startsWith('_')) continue; // Skip internal state
            if (['sources', 'targets', 'sourceDevice', 'sourceKey', 'targetDevice', 'targetSubDevice', 'tankDevice', 'tankKey'].includes(key)) continue; // Skip wiring config

            const row = document.createElement('div');
            row.className = 'option-row';
            
            const label = document.createElement('label');
            label.textContent = key;
            
            let optInput;
            if (typeof value === 'boolean') {
                optInput = document.createElement('select');
                optInput.innerHTML = '<option value="true">true</option><option value="false">false</option>';
                optInput.value = value.toString();
            } else {
                optInput = document.createElement('input');
                optInput.type = typeof value === 'number' ? 'number' : 'text';
                optInput.value = value;
                if (typeof value === 'number' && (key.toLowerCase().includes('point') || key.toLowerCase().includes('threshold'))) {
                     optInput.step = 'any';
                }
            }
            
            const saveBtn = document.createElement('button');
            saveBtn.textContent = 'Set';
            saveBtn.className = 'btn btn-secondary btn-sm';
            saveBtn.onclick = () => {
                let val = optInput.value;
                if (typeof value === 'number') val = parseFloat(val);
                if (typeof value === 'boolean') val = val === 'true';
                
                updateAction(action.name, { options: { [key]: val } });
            };

            row.appendChild(label);
            row.appendChild(optInput);
            row.appendChild(saveBtn);
            optionsDiv.appendChild(row);
        }
        div.appendChild(optionsDiv);
        list.appendChild(div);
    });
}

async function updateAction(name, updates) {
    try {
        await fetch(`/api/actions/${encodeURIComponent(name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });
        // Reload to refresh UI
        const params = new URLSearchParams(window.location.search);
        loadActions(params.get('deviceId'));
    } catch (err) {
        console.error('Failed to update action', err);
        alert('Failed to update action');
    }
}

loadDevices();
setInterval(updateLastSeen, 1000);