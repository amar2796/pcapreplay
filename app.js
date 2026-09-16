const API_BASE = 'http://localhost:8080/api';

let appState = {
    loaded: false,
    running: false,
    paused: false,
    fileName: '',
    totalPackets: 0,
    packetsSent: 0,
    currentSpeed: 1.0,
    status: 'STOPPED',
    elapsedTime: 0,
    // Repeat/loop
    loopEnabled: false,
    loopCount: 0,
    // Packet routing accounting (channels are the only routing mechanism)
    packetsDropped: 0,
    hasChannels: false
};

// Every fetch() promise only rejects on network-level failure (DNS,
// connection refused, timeout) -- NOT on HTTP error status codes. Without
// this, a backend rejection like {"success":false,"error":"No packets
// loaded"} on a 400 response was being treated as a normal successful
// response by every api.* method below, so every caller's try/catch never
// fired for backend-reported errors -- only for actual network failures.
async function handleResponse(response) {
    let data;
    try {
        data = await response.json();
    } catch (e) {
        throw new Error(`Server returned an unreadable response (status ${response.status})`);
    }
    if (!response.ok) {
        throw new Error(data && data.error ? data.error : `Request failed (status ${response.status})`);
    }
    return data;
}

// PHASE 3 - Extended API
const api = {
    uploadFile: (file) => {
        const formData = new FormData();
        formData.append('file', file);
        return fetch(`${API_BASE}/upload`, { 
            method: 'POST', 
            body: formData 
        }).then(handleResponse);
    },
    
    getStatus: () => fetch(`${API_BASE}/status`).then(handleResponse),
    
    start: () => fetch(`${API_BASE}/start`, { method: 'POST' }).then(handleResponse),
    pause: () => fetch(`${API_BASE}/pause`, { method: 'POST' }).then(handleResponse),
    stop: () => fetch(`${API_BASE}/stop`, { method: 'POST' }).then(handleResponse),
    
    setSpeed: (multiplier) => fetch(`${API_BASE}/speed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ multiplier })
    }).then(handleResponse),

    // PHASE 3 - New configuration endpoints
    setConfig: (config) => fetch(`${API_BASE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    }).then(handleResponse),

    getConfig: () => fetch(`${API_BASE}/config`).then(handleResponse),
    getFileInfo: () => fetch(`${API_BASE}/file-info`).then(handleResponse),

    // Channel management
    getChannels: () => fetch(`${API_BASE}/channels`).then(handleResponse),
    addChannel: (channel) => fetch(`${API_BASE}/channels/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(channel)
    }).then(handleResponse),
    removeChannel: (name) => fetch(`${API_BASE}/channels/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    }).then(handleResponse)
};

// Backend connectivity heartbeat — independent of replay status polling,
// runs continuously from page load so the indicator reflects whether the
// backend is reachable at all, not just whether a replay is in progress.
let connectionCheckInterval = null;

async function checkBackendConnection() {
    const statusEl = document.getElementById('connectionStatus');
    const textEl = document.getElementById('connectionText');
    try {
        // /api/status already exists and responds even with nothing
        // loaded, so it doubles as a lightweight reachability check —
        // no new backend endpoint needed for this.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${API_BASE}/status`, { signal: controller.signal });
        clearTimeout(timeout);

        if (res.ok) {
            statusEl.className = 'connection-status online';
            textEl.textContent = 'Backend: Online';
        } else {
            throw new Error('Non-OK response');
        }
    } catch (err) {
        statusEl.className = 'connection-status offline';
        textEl.textContent = 'Backend: Offline';
    }
}

function startConnectionHeartbeat() {
    checkBackendConnection(); // immediate first check, don't wait for the interval
    if (connectionCheckInterval) clearInterval(connectionCheckInterval);
    connectionCheckInterval = setInterval(checkBackendConnection, 3000);
}

// PHASE 3 - Initialize configuration panel
function initConfigPanel() {
    document.getElementById('loopToggle').addEventListener('change', applyLoopToggle);
    document.getElementById('loopMaxCycles').addEventListener('change', applyLoopMaxCycles);
    document.getElementById('btnAddChannel').addEventListener('click', addChannelHandler);
    document.getElementById('btnCancelEditChannel').addEventListener('click', cancelEditChannel);
}

