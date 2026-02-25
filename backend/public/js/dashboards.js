let dashboards = [];
let currentDashboard = null;
const expandedDashboards = new Set();
const sendIcon = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
const pendingToggles = new Map();
let availableDevices = [];
let commandDefinitions = {};
let deviceConfigs = {};
let ws;
let dragSrcEl = null;

const listSection = document.getElementById('listSection');
const editSection = document.getElementById('editSection');

async function init() {
    const params = new URLSearchParams(window.location.search);
    const expanded = params.get('expanded');
    if (expanded) {
        expanded.split(',').forEach(id => expandedDashboards.add(id));
    }

    connectWebSocket();
    await Promise.all([
        loadDashboards(),
        loadDevices(),
        loadCommandDefinitions()
    ]);
}

function connectWebSocket() {
    ws = new WebSocket(`ws://${window.location.host}`);
    ws.onopen = () => {
        refreshDashboardData();
    };
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'LATEST') {
            updateDashboardValues(msg.deviceId, msg.payload);
        }
    };
    ws.onclose = () => setTimeout(connectWebSocket, 1000);
}

async function loadCommandDefinitions() {
    const res = await fetch('/api/commands/definitions');
    commandDefinitions = await res.json();
}

async function loadDashboards() {
    const res = await fetch('/api/dashboards');
    dashboards = await res.json();
    renderList();
}

async function loadDevices() {
    const res = await fetch('/api/devices');
    availableDevices = await res.json();
    const sel = document.getElementById('deviceSelect');
    sel.innerHTML = '<option value="">-- Select Device --</option>';
    availableDevices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = d.name;
        sel.appendChild(opt);
    });
}

document.getElementById('deviceSelect').addEventListener('change', async (e) => {
    const deviceId = e.target.value;
    const keySelect = document.getElementById('keySelect');
    keySelect.innerHTML = '<option>Loading...</option>';
    keySelect.disabled = true;

    if (deviceId) {
        const res = await fetch(`/api/device/${deviceId}/keys`);
        const keys = await res.json();
        keySelect.innerHTML = '';
        keys.forEach(k => {
            // Strip 'data.' prefix for display/storage if present
            const cleanKey = k.startsWith('data.') ? k.substring(5) : k;
            const opt = document.createElement('option');
            opt.value = cleanKey;
            opt.textContent = cleanKey;
            keySelect.appendChild(opt);
        });
        keySelect.disabled = false;
    } else {
        keySelect.innerHTML = '<option>Select a device first</option>';
    }
});

function renderList() {
    const ul = document.getElementById('dashboardList');
    ul.innerHTML = '';
    dashboards.forEach(d => {
        const item = document.createElement('li');
        item.className = 'dashboard-item';
        
        const header = document.createElement('div');
        header.className = 'dashboard-header';
        header.innerHTML = `
            <div><strong>${d.name}</strong> <span style="color:#888; font-size:0.9em; margin-left:10px;">${d.metrics.length} metrics</span></div>
        `;
        header.onclick = () => toggleDashboard(d.id);

        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-secondary';
        editBtn.textContent = 'Edit';
        editBtn.style.fontSize = '0.8em';
        editBtn.style.padding = '4px 10px';
        editBtn.onclick = (e) => {
            e.stopPropagation();
            editDashboard(d.id);
        };
        header.appendChild(editBtn);

        const content = document.createElement('div');
        content.id = `dashboard-content-${d.id}`;
        content.className = 'dashboard-content';
        
        item.appendChild(header);
        item.appendChild(content);
        ul.appendChild(item);

        if (expandedDashboards.has(d.id)) {
            content.style.display = 'block';
            renderDashboardTable(d.id);
        }
    });
}

function showList() {
    listSection.style.display = 'block';
    editSection.style.display = 'none';
    currentDashboard = null;
}

async function toggleDashboard(id) {
    const content = document.getElementById(`dashboard-content-${id}`);
    if (expandedDashboards.has(id)) {
        expandedDashboards.delete(id);
        content.style.display = 'none';
    } else {
        expandedDashboards.add(id);
        content.style.display = 'block';
        await renderDashboardTable(id);
    }
    updateUrlState();
}

function updateUrlState() {
    const params = new URLSearchParams(window.location.search);
    if (expandedDashboards.size > 0) {
        params.set('expanded', Array.from(expandedDashboards).join(','));
    } else {
        params.delete('expanded');
    }
    const queryString = params.toString();
    const newUrl = queryString ? `${window.location.pathname}?${queryString}` : window.location.pathname;
    window.history.replaceState({}, '', newUrl);
}

