const deviceSelect = document.getElementById('deviceSelect');
const subDeviceSelect = document.getElementById('subDeviceSelect');
const commandSelect = document.getElementById('commandSelect');
const argSelect = document.getElementById('argSelect');
const argContainer = document.getElementById('argContainer');
const argInputInt = document.getElementById('argInputInt');
const sendBtn = document.getElementById('sendCommandBtn');
const messageDiv = document.getElementById('message');
const backLink = document.querySelector('.back-link');

let commandDefinitions = {};
let currentSubDeviceType = null;

// Load initial data
async function init() {
    try {
        // Load command definitions
        const defRes = await fetch('/api/commands/definitions');
        commandDefinitions = await defRes.json();

        // Load devices
        const devRes = await fetch('/api/devices');
        const devices = await devRes.json();
        
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
            await loadSubDevices(deviceId);
            deviceSelect.parentElement.style.display = 'none';
            if (backLink) backLink.href = `manager.html?deviceId=${deviceId}`;

            // Restore sub-device and command from URL
            const subDevice = urlParams.get('subDevice');
            if (subDevice && subDeviceSelect.querySelector(`option[value="${subDevice}"]`)) {
                subDeviceSelect.value = subDevice;
                loadCommands();

                const command = urlParams.get('command');
                if (command && commandSelect.querySelector(`option[value="${command}"]`)) {
                    commandSelect.value = command;
                    showArgument();
                }
            }
        }
    } catch (err) {
        console.error('Failed to init', err);
    }
}

// Load sub-devices for selected device
async function loadSubDevices(deviceId) {
    subDeviceSelect.innerHTML = '<option value="">Select a sub-device...</option>';
    subDeviceSelect.disabled = true;
    commandSelect.innerHTML = '<option value="">Select a command...</option>';
    commandSelect.disabled = true;
    argContainer.style.display = 'none';
    sendBtn.disabled = true;

    if (!deviceId) return;

    try {
        const res = await fetch(`/api/device/${deviceId}/controls`);
        const subDevices = await res.json();

        subDevices.forEach(sd => {
            const option = document.createElement('option');
            option.value = sd.name;
            option.textContent = `${sd.name} (${sd.type})`;
            option.dataset.type = sd.type;
            subDeviceSelect.appendChild(option);
        });
        subDeviceSelect.disabled = false;
    } catch (err) {
        console.error('Failed to load sub-devices', err);
    }
}

// Load commands for selected sub-device type
function loadCommands() {
    commandSelect.innerHTML = '<option value="">Select a command...</option>';
    commandSelect.disabled = true;
    argContainer.style.display = 'none';
    sendBtn.disabled = true;

    const selectedOption = subDeviceSelect.selectedOptions[0];
    if (!selectedOption || !selectedOption.value) return;

    currentSubDeviceType = selectedOption.dataset.type;
    const typeDef = commandDefinitions[currentSubDeviceType];

    if (typeDef && typeDef.supportedCommands) {
        for (const [cmd, argType] of Object.entries(typeDef.supportedCommands)) {
            const option = document.createElement('option');
            option.value = cmd;
            option.textContent = cmd;
            option.dataset.argType = argType;
            commandSelect.appendChild(option);
        }
        commandSelect.disabled = false;
    }
}

// Show argument input based on command
function showArgument() {
    const selectedOption = commandSelect.selectedOptions[0];
    if (!selectedOption || !selectedOption.value) {
        argContainer.style.display = 'none';
        sendBtn.disabled = true;
        return;
    }

    const argType = selectedOption.dataset.argType;
    if (argType === 'boolean') {
        argContainer.style.display = 'flex';
        argSelect.style.display = '';
        argInputInt.style.display = 'none';
        sendBtn.disabled = false;
    } else if (argType === 'integer') {
        argContainer.style.display = 'flex';
        argSelect.style.display = 'none';
        argInputInt.style.display = '';
        sendBtn.disabled = false;
    } else {
        // Extend here for other types later
        argContainer.style.display = 'none';
        sendBtn.disabled = false; // Enable if no arg needed? User prompt implies boolean always for now.
    }
}

async function sendCommand() {
    const deviceId = deviceSelect.value;
    const subDevice = subDeviceSelect.value;
    const command = commandSelect.value;
    
    const selectedOption = commandSelect.selectedOptions[0];
    const argType = selectedOption ? selectedOption.dataset.argType : null;
    let argument;

    if (argType === 'integer') {
        argument = parseInt(argInputInt.value, 10);
    } else {
        argument = argSelect.value === 'true'; // Convert string to boolean
    }

    try {
        const res = await fetch('/api/commands/queue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId, subDevice, command, argument })
        });
        const result = await res.json();
        messageDiv.textContent = `Command queued: ${result.status}`;
        setTimeout(() => messageDiv.textContent = '', 3000);
    } catch (err) {
        messageDiv.textContent = 'Error sending command';
        console.error(err);
    }
}

function updateUrl() {
    const params = new URLSearchParams(window.location.search);
    if (deviceSelect.value) params.set('deviceId', deviceSelect.value);
    
    if (subDeviceSelect.value) params.set('subDevice', subDeviceSelect.value);
    else params.delete('subDevice');

    if (commandSelect.value) params.set('command', commandSelect.value);
    else params.delete('command');

    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);
}

deviceSelect.addEventListener('change', (e) => {
    loadSubDevices(e.target.value);
    if (backLink) backLink.href = `manager.html?deviceId=${e.target.value}`;
    updateUrl();
});
subDeviceSelect.addEventListener('change', () => {
    loadCommands();
    updateUrl();
});
commandSelect.addEventListener('change', () => {
    showArgument();
    updateUrl();
});
sendBtn.addEventListener('click', sendCommand);

init();