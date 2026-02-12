document.addEventListener('DOMContentLoaded', () => {
    const sendIcon = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';

    const deviceSelect = document.getElementById('deviceSelect');
    const latestDataSection = document.getElementById('latestDataSection');
    const latestDataBody = document.getElementById('latestDataBody');

    if (!deviceSelect || !latestDataSection || !latestDataBody) return;

    // Create Raw Data Section if it doesn't exist
    let latestRawDataSection = document.getElementById('latestRawDataSection');
    let latestRawDataBody = document.getElementById('latestRawDataBody');

    if (!latestRawDataSection && latestDataSection) {
        latestRawDataSection = document.createElement('div');
        latestRawDataSection.id = 'latestRawDataSection';
        latestRawDataSection.style.display = 'none';
        latestRawDataSection.style.marginTop = '20px';
        
        const header = document.createElement('h3');
        header.textContent = 'Latest Raw Data';
        latestRawDataSection.appendChild(header);

        latestRawDataBody = document.createElement('pre');
        latestRawDataBody.id = 'latestRawDataBody';
        latestRawDataBody.style.backgroundColor = '#f5f5f5';
        latestRawDataBody.style.padding = '10px';
        latestRawDataBody.style.borderRadius = '4px';
        latestRawDataBody.style.overflowX = 'auto';
        latestRawDataBody.style.maxHeight = '300px';
        latestRawDataSection.appendChild(latestRawDataBody);

        latestDataSection.parentNode.insertBefore(latestRawDataSection, latestDataSection.nextSibling);
    }

    let deviceConfigResolve = null;
    let deviceConfigPromise = Promise.resolve({});
    let ws;

    function fetchDeviceConfig(deviceId) {
        deviceConfigPromise = new Promise((resolve) => {
            deviceConfigResolve = resolve;
        });
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'GET_DEVICE_CONFIG', deviceId }));
        }
    }

    function connectWebSocket() {
        ws = new WebSocket(`ws://${window.location.host}`);

        ws.onopen = () => {
            if (deviceSelect.value) {
                fetchDeviceConfig(deviceSelect.value);
                updateLatestData(deviceSelect.value);
            }
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === 'LATEST' && msg.deviceId === deviceSelect.value) {
                renderData(msg.payload, msg.deviceId);
                latestDataSection.style.display = 'block';
            }
            if (msg.type === 'LATEST_RAW' && msg.deviceId === deviceSelect.value) {
                if (msg.payload && latestRawDataSection && latestRawDataBody) {
                    latestRawDataBody.textContent = JSON.stringify(msg.payload, null, 2);
                    latestRawDataSection.style.display = 'block';
                } else if (latestRawDataSection) {
                    latestRawDataSection.style.display = 'none';
                }
            }
            if (msg.type === 'DEVICE_CONFIG' && msg.deviceId === deviceSelect.value) {
                if (deviceConfigResolve) deviceConfigResolve(msg.payload);
            }
        };

        ws.onclose = () => {
            setTimeout(connectWebSocket, 1000);
        };
    }

    connectWebSocket();

    let commandDefinitions = {};
    const pendingToggles = new Map();
    const definitionsPromise = fetch('/api/commands/definitions')
        .then(r => r.json())
        .then(d => { commandDefinitions = d; })
        .catch(console.error);

    deviceSelect.addEventListener('change', async (e) => {
        const deviceId = e.target.value;
        if (!deviceId) {
            latestDataSection.style.display = 'none';
            if (latestRawDataSection) latestRawDataSection.style.display = 'none';
            return;
        }

        fetchDeviceConfig(deviceId);
        updateLatestData(deviceId);
    });

    function updateLatestData(deviceId) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'GET_LATEST', deviceId }));
            ws.send(JSON.stringify({ type: 'GET_LATEST_RAW', deviceId }));
        }
    }

    async function renderData(record, deviceId) {
        if (!record) return;
        await definitionsPromise;
        const deviceConfig = await deviceConfigPromise;

        latestDataBody.innerHTML = '';

        // Top level keys
        Object.keys(record).sort().forEach(key => {
            if (['data', '_id', 'deviceId', 'receivedAt'].includes(key)) return;

            const row = document.createElement('tr');
            row.className = 'data-row';

            const keyCell = document.createElement('td');
            keyCell.className = 'key-cell';
            const link = document.createElement('a');
            link.href = `graph.html?deviceId=${encodeURIComponent(deviceId)}&fields=${encodeURIComponent(key)}`;
            link.textContent = formatKey(key);
            keyCell.appendChild(link);

            const valueCell = document.createElement('td');
            valueCell.className = 'value-cell';
            const val = formatValue(key, record[key]);
            if (val instanceof Node) valueCell.appendChild(val);
            else valueCell.textContent = val;

            const actionCell = document.createElement('td');
            actionCell.className = 'action-cell';

            row.appendChild(keyCell);
            row.appendChild(valueCell);
            row.appendChild(actionCell);
            latestDataBody.appendChild(row);
        });

        // Process nested data object
        if (record.data && typeof record.data === 'object') {
            if (latestDataBody.children.length > 0) {
                const separatorRow = document.createElement('tr');
                separatorRow.innerHTML = '<td colspan="3" class="separator-cell"></td>';
                latestDataBody.appendChild(separatorRow);
            }

            const subdeviceTypes = Object.keys(record.data);
            if (deviceConfig) {
                const configKeys = Object.keys(deviceConfig);
                subdeviceTypes.sort((a, b) => {
                    const idxA = configKeys.indexOf(a);
                    const idxB = configKeys.indexOf(b);
                    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
                    if (idxA !== -1) return -1;
                    if (idxB !== -1) return 1;
                    return a.localeCompare(b);
                });
            } else {
                subdeviceTypes.sort();
            }

            subdeviceTypes.forEach(subdeviceType => {
                const subdevices = record.data[subdeviceType];
                if (typeof subdevices !== 'object' || subdevices === null) {
                    return; // Only process object subdevice data
                }

                // Subdevice header
                const headerRow = document.createElement('tr');
                const headerCell = document.createElement('td');
                headerCell.className = 'header-cell';
                headerCell.colSpan = 3;
                headerCell.textContent = formatKey(subdeviceType);
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
                        subHeaderCell.className = 'subheader-cell';
                        subHeaderCell.colSpan = 3;
                        subHeaderCell.textContent = formatKey(subdeviceName);
                        subHeaderRow.appendChild(subHeaderCell);
                        latestDataBody.appendChild(subHeaderRow);
                    }

                    // Iterate through each metric for the subdevice instance
                    const metricKeys = Object.keys(metrics);
                    if (deviceConfig && deviceConfig[subdeviceType]) {
                        const typeConfig = deviceConfig[subdeviceType];
                        const configFields = Array.isArray(typeConfig) ? typeConfig : Object.keys(typeConfig);
                        metricKeys.sort((a, b) => {
                            const idxA = configFields.indexOf(a);
                            const idxB = configFields.indexOf(b);
                            if (idxA !== -1 && idxB !== -1) return idxA - idxB;
                            if (idxA !== -1) return -1;
                            if (idxB !== -1) return 1;
                            return a.localeCompare(b);
                        });
                    } else {
                        metricKeys.sort();
                    }

                    metricKeys.forEach(metricKey => {
                        const row = document.createElement('tr');
                        row.className = 'data-row';

                        const keyCell = document.createElement('td');
                        keyCell.className = 'key-cell';
                        if (hasMultipleSubdevicesOfThisType) {
                            keyCell.classList.add('deeply-indented-key-cell');
                        } else {
                            keyCell.classList.add('indented-key-cell');
                        }
                        const fullKey = `data.${subdeviceType}.${subdeviceName}.${metricKey}`;
                        const link = document.createElement('a');
                        link.href = `graph.html?deviceId=${encodeURIComponent(deviceId)}&fields=${encodeURIComponent(fullKey)}`;
                        
                        let label = formatKey(metricKey);
                        if (deviceConfig && 
                            deviceConfig[subdeviceType] && 
                            deviceConfig[subdeviceType][metricKey] &&
                            deviceConfig[subdeviceType][metricKey].label) {
                            label = deviceConfig[subdeviceType][metricKey].label;
                        }
                        
                        link.textContent = label;
                        keyCell.appendChild(link);

                        const valueCell = document.createElement('td');
                        valueCell.className = 'value-cell';
                        const actionCell = document.createElement('td');
                        actionCell.className = 'action-cell';

                        let commandName = 'set' + metricKey.charAt(0).toUpperCase() + metricKey.slice(1);
                        if (commandDefinitions[subdeviceType] && commandDefinitions[subdeviceType].keysToCommandsMap && commandDefinitions[subdeviceType].keysToCommandsMap[metricKey]) {
                            commandName = commandDefinitions[subdeviceType].keysToCommandsMap[metricKey];
                        }

                        if (commandDefinitions[subdeviceType] &&
                            commandDefinitions[subdeviceType].supportedCommands &&
                            commandDefinitions[subdeviceType].supportedCommands[commandName]) {

                            const argType = commandDefinitions[subdeviceType].supportedCommands[commandName];
                            // const container = document.createElement('div');
                            // container.className = 'command-container';

                            let input;
                            if (argType === 'boolean') {
                                input = document.createElement('select');
                                const optTrue = new Option('True', 'true');
                                const optFalse = new Option('False', 'false');
                                input.add(optTrue);
                                input.add(optFalse);
                                //if (metrics[metricKey] === false) optFalse.selected = true;
                                if (metrics[metricKey] === false) {
                                    optFalse.selected = true;
                                } else {
                                    optTrue.selected = true;
                                }
                            } else {
                                input = document.createElement('input');
                                input.type = argType === 'integer' ? 'number' : 'text';
                                if (metrics[metricKey] !== undefined && metrics[metricKey] !== null) {
                                    input.value = metrics[metricKey];
                                }
                            }
                            valueCell.appendChild(input);

                            const btn = document.createElement('button');
                            btn.className = 'send-command-btn';
                            btn.title = 'Send Command';
                            btn.innerHTML = sendIcon;
                            btn.onclick = () => {
                                let val = input.value;
                                if (argType === 'integer') val = parseInt(val, 10);
                                if (argType === 'boolean') val = val === 'true';

                                btn.disabled = true;
                                btn.textContent = '...';
                                fetch('/api/commands/queue', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        deviceId: deviceId,
                                        subDevice: subdeviceName,
                                        command: commandName,
                                        argument: val
                                    })
                                }).then(res => {
                                    if (res.ok) {
                                        btn.textContent = '✓';
                                        setTimeout(() => {
                                            btn.disabled = false;
                                            btn.innerHTML = sendIcon;
                                        }, 1500);
                                    } else {
                                        btn.textContent = '✗';
                                        btn.disabled = false;
                                    }
                                }).catch(err => {
                                    console.error(err);
                                    btn.textContent = '✗';
                                    btn.disabled = false;
                                });
                            };

                            actionCell.appendChild(btn);
                        } else {
                            const val = formatValue(metricKey, metrics[metricKey], {
                                deviceId,
                                subDeviceName: subdeviceName,
                                subDeviceType: subdeviceType
                            });
                            if (val instanceof Node) {
                                valueCell.appendChild(val);
                            } else {
                                valueCell.textContent = val;
                            }
                        }

                        row.appendChild(keyCell);
                        row.appendChild(valueCell);
                        row.appendChild(actionCell);
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

        if (key === 'protocol' && typeof value === 'string') return value.toUpperCase();
        if (key === 'isOn' && typeof value === 'boolean') {
            const span = document.createElement('span');
            span.classList.add('status-indicator', value ? 'status-on' : 'status-off');
            span.textContent = '●';

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

            if (context && commandDefinitions[context.subDeviceType]) {
                const cmds = commandDefinitions[context.subDeviceType].supportedCommands;
                if (cmds && cmds.hasOwnProperty('toggleState')) {
                    span.classList.add('toggleable');
                    span.title = 'Click to toggle';
                    span.onclick = async (e) => {
                        e.stopPropagation();
                        span.classList.add('pending');
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
                            span.classList.remove('pending');
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