async function renderDashboardTable(id) {
    const dashboard = dashboards.find(d => d.id === id);
    if (!dashboard) return;

    const container = document.getElementById(`dashboard-content-${id}`);
    container.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Metric</th>
                    <th>Value</th>
                    <th></th>
                    <th>Last Update</th>
                </tr>
            </thead>
            <tbody id="dashboardTableBody-${id}">
            </tbody>
        </table>
    `;

    // Load configs for devices in this dashboard
    const deviceIds = [...new Set(dashboard.metrics.map(m => m.split('.')[0]))];
    for (const devId of deviceIds) {
        if (!deviceConfigs[devId]) {
            const res = await fetch(`/api/device/${devId}/config`);
            deviceConfigs[devId] = await res.json();
        }
    }

    renderDashboardRows(dashboard);
    refreshDashboardData();
}

function renderDashboardRows(dashboard) {
    const tbody = document.getElementById(`dashboardTableBody-${dashboard.id}`);
    tbody.innerHTML = '';
    
    dashboard.metrics.forEach(metric => {
        const parts = metric.split('.');
        const deviceId = parts[0];
        const key = parts.slice(1).join('.');
        const keyParts = key.split('.');
        // Assuming structure Type.Subtype.Name.Metric
        const type = keyParts[0];
        const subtype = keyParts[1];
        const name = keyParts[2];
        const metricKey = keyParts[3];
        const configKey = subtype ? `${type}.${subtype}` : type;
        
        const row = document.createElement('tr');
        row.id = `row-${dashboard.id}-${metric.replace(/\./g, '-')}`;
        
        const label = getLabel(deviceId, key);
        const deviceName = availableDevices.find(d => d.id === deviceId)?.name || deviceId;
        
        let defs = commandDefinitions[configKey];
        if (!defs && configKey.includes('.')) {
            const p = configKey.split('.');
            defs = commandDefinitions[p[0]];
        }

        let commandName = 'set' + metricKey.charAt(0).toUpperCase() + metricKey.slice(1);
        if (defs && defs.keysToCommandsMap && defs.keysToCommandsMap[metricKey]) {
            commandName = defs.keysToCommandsMap[metricKey];
        }

        let valueContent = null;
        let actionContent = null;

        if (defs && defs.supportedCommands && defs.supportedCommands[commandName]) {
            const argType = defs.supportedCommands[commandName];
            
            let input;
            if (argType === 'boolean') {
                input = document.createElement('select');
                input.add(new Option('True', 'true'));
                input.add(new Option('False', 'false'));
            } else {
                input = document.createElement('input');
                input.type = (argType === 'integer' || argType === 'float') ? 'number' : 'text';
                if (argType === 'float') input.step = 'any';
            }
            valueContent = input;

            const btn = document.createElement('button');
            btn.className = 'send-command-btn';
            btn.title = 'Send Command';
            btn.innerHTML = sendIcon;
            btn.onclick = () => {
                let val = input.value;
                if (argType === 'integer') val = parseInt(val, 10);
                if (argType === 'float') val = parseFloat(val);
                if (argType === 'boolean') val = val === 'true';

                btn.disabled = true;
                btn.textContent = '...';
                fetch('/api/commands/queue', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        deviceId: deviceId,
                        subDevice: name,
                        command: commandName,
                        argument: val
                    })
                }).then(res => {
                    if (res.ok) {
                        btn.textContent = '✓';
                        setTimeout(() => { btn.disabled = false; btn.innerHTML = sendIcon; }, 1500);
                    } else {
                        btn.textContent = '✗';
                        btn.disabled = false;
                    }
                }).catch(err => { console.error(err); btn.textContent = '✗'; btn.disabled = false; });
            };
            actionContent = btn;
        }

        const keyCell = document.createElement('td');
        keyCell.className = 'key-cell';
        keyCell.innerHTML = `<div class="device-name">${deviceName} <span style="color:#888; font-weight:normal;">(${configKey}.${name})</span></div><a href="graph.html?deviceId=${deviceId}&fields=data.${key}">${label}</a>`;
        row.appendChild(keyCell);

        const valueCell = document.createElement('td');
        valueCell.className = 'value-cell';
        if (valueContent) {
            valueCell.appendChild(valueContent);
        } else {
            valueCell.textContent = '--';
        }
        row.appendChild(valueCell);

        const actionCell = document.createElement('td');
        actionCell.className = 'action-cell';
        if (actionContent) actionCell.appendChild(actionContent);
        row.appendChild(actionCell);

        const timeCell = document.createElement('td');
        timeCell.className = 'time-cell';
        timeCell.textContent = '--';
        row.appendChild(timeCell);

        tbody.appendChild(row);
    });
}

function refreshDashboardData() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const deviceIds = new Set();
        expandedDashboards.forEach(id => {
            const dash = dashboards.find(d => d.id === id);
            if (dash) {
                dash.metrics.forEach(m => deviceIds.add(m.split('.')[0]));
            }
        });
        
        deviceIds.forEach(deviceId => {
            ws.send(JSON.stringify({ type: 'GET_LATEST', deviceId }));
        });
    }
}

function updateDashboardValues(deviceId, data) {
    expandedDashboards.forEach(id => {
        const dash = dashboards.find(d => d.id === id);
        if (!dash) return;

        dash.metrics.forEach(metric => {
            if (!metric.startsWith(deviceId + '.')) return;
            
            const key = metric.substring(deviceId.length + 1);
            const rowId = `row-${id}-${metric.replace(/\./g, '-')}`;
            const row = document.getElementById(rowId);
            if (row) {
                const val = getValue(data.data, key);
                const valueCell = row.querySelector('.value-cell');
                const timeCell = row.querySelector('.time-cell');
                
                if (val !== undefined) {
                    const input = valueCell.querySelector('input, select');
                    if (input) {
                        if (document.activeElement !== input) {
                            if (input.tagName === 'SELECT') {
                                input.value = String(val);
                            } else {
                                input.value = val;
                            }
                        }
                    } else {
                        valueCell.innerHTML = '';
                        const keyParts = key.split('.');
                        const formatted = formatValue(keyParts[3], val, {
                            deviceId,
                            subDeviceName: keyParts[2],
                            subDeviceType: keyParts[1] ? `${keyParts[0]}.${keyParts[1]}` : keyParts[0]
                        });
                        if (formatted instanceof Node) valueCell.appendChild(formatted);
                        else valueCell.textContent = formatted;
                    }
                    
                    if (data.receivedAt) {
                        timeCell.textContent = new Date(data.receivedAt).toLocaleTimeString();
                    }
                }
            }
        });
    });
}

function getValue(obj, path) {
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
}

function getLabel(deviceId, key) {
    const parts = key.split('.');
    const metricName = parts[parts.length - 1];
    
    // Try device config
    const config = deviceConfigs[deviceId];
    if (config) {
        // Try exact match or wildcard match
        // Key structure in config is usually "Type.Subtype.Name" or "Type.Subtype.*"
        // The key passed here is "Type.Subtype.Name.Metric"
        // We need to find the config object for "Type.Subtype.Name"
        const parentKey = parts.slice(0, -1).join('.');
        let specificConfig = config[parentKey];
        
        if (!specificConfig) {
             // Try wildcard: Type.Subtype.*
             const typeSubtype = parts.slice(0, 2).join('.');
             specificConfig = config[`${typeSubtype}.*`];
        }

        if (specificConfig && specificConfig[metricName] && typeof specificConfig[metricName] === 'object' && specificConfig[metricName].label) {
            return specificConfig[metricName].label;
        }
    }

    // Try command definitions
    if (commandDefinitions && commandDefinitions[parts[0]] && commandDefinitions[parts[0]].labels && commandDefinitions[parts[0]].labels[metricName]) {
        return commandDefinitions[parts[0]].labels[metricName];
    }

    return formatKey(metricName);
}

function formatKey(key) {
    return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, str => str.toUpperCase());
}

function formatValue(key, value, context) {
    if (value === null || value === undefined) return '-';
    if (key === 'isOn' && typeof value === 'boolean') {
        const span = document.createElement('span');
        span.classList.add('status-indicator', value ? 'status-on' : 'status-off');
        span.textContent = '';

        let uniqueKey = null;
        if (context) {
            uniqueKey = `${context.deviceId}:${context.subDeviceType}:${context.subDeviceName}`;
            if (pendingToggles.has(uniqueKey)) {
                if (pendingToggles.get(uniqueKey) === value) {
                    pendingToggles.delete(uniqueKey);
                } else {
                    span.classList.add('pending');
                }
            }
        }

        let defs = null;
        if (context) {
            defs = commandDefinitions[context.subDeviceType];
            if (!defs && context.subDeviceType.includes('.')) {
                const parts = context.subDeviceType.split('.');
                defs = commandDefinitions[parts[0]];
            }
        }

        if (defs && defs.supportedCommands && defs.supportedCommands.hasOwnProperty('toggleState')) {
            span.classList.add('toggleable');
            span.title = 'Click to toggle';
            span.onclick = async (e) => {
                e.stopPropagation();
                span.classList.add('pending');
                if (uniqueKey) pendingToggles.set(uniqueKey, !value);
                try {
                    await fetch('/api/commands/queue', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            deviceId: context.deviceId,
                            subDevice: context.subDeviceName,
                            command: 'toggleState',
                            argument: true
                        })
                    });
                } catch (err) {
                    console.error(err);
                    span.classList.remove('pending');
                    if (uniqueKey) pendingToggles.delete(uniqueKey);
                }
            };
        }
        return span;
    }
    if (key === 'uptime') return formatDuration(value);
    if (typeof value === 'number') return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return String(value);
}

function formatDuration(ms) {
    if (typeof ms !== 'number') return '-';
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.length > 0 ? parts.join(' ') : '0s';
}

function showCreate() {
    currentDashboard = { id: null, name: 'New Dashboard', metrics: [] };
    renderEdit();
}

function editDashboard(id) {
    const dash = dashboards.find(d => d.id === id);
    if (dash) {
        currentDashboard = JSON.parse(JSON.stringify(dash)); // Clone
        renderEdit();
    }
}

function renderEdit() {
    listSection.style.display = 'none';
    editSection.style.display = 'block';

    document.getElementById('editTitle').textContent = currentDashboard.id ? 'Edit Dashboard' : 'Create Dashboard';
    document.getElementById('editName').value = currentDashboard.name;
    document.getElementById('btnDelete').style.display = currentDashboard.id ? 'inline-block' : 'none';

    renderEditMetrics();
}

function renderEditMetrics() {
    const container = document.getElementById('editMetricsList');
    container.innerHTML = '';
    currentDashboard.metrics.forEach((m, idx) => {
        const row = document.createElement('div');
        row.className = 'metric-row';
        row.draggable = true;
        row.dataset.index = idx;
        row.innerHTML = `
            <span style="cursor:move; color:#888; font-size:1.2em; padding-right: 8px;">&#8801;</span>
            <input type="text" value="${m}" readonly style="background:#eee;">
            <button class="btn btn-danger" onclick="removeMetric(${idx})">X</button>
        `;
        
        row.addEventListener('dragstart', handleDragStart);
        row.addEventListener('dragover', handleDragOver);
        row.addEventListener('dragenter', handleDragEnter);
        row.addEventListener('dragleave', handleDragLeave);
        row.addEventListener('drop', handleDrop);
        row.addEventListener('dragend', handleDragEnd);

        container.appendChild(row);
    });
}

function handleDragStart(e) {
    this.style.opacity = '0.4';
    dragSrcEl = this;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dataset.index);
    document.getElementById('editMetricsList').classList.add('dragging-list');
}

function handleDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';
    return false;
}

function handleDragEnter(e) {
    this.classList.add('over');
}

function handleDragLeave(e) {
    this.classList.remove('over');
}

function handleDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }

    if (dragSrcEl !== this) {
        const srcIndex = parseInt(dragSrcEl.dataset.index);
        const targetIndex = parseInt(this.dataset.index);
        
        const item = currentDashboard.metrics[srcIndex];
        currentDashboard.metrics.splice(srcIndex, 1);
        currentDashboard.metrics.splice(targetIndex, 0, item);
        
        renderEditMetrics();
    }
    return false;
}

function handleDragEnd(e) {
    this.style.opacity = '1';
    const rows = document.querySelectorAll('#editMetricsList .metric-row');
    rows.forEach(row => row.classList.remove('over'));
    document.getElementById('editMetricsList').classList.remove('dragging-list');
}

function removeMetric(idx) {
    currentDashboard.metrics.splice(idx, 1);
    renderEditMetrics();
}

function addMetricFromSelect() {
    const deviceId = document.getElementById('deviceSelect').value;
    const key = document.getElementById('keySelect').value;
    
    if (!deviceId || !key || key.includes('Select')) return;

    const fullMetric = `${deviceId}.${key}`;
    if (!currentDashboard.metrics.includes(fullMetric)) {
        currentDashboard.metrics.push(fullMetric);
        renderEditMetrics();
    }
}

async function saveCurrent() {
    const name = document.getElementById('editName').value;
    if (!name) return alert('Name is required');
    if (currentDashboard.metrics.length === 0) return alert('Add at least one metric');

    currentDashboard.name = name;

    try {
        const res = await fetch('/api/dashboards', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentDashboard)
        });
        
        if (res.ok) {
            const saved = await res.json();
            await loadDashboards();
            showList();
        } else {
            alert('Failed to save');
        }
    } catch (e) {
        console.error(e);
        alert('Error saving');
    }
}

async function deleteCurrent() {
    if (!confirm('Are you sure you want to delete this dashboard?')) return;
    
    await fetch(`/api/dashboards/${currentDashboard.id}`, { method: 'DELETE' });
    await loadDashboards();
    showList();
}

init();