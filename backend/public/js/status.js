let ws;

function timeAgo(dateString) { // This function is already defined in utils.js, but keeping it here for self-containment if utils.js is not loaded.
    if (!dateString) return '';
    const seconds = Math.floor((new Date() - new Date(dateString)) / 1000);

    let interval = Math.floor(seconds / 31536000);
    if (interval >= 1) return interval + "y";
    interval = Math.floor(seconds / 2592000);
    if (interval >= 1) return interval + "mo";
    interval = Math.floor(seconds / 86400);
    if (interval >= 1) return interval + "d";
    interval = Math.floor(seconds / 3600);
    if (interval >= 1) return interval + "h";
    interval = Math.floor(seconds / 60);
    if (interval >= 1) return interval + "m";
    return "Just now";
}

const tbody = document.querySelector('#statusTable tbody');

function renderStatusTable(statuses) {
    tbody.innerHTML = ''; // Clear existing rows
    statuses.forEach(status => renderStatusRow(status));
}

function renderStatusRow(status) {
    let row = document.getElementById(`status-row-${status.deviceId}`);
    if (!row) {
        row = document.createElement('tr');
        row.id = `status-row-${status.deviceId}`;
        row.appendChild(document.createElement('td'));
        row.appendChild(document.createElement('td'));
        row.appendChild(document.createElement('td'));
        row.appendChild(document.createElement('td'));
        row.appendChild(document.createElement('td'));
        row.appendChild(document.createElement('td'));
        tbody.appendChild(row);
    }

    // Update cells
    const nameCell = row.children[0];
    const idCell = row.children[1];
    const protocolCell = row.children[2];
    const timeCell = row.children[3];
    const agoCell = row.children[4];
    const statusCell = row.children[5];

    // Name Cell (Badge)
    const nameLink = nameCell.querySelector('.device-badge') || document.createElement('a');
    nameLink.href = `manager.html?deviceId=${status.deviceId}`;
    nameLink.className = 'device-badge';
    nameLink.textContent = status.name;
    if (!nameCell.querySelector('.device-badge')) nameCell.appendChild(nameLink);

    // ID Cell
    idCell.textContent = status.deviceId;

    // Protocol Cell
    protocolCell.textContent = status.protocol ? status.protocol.toUpperCase() : '-';

    // Last Seen and Ago
    if (status.lastSeen) {
        timeCell.textContent = new Date(status.lastSeen).toLocaleString();
        agoCell.textContent = timeAgo(status.lastSeen);
    } else {
        timeCell.textContent = 'Never';
        agoCell.textContent = '-';
    }

    // Status Indicator
    const indicator = statusCell.querySelector('.status-indicator') || document.createElement('span');
    indicator.className = 'status-indicator';
    indicator.classList.remove('status-ok', 'status-warn', 'status-crit', 'status-unknown');
    if (status.lastSeen && status.interval) {
        const diff = Date.now() - new Date(status.lastSeen).getTime();
        if (diff < 60000 || diff <= status.interval) indicator.classList.add('status-ok');
        else if (diff <= status.interval * 2) indicator.classList.add('status-warn');
        else indicator.classList.add('status-crit');
    } else {
        indicator.classList.add('status-unknown');
    }
    if (!statusCell.querySelector('.status-indicator')) statusCell.appendChild(indicator);

    // Append row if new, otherwise it's already in place
    if (!row.parentNode) {
        tbody.appendChild(row);
    }
}

function connectWebSocket() {
    ws = new WebSocket(`ws://${window.location.host}`);

    ws.onopen = () => {
        console.log('WebSocket connected for status updates.');
        ws.send(JSON.stringify({ type: 'GET_ALL_STATUSES' }));
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'ALL_STATUSES') {
            renderStatusTable(msg.payload);
        } else if (msg.type === 'STATUS_UPDATE') {
            renderStatusRow(msg.payload);
        }
    };

    ws.onclose = () => {
        console.log('WebSocket disconnected for status updates. Reconnecting...');
        setTimeout(connectWebSocket, 1000); // Attempt to reconnect after 1 second
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
}

connectWebSocket();