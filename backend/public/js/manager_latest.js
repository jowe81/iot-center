document.addEventListener('DOMContentLoaded', () => {
    const deviceSelect = document.getElementById('deviceSelect');
    const latestDataSection = document.getElementById('latestDataSection');
    const latestDataBody = document.getElementById('latestDataBody');

    if (!deviceSelect || !latestDataSection || !latestDataBody) return;

    let commandDefinitions = {};
    const pendingToggles = new Map();
    fetch('/api/commands/definitions').then(r => r.json()).then(d => commandDefinitions = d).catch(console.error);
    const definitionsPromise = fetch('/api/commands/definitions')
        .then(r => r.json())
        .then(d => { commandDefinitions = d; })
        .catch(console.error);

    deviceSelect.addEventListener('change', async (e) => {
        const deviceId = e.target.value;
        if (!deviceId) {
            latestDataSection.style.display = 'none';
            return;
        }

        await updateLatestData(deviceId);
    });

    setInterval(() => {
        if (deviceSelect.value) {
            updateLatestData(deviceSelect.value);
        }
    }, 60000);

    async function updateLatestData(deviceId) {
        try {
            await definitionsPromise;
            
            // Fetch the latest single record for the device
            // Assuming the API supports filtering by deviceId and limiting results
            const response = await fetch(`/api/device/${encodeURIComponent(deviceId)}/latest`);
            if (!response.ok) throw new Error('Failed to fetch data');
            
            const data = await response.json();
            // Handle if data is returned as an array or single object
            const latestRecord = Array.isArray(data) ? data[0] : data;

            if (latestRecord) {
                renderData(latestRecord, deviceId);
                latestDataSection.style.display = 'block';
            } else {
                latestDataSection.style.display = 'none';
            }
        } catch (error) {
            console.error('Error fetching latest data:', error);
            latestDataSection.style.display = 'none';
        }
    }

    function renderData(record, deviceId) {
        latestDataBody.innerHTML = '';

        const excludeFields = ['_id', 'deviceId', '__v', 'updatedAt', 'data'];

        // Display top-level fields first
        Object.keys(record).sort((a, b) => {
            if (a === 'receivedAt' || a === 'timestamp' || a === 'createdAt') return -1;
            if (b === 'receivedAt' || b === 'timestamp' || b === 'createdAt') return 1;
            return a.localeCompare(b);
        }).forEach(key => {
            if (excludeFields.includes(key) || (typeof record[key] === 'object' && record[key] !== null)) {
                return;
            }

            const row = document.createElement('tr');
            row.style.borderBottom = '1px solid #eee';

            const keyCell = document.createElement('td');
            keyCell.textContent = formatKey(key);
            keyCell.style.padding = '8px 4px';
            keyCell.style.fontWeight = 'bold';
            keyCell.style.color = '#555';
            keyCell.style.width = '40%';

            const valueCell = document.createElement('td');
            const val = formatValue(key, record[key]);
            if (val instanceof Node) valueCell.appendChild(val);
            else valueCell.textContent = val;
            valueCell.style.padding = '8px 4px';
            valueCell.style.textAlign = 'right';

            row.appendChild(keyCell);
            row.appendChild(valueCell);
            latestDataBody.appendChild(row);
        });

        // Process nested data object
        if (record.data && typeof record.data === 'object') {
            if (latestDataBody.children.length > 0) {
                const separatorRow = document.createElement('tr');
                separatorRow.innerHTML = '<td colspan="2" style="padding-top: 10px;"></td>';
                latestDataBody.appendChild(separatorRow);
            }

            Object.keys(record.data).sort().forEach(subdeviceType => {
                const subdevices = record.data[subdeviceType];
                if (typeof subdevices !== 'object' || subdevices === null) {
                    return; // Only process object subdevice data
                }

                // Subdevice header
                const headerRow = document.createElement('tr');
                const headerCell = document.createElement('td');
                headerCell.colSpan = 2;
                headerCell.textContent = formatKey(subdeviceType);
                headerCell.style.fontWeight = 'bold';
                headerCell.style.backgroundColor = '#f2f2f2';
                headerCell.style.padding = '5px';
                headerCell.style.marginTop = '10px';
                headerRow.appendChild(headerCell);
                latestDataBody.appendChild(headerRow);

                // Iterate through each subdevice instance of this type
                Object.keys(subdevices).sort().forEach(subdeviceName => {
                    const metrics = subdevices[subdeviceName];
                    if (typeof metrics !== 'object' || metrics === null) {
                        return;
                    }

                    const hasMultipleSubdevicesOfThisType = Object.keys(subdevices).length > 1;

                    if (hasMultipleSubdevicesOfThisType) {
                        const subHeaderRow = document.createElement('tr');
                        const subHeaderCell = document.createElement('td');
                        subHeaderCell.colSpan = 2;
                        subHeaderCell.textContent = formatKey(subdeviceName);
                        subHeaderCell.style.fontWeight = '600';
                        subHeaderCell.style.color = '#444';
                        subHeaderCell.style.padding = '6px 6px 6px 20px';
                        subHeaderCell.style.backgroundColor = '#f9f9f9';
                        subHeaderRow.appendChild(subHeaderCell);
                        latestDataBody.appendChild(subHeaderRow);
                    }

                    // Iterate through each metric for the subdevice instance
                    Object.keys(metrics).sort().forEach(metricKey => {
                        const row = document.createElement('tr');
                        row.style.borderBottom = '1px solid #eee';

                        const keyCell = document.createElement('td');
                        keyCell.textContent = formatKey(metricKey);
                        keyCell.style.padding = hasMultipleSubdevicesOfThisType ? '8px 4px 8px 35px' : '8px 4px 8px 20px';
                        keyCell.style.fontWeight = 'normal';
                        keyCell.style.color = '#555';
                        keyCell.style.width = '40%';

                        const valueCell = document.createElement('td');
                        const val = formatValue(metricKey, metrics[metricKey], {
                            deviceId,
                            subDeviceName: subdeviceName,
                            subDeviceType: subdeviceType
                        });
                        if (val instanceof Node) valueCell.appendChild(val);
                        else valueCell.textContent = val;
                        valueCell.style.padding = '8px 4px';
                        valueCell.style.textAlign = 'right';

                        row.appendChild(keyCell);
                        row.appendChild(valueCell);
                        latestDataBody.appendChild(row);
                    });
                });
            });
        }
    }

    function formatKey(key) {
        return key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
    }

    function formatValue(key, value, context) {
        if (value === null || value === undefined) return '-';

        if (key === 'isOn' && typeof value === 'boolean') {
            const span = document.createElement('span');
            span.style.color = value ? '#28a745' : '#dc3545';
            span.style.fontSize = '1.2em';
            span.textContent = '●';

            let uniqueKey = null;
            if (context) {
                uniqueKey = `${context.deviceId}:${context.subDeviceType}:${context.subDeviceName}`;
                if (pendingToggles.has(uniqueKey)) {
                    if (pendingToggles.get(uniqueKey) === value) {
                        pendingToggles.delete(uniqueKey);
                    } else {
                        span.style.opacity = '0.5';
                    }
                }
            }

            if (context && commandDefinitions[context.subDeviceType]) {
                const cmds = commandDefinitions[context.subDeviceType].supportedCommands;
                if (cmds && cmds.hasOwnProperty('toggleState')) {
                    span.style.cursor = 'pointer';
                    span.title = 'Click to toggle';
                    span.onclick = async (e) => {
                        e.stopPropagation();
                        span.style.opacity = '0.5';
                        if (uniqueKey) pendingToggles.set(uniqueKey, !value);
                        try {
                            const argType = cmds.toggleState;
                            const arg = argType === 'boolean' ? true : null;
                            await fetch('/api/commands/queue', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({
                                    deviceId: context.deviceId,
                                    subDevice: context.subDeviceName,
                                    command: 'toggleState',
                                    argument: arg
                                })
                            });
                        } catch (err) {
                            console.error(err);
                            span.style.opacity = '1';
                            if (uniqueKey) pendingToggles.delete(uniqueKey);
                        }
                    };
                }
            }
            return span;
        }

        if (key === 'uptime') return formatDuration(value);
        if (typeof value === 'number') return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
});