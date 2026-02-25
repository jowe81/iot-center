function timeAgo(dateString) {
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

async function loadStatus() {
    try {
        const res = await fetch('/api/status');
        const statuses = await res.json();
        const tbody = document.querySelector('#statusTable tbody');
        
        tbody.innerHTML = '';

        statuses.forEach(status => {
            const row = document.createElement('tr');
            
            const nameCell = document.createElement('td');
            const idCell = document.createElement('td');
            const statusCell = document.createElement('td');
            
            // Status Indicator
            const indicator = document.createElement('span');
            indicator.className = 'status-indicator';
            
            if (status.lastSeen && status.interval) {
                const diff = Date.now() - new Date(status.lastSeen).getTime();
                if (diff <= status.interval) {
                    indicator.classList.add('status-ok');
                } else if (diff <= status.interval * 2) {
                    indicator.classList.add('status-warn');
                } else {
                    indicator.classList.add('status-crit');
                }
            } else {
                indicator.classList.add('status-unknown');
            }
            statusCell.appendChild(indicator);

            const nameLink = document.createElement('a');
            nameLink.href = `manager.html?deviceId=${status.deviceId}`;
            nameLink.className = 'device-badge';
            nameLink.textContent = status.name;
            nameCell.appendChild(nameLink);

            idCell.textContent = status.deviceId;
            
            const timeCell = document.createElement('td');
            const agoCell = document.createElement('td');

            if (status.lastSeen) {
                timeCell.textContent = new Date(status.lastSeen).toLocaleString();
                agoCell.textContent = timeAgo(status.lastSeen);
            } else {
                timeCell.textContent = 'Never';
                agoCell.textContent = '-';
            }

            row.appendChild(nameCell);
            row.appendChild(idCell);
            row.appendChild(timeCell);
            row.appendChild(agoCell);
            row.appendChild(statusCell);
            tbody.appendChild(row);
        });
    } catch (err) {
        console.error('Failed to load status', err);
    }
}

loadStatus();