// Repeat/Loop: applied the same way as the port filter -- it's just a flag
// the replay loop checks, so it's safe to toggle at any time, running or not.
async function applyLoopToggle(e) {
    const enabled = e.target.checked;
    document.getElementById('loopMaxCycles').classList.toggle('hidden', !enabled);
    try {
        await api.setConfig({ loopEnabled: enabled });
        appState.loopEnabled = enabled;
    } catch (err) {
        // revert the checkbox visually if the backend rejected it, so the
        // UI never shows a state the backend didn't actually apply
        e.target.checked = !enabled;
        document.getElementById('loopMaxCycles').classList.toggle('hidden', enabled);
        alert(`Failed to change repeat setting: ${err.message}`);
    }
}

async function applyLoopMaxCycles(e) {
    const raw = parseInt(e.target.value, 10);
    const cycles = (!isNaN(raw) && raw >= 0) ? raw : 0;
    e.target.value = cycles;
    try {
        await api.setConfig({ loopMaxCycles: cycles });
        appState.loopMaxCycles = cycles;
    } catch (err) {
        alert(`Failed to change repeat count: ${err.message}`);
    }
}

// ===== Channels =====

// Tracks which channel (by its original name) is currently being edited,
// so saving the form updates that channel in place instead of adding a
// new one, and a name change triggers removing the old entry.
let editingChannelName = null;

function parsePortListLocal(text) {
    return text
        .split(/[,\s]+/)
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .map(s => parseInt(s, 10))
        .filter(n => !isNaN(n) && n >= 1 && n <= 65535);
}

// Multicast IPv4 is 224.0.0.0-239.255.255.255. Catches a typo like
// 255.x.x.x (meant to be 225.x.x.x) before it's even submitted -- that
// address isn't multicast at all and every send to it fails at the OS level.
function isValidMulticastIP(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    const octets = parts.map(p => (/^\d+$/.test(p) ? parseInt(p, 10) : NaN));
    if (octets.some(n => isNaN(n) || n < 0 || n > 255)) return false;
    return octets[0] >= 224 && octets[0] <= 239;
}

async function addChannelHandler() {
    const name = document.getElementById('channelName').value.trim();
    const matchPorts = parsePortListLocal(document.getElementById('channelMatchPorts').value);
    const destIP = document.getElementById('channelDestIP').value.trim();
    const destPort = parseInt(document.getElementById('channelDestPort').value, 10);

    if (!name) {
        showChannelsStatus('❌ Channel name is required', 'error');
        return;
    }
    if (matchPorts.length === 0) {
        showChannelsStatus('❌ At least one valid match port is required', 'error');
        return;
    }
    if (!destIP) {
        showChannelsStatus('❌ Destination IP is required', 'error');
        return;
    }
    if (!isValidMulticastIP(destIP)) {
        showChannelsStatus(`❌ '${destIP}' is not a valid multicast IP (must be 224.0.0.0-239.255.255.255)`, 'error');
        return;
    }
    if (isNaN(destPort) || destPort < 1 || destPort > 65535) {
        showChannelsStatus('❌ Destination port must be 1-65535', 'error');
        return;
    }

    const wasEditing = editingChannelName;
    const renamed = wasEditing && wasEditing !== name;
    const oldChannelBackup = renamed ? lastChannelsList.find(c => c.name === wasEditing) : null;

    try {
        if (renamed) {
            // Remove the old entry FIRST so its match ports are freed up —
            // otherwise adding the new name while the old one (with the
            // same ports) still exists would be falsely rejected as a
            // port conflict with itself.
            await api.removeChannel(wasEditing);
        }

        await api.addChannel({ name, matchPorts, destIP, destPort });

        showChannelsStatus(wasEditing ? `✓ Channel '${name}' updated` : `✓ Channel '${name}' saved`, 'success');
        cancelEditChannel(); // clears the form and exits edit mode
        await refreshChannels();
    } catch (err) {
        // If the rename removed the old channel but the new one failed to
        // save, restore the original from what we already had in memory
        // rather than leaving the user with neither.
        if (renamed && oldChannelBackup) {
            try {
                await api.addChannel({
                    name: oldChannelBackup.name,
                    matchPorts: oldChannelBackup.matchPorts,
                    destIP: oldChannelBackup.destIP,
                    destPort: oldChannelBackup.destPort
                });
            } catch (restoreErr) {
                console.error('Failed to restore original channel after failed rename:', restoreErr);
            }
        }
        showChannelsStatus(`❌ ${err.message}`, 'error');
        await refreshChannels();
    }
}

// Populate the form with an existing channel's values and switch it into
// edit mode, so saving updates that channel instead of adding a new one.
function startEditChannel(channel) {
    editingChannelName = channel.name;
    document.getElementById('channelName').value = channel.name;
    document.getElementById('channelMatchPorts').value = channel.matchPorts.join(', ');
    document.getElementById('channelDestIP').value = channel.destIP;
    document.getElementById('channelDestPort').value = channel.destPort;

    document.getElementById('btnAddChannel').textContent = '💾 Save Changes';
    document.getElementById('btnCancelEditChannel').classList.remove('hidden');
    document.querySelector('.channel-add-form').classList.add('editing');
    renderChannelsTable(lastChannelsList); // re-render to highlight the row being edited
    document.getElementById('channelName').focus();
}

function cancelEditChannel() {
    editingChannelName = null;
    document.getElementById('channelName').value = '';
    document.getElementById('channelMatchPorts').value = '';
    document.getElementById('channelDestIP').value = '';
    document.getElementById('channelDestPort').value = '';

    document.getElementById('btnAddChannel').textContent = '+ Add Channel';
    document.getElementById('btnCancelEditChannel').classList.add('hidden');
    document.querySelector('.channel-add-form').classList.remove('editing');
    renderChannelsTable(lastChannelsList);
}

async function removeChannelHandler(name) {
    try {
        await api.removeChannel(name);
        if (editingChannelName === name) cancelEditChannel(); // don't leave the form editing something that no longer exists
        await refreshChannels();
    } catch (err) {
        showChannelsStatus(`❌ ${err.message}`, 'error');
    }
}

function showChannelsStatus(message, type = 'success') {
    const el = document.getElementById('channelsStatus');
    el.textContent = message;
    el.className = `status-message ${type === 'error' ? 'error' : ''}`;
}

// Cached copy of the last fetched channel list, so edit/cancel can
// re-render the table (to toggle the highlighted row) without an extra
// round-trip to the backend.
let lastChannelsList = [];

function renderChannelsTable(channels) {
    const tbody = document.getElementById('channelsTableBody');
    const warning = document.getElementById('noChannelsWarning');
    lastChannelsList = channels || [];
    appState.hasChannels = !!(channels && channels.length > 0);

    if (!appState.hasChannels) {
        tbody.innerHTML = '<tr><td colspan="6" class="channels-empty-row">⚠️ No channels configured — add at least one below before you can start a replay.</td></tr>';
        warning.classList.remove('hidden');
        updateUI();
        return;
    }
    warning.classList.add('hidden');

    tbody.innerHTML = channels.map(ch => `
        <tr class="${ch.name === editingChannelName ? 'channel-row-editing' : ''}">
            <td>${escapeHtml(ch.name)}</td>
            <td>${ch.matchPorts.join(', ')}</td>
            <td>${escapeHtml(ch.destIP)}:${ch.destPort}</td>
            <td>${ch.packetsSent}</td>
            <td>${ch.healthy
                ? ''
                : `<span class="channel-error-badge" title="${escapeHtml(ch.lastError || 'Send failing')}">⚠ Error</span>`}</td>
            <td class="channel-actions">
                <button class="channel-edit-btn" data-channel="${escapeHtml(ch.name)}">Edit</button>
                <button class="channel-remove-btn" data-channel="${escapeHtml(ch.name)}">Remove</button>
            </td>
        </tr>
    `).join('');

    tbody.querySelectorAll('.channel-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => removeChannelHandler(btn.dataset.channel));
    });
    tbody.querySelectorAll('.channel-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const channel = lastChannelsList.find(c => c.name === btn.dataset.channel);
            if (channel) startEditChannel(channel);
        });
    });
    updateUI();
}

async function refreshChannels() {
    try {
        const channels = await api.getChannels();
        renderChannelsTable(channels);
    } catch (err) {
        console.error('Failed to refresh channels:', err);
    }
}

// ===== Shared helper =====

// Used by channel rendering to avoid injecting raw user-supplied
// names/IPs into innerHTML unescaped.
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Populate the configuration panels with whatever the backend is
// currently configured to, so a page refresh doesn't show stale defaults
// while the server is actually running with different settings.
async function loadCurrentConfig() {
    try {
        const data = await api.getConfig();
        if (typeof data.loopEnabled === 'boolean') {
            appState.loopEnabled = data.loopEnabled;
            document.getElementById('loopToggle').checked = data.loopEnabled;
            document.getElementById('loopMaxCycles').classList.toggle('hidden', !data.loopEnabled);
        }
        if (typeof data.loopMaxCycles === 'number') {
            appState.loopMaxCycles = data.loopMaxCycles;
            document.getElementById('loopMaxCycles').value = data.loopMaxCycles;
        }
    } catch (err) {
        console.error('Failed to load current config:', err);
    }
}

// UI Update
function updateUI() {
    const progress = appState.totalPackets > 0 
        ? (appState.packetsSent / appState.totalPackets) * 100 
        : 0;
    
    document.getElementById('progressFill').style.width = `${progress}%`;
    document.getElementById('progressPercent').textContent = `${progress.toFixed(1)}%`;
    document.getElementById('statTotalPackets').textContent = appState.totalPackets;
    document.getElementById('statSentPackets').textContent = appState.packetsSent;
    document.getElementById('statDroppedPackets').textContent = appState.packetsDropped;
    
    document.getElementById('btnStart').disabled = !appState.loaded || appState.running || !appState.hasChannels;
    document.getElementById('btnPause').disabled = !appState.running;
    document.getElementById('btnStop').disabled = !appState.running && !appState.paused;

    updateUploadLockState();
    
    document.getElementById('statusLabel').textContent = appState.status;

    const cycleInfo = document.getElementById('loopCycleInfo');
    if (appState.loopEnabled && appState.loopCount > 0) {
        cycleInfo.textContent = `🔁 Looping — cycle ${appState.loopCount + 1} in progress`;
        cycleInfo.classList.remove('hidden');
    } else {
        cycleInfo.classList.add('hidden');
    }
}

// Status Refresh
let statusInterval = null;

async function refreshStatus() {
    try {
        const data = await api.getStatus();
        appState.packetsSent = data.packetsSent || 0;
        appState.packetsDropped = data.packetsFiltered || 0;
        appState.loopCount = data.loopCount || 0;
        appState.status = data.status || 'UNKNOWN';
        appState.running = data.running || false;
        appState.paused = data.paused || false;
        
        updateUI();
        updateCharts(appState.packetsSent);
        refreshChannels();
    } catch (err) {
        console.error('Status refresh failed:', err);
    }
}

// Chart initialization
let packetsChart = null;
let throughputChart = null;
let chartLabels = [];
let packetsData = [];
let throughputData = [];

function initCharts() {
    // Chart.js throws "Canvas is already in use" if a chart already exists
    // on a canvas — this fires on every upload after the first one, since
    // nothing was ever destroying the previous instance. The exception was
    // then caught by the upload handler's try/catch and misreported as
    // "Upload failed", even though the file itself had already loaded
    // successfully by that point.
    if (packetsChart) {
        packetsChart.destroy();
        packetsChart = null;
    }
    if (throughputChart) {
        throughputChart.destroy();
        throughputChart = null;
    }

    // Also clear stale data so a new upload starts with a clean chart
    // instead of carrying over the previous file's data points.
    chartLabels.length = 0;
    packetsData.length = 0;
    throughputData.length = 0;

    const ctx1 = document.getElementById('packetsChart').getContext('2d');
    packetsChart = new Chart(ctx1, {
        type: 'line',
        data: {
            labels: chartLabels,
            datasets: [{
                label: 'Packets Sent',
                data: packetsData,
                borderColor: '#667eea',
                backgroundColor: 'rgba(102, 126, 234, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.1,
                pointRadius: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            animation: false,
            scales: {
                y: { beginAtZero: true }
            }
        }
    });

    const ctx2 = document.getElementById('throughputChart').getContext('2d');
    throughputChart = new Chart(ctx2, {
        type: 'bar',
        data: {
            labels: chartLabels,
            datasets: [{
                label: 'Throughput (pkt/sec)',
                data: throughputData,
                backgroundColor: '#82ca9d',
                borderColor: '#5fb884',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            animation: false,
            scales: {
                y: { beginAtZero: true }
            }
        }
    });
}

function updateCharts(currentPackets) {
    const now = new Date().toLocaleTimeString();
    
    if (chartLabels.length > 60) {
        chartLabels.shift();
        packetsData.shift();
        throughputData.shift();
    }
    
    chartLabels.push(now);
    packetsData.push(currentPackets);
    
    // Simple throughput calculation
    const throughput = chartLabels.length > 1 
        ? (currentPackets - (packetsData[packetsData.length - 2] || 0)) * 2 
        : 0;
    throughputData.push(Math.max(0, throughput));
    
    if (packetsChart) packetsChart.update();
    if (throughputChart) throughputChart.update();
}

// Event Listeners
document.getElementById('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    try {
        await api.uploadFile(file);
        // /api/upload only confirms success — it never returned fileName/
        // packetCount itself (that was silently producing "Loaded: undefined"
        // before). Fetch the real details, and the packet preview, in one
        // follow-up call.
        const info = await api.getFileInfo();
        appState.loaded = true;
        appState.fileName = info.fileName;
        appState.totalPackets = info.packetCount;
        appState.packetsSent = 0;
        
        document.getElementById('loadedFile').textContent = `Loaded: ${info.fileName}`;
        renderPacketPreview(info.preview);
        document.getElementById('dashboard').classList.remove('hidden');
        
        initCharts();
        updateUI();
    } catch (err) {
        alert(`Upload failed: ${err.message}`);
    }
});

function renderPacketPreview(preview) {
    const container = document.getElementById('packetPreview');
    const tbody = document.getElementById('packetPreviewBody');
    if (!preview || preview.length === 0) {
        container.classList.add('hidden');
        return;
    }
    tbody.innerHTML = preview.map(p => `
        <tr>
            <td>${p.index}</td>
            <td>${p.timeOffsetMs}</td>
            <td>${p.length}</td>
            <td>${p.protocol || '—'}</td>
            <td>${(p.srcPort === null || p.srcPort === undefined) ? '—' : p.srcPort}</td>
            <td>${(p.dstPort === null || p.dstPort === undefined) ? '—' : p.dstPort}</td>
        </tr>
    `).join('');
    container.classList.remove('hidden');
}

// Uploading a different file mid-replay would either be silently rejected
// by the backend (loadPackets() throws if running) or, worse, confuse
// whichever cycle is currently in flight. Lock the picker while a replay
// is active or paused, and unlock it once fully stopped.
function updateUploadLockState() {
    const locked = appState.running || appState.paused;
    document.getElementById('fileInput').disabled = locked;
    document.getElementById('uploadLockedNotice').classList.toggle('hidden', !locked);
}

document.getElementById('btnStart').addEventListener('click', async () => {
    if (!appState.hasChannels) {
        alert('Add at least one channel before starting a replay — with no channels configured, nothing would be sent.');
        return;
    }
    try {
        await api.start();
        appState.running = true;
        appState.status = 'RUNNING';
        
        if (statusInterval) clearInterval(statusInterval);
        statusInterval = setInterval(refreshStatus, 500);
        
        updateUI();
    } catch (err) {
        alert(`Start failed: ${err.message}`);
    }
});

document.getElementById('btnPause').addEventListener('click', async () => {
    try {
        await api.pause();
        appState.running = false;
        appState.paused = true;
        appState.status = 'PAUSED';
        
        if (statusInterval) clearInterval(statusInterval);
        updateUI();
    } catch (err) {
        alert(`Pause failed: ${err.message}`);
    }
});

document.getElementById('btnStop').addEventListener('click', async () => {
    try {
        await api.stop();
        appState.running = false;
        appState.paused = false;
        appState.packetsSent = 0;
        appState.packetsDropped = 0;
        appState.status = 'STOPPED';
        
        if (statusInterval) clearInterval(statusInterval);
        updateUI();
    } catch (err) {
        alert(`Stop failed: ${err.message}`);
    }
});

document.getElementById('speedRange').addEventListener('change', async (e) => {
    const speed = parseFloat(e.target.value);
    appState.currentSpeed = speed;
    document.getElementById('speedLabel').textContent = `${speed.toFixed(1)}x`;
    
    try {
        await api.setSpeed(speed);
    } catch (err) {
        console.error('Speed change failed:', err);
    }
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initConfigPanel();
    loadCurrentConfig();
    refreshChannels();
    startConnectionHeartbeat();
    updateUI();
});
