/* global io */ // For Socket.IO

// --- Global Constants ---
const BASE_URL = window.location.origin;
const SINGLE_PROVER_PREVIEW_REFRESH_RATE_MS = 10 * 1000;
const SINGLE_PROVER_NUM_STYLES_TO_DISPLAY = 4;
const GRID_SIZE = 10;
const TIMER_DURATION = 90;

// --- Global Variables ---
let singleProverStyleRefreshInterval = null;
let socket = null;
let currentRoomId = null;
let isHost = false;
let currentGameMode = null;
let successCount = 0;
let failCount = 0;
let athScore = 0;
let timeLeft = TIMER_DURATION;
let timerInterval = null;
let gameActive = false;
let currentSingleProverScore = 0;
let currentSingleProverStyles = [];
let activeCells = new Set();
const provedStyleIds = new Set();

// --- DOM Element References ---
const DOM = {
    single: {
        grid: document.getElementById('grid'),
        stylePreview: document.getElementById('styles-preview'),
        activeCount: document.getElementById('active-count'),
        success: document.getElementById('success'),
        fail: document.getElementById('fail'),
        score: document.getElementById('score'),
        timer: document.getElementById('timer'),
        athScore: document.getElementById('ath-score'),
        startBtn: document.getElementById('start-btn'),
        endBtn: document.getElementById('end-btn'),
        leaderboard: document.getElementById('leaderboard'),
        finalResults: document.getElementById('single-final-results-display'),
        screen: document.getElementById('single-prover-screen'),
        gameOver: document.getElementById('game-over-screen-single')
    },
    vs: {
        grid: document.getElementById('vs-your-grid'),
        stylePreview: document.getElementById('vs-active-styles-preview'),
        activeCount: document.getElementById('vs-your-active-count'),
        yourScore: document.getElementById('vs-your-score'),
        opponentScore: document.getElementById('vs-opponent-score'),
        opponentStatus: document.getElementById('vs-opponent-status'),
        opponentProvername: document.getElementById('vs-opponent-provername'),
        yourProvername: document.getElementById('vs-your-provername'),
        timer: document.getElementById('vs-timer'),
        gameOver: document.getElementById('game-over-screen'),
        finalResults: document.getElementById('vs-final-results')
    },
    multi: {
        grid: document.getElementById('multi-grid'),
        stylePreview: document.getElementById('multi-styles-preview'),
        provername: document.getElementById('multi-provername'),
        timer: document.getElementById('multi-timer'),
        score: document.getElementById('multi-score'),
        proverCount: document.getElementById('multi-prover-count'),
        leader: document.getElementById('multi-leader'),
        proverList: document.getElementById('multi-prover-list'),
        activeCount: document.getElementById('multi-active-count'),
        waitingList: document.getElementById('multi-waiting-prover-list'),
        waitingCount: document.getElementById('multi-waiting-prover-count'),
        gameOver: document.getElementById('multi-game-over-screen'),
        finalResults: document.getElementById('multi-final-results')
    },
    status: {
        div: document.getElementById('connection-status'),
        indicator: document.getElementById('status-indicator'),
        text: document.getElementById('status-text')
    },
    lobby: {
        roomCode: document.getElementById('room-code'),
        currentRoomCode: document.getElementById('current-room-code'),
        hostControls: document.getElementById('host-controls'),
        startVsGame: document.getElementById('start-vs-game'),
        setReadyBtn: document.getElementById('set-ready-btn'),
        readyStatus: document.getElementById('ready-status-span'),
        proverList: document.getElementById('prover-list'),
        proverCount: document.getElementById('prover-count'),
        multiRoomCode: document.getElementById('multi-room-code'),
        multiCurrentRoomCode: document.getElementById('multi-current-room-code'),
        multiHostControls: document.getElementById('multi-host-controls'),
        multiStartGame: document.getElementById('multi-start-game'),
        multiHostBtn: document.getElementById('multi-host-btn'),
        multiJoinBtn: document.getElementById('multi-join-btn'),
        multiSetReadyBtn: document.getElementById('multi-set-ready-btn'),
        multiReadyStatus: document.getElementById('multi-ready-status-span')
    }
};

// --- Utility Functions ---
function showMessageBox(message, type = 'info', duration = 3000) {
    let msgBox = document.getElementById('custom-message-box');
    if (!msgBox) {
        msgBox = document.createElement('div');
        msgBox.id = 'custom-message-box';
        document.body.appendChild(msgBox);
    }
    msgBox.className = `custom-message-box ${type} show`;
    msgBox.textContent = message;
    setTimeout(() => msgBox.classList.remove('show'), duration);
}

function updateConnectionStatus(status) {
    const { div, indicator, text } = DOM.status;
    if (!div || !indicator || !text) return;
    indicator.textContent = status === 'connected' ? '🟢' : '🔴';
    text.textContent = status === 'connected' ? 'Connected' : 'Disconnected';
    div.classList.toggle('connected', status === 'connected');
    div.classList.toggle('disconnected', status !== 'connected');
    div.classList.remove('hidden');
    if (status === 'connected') setTimeout(() => div.classList.add('hidden'), 3000);
}

// --- Authentication and Initialization ---
const token = localStorage.getItem('nzkp-token');
const provername = localStorage.getItem('nzkp-provername');

document.addEventListener('DOMContentLoaded', () => {
    const currentPage = window.location.pathname.split('/').pop();
    document.querySelectorAll('[id*="logout-btn"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                await fetch(`${BASE_URL}/api/logout`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
            } catch (error) {
                showMessageBox('Logout failed due to network error.', 'error');
            } finally {
                localStorage.removeItem('nzkp-token');
                localStorage.removeItem('nzkp-provername');
                window.location.href = 'login.html';
            }
        });
    });

    if (!token || !provername) {
        if (currentPage !== 'login.html') redirectToLogin();
    } else {
        verifyAuthentication(currentPage);
    }

    if (currentPage === 'index.html') {
        currentGameMode = 'single';
        initializeSingleProverGame();
    } else if (currentPage === 'versus.html') {
        currentGameMode = 'vs';
        window.connectSocketForVSMode();
    } else if (currentPage === 'multi.html') {
        currentGameMode = 'multiprover';
        window.connectSocketForMultiprover();
    } else if (currentPage === 'mode.html' && window.showScreen && DOM.single.screen) {
        window.showScreen(DOM.single.screen);
    }
});

function redirectToLogin() {
    localStorage.removeItem('nzkp-token');
    localStorage.removeItem('nzkp-provername');
    window.location.href = 'login.html';
}

async function verifyAuthentication(currentPage) {
    try {
        const response = await fetch(`${BASE_URL}/api/verify`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) {
            showMessageBox(`Authentication failed (${response.status}). Redirecting to login.`, 'error');
            redirectToLogin();
            return;
        }
        const data = await response.json();
        if (data.success) {
            document.querySelectorAll('[id*="prover-name"], #current-prover, #multi-provername, #vs-your-provername')
                .forEach(el => el && (el.innerText = data.provername));
            if (DOM.single.athScore) fetchAthScore(data.provername);
            if (currentPage === 'login.html') window.location.href = 'mode.html';
        } else {
            showMessageBox(`Authentication failed: ${data.error}. Redirecting to login.`, 'error');
            redirectToLogin();
        }
    } catch (error) {
        showMessageBox('Network error during authentication. Redirecting to login.', 'error');
        redirectToLogin();
    }
}

async function fetchAthScore(provername) {
    if (!provername || !DOM.single.athScore) return;
    try {
        const response = await fetch(`${BASE_URL}/api/prover/${provername}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        if (data.success) {
            athScore = data.athScore || 0;
            DOM.single.athScore.innerText = athScore;
        } else {
            DOM.single.athScore.innerText = 'N/A';
            showMessageBox('Failed to fetch ATH score.', 'error');
        }
    } catch (error) {
        DOM.single.athScore.innerText = 'Error';
        showMessageBox('Network error fetching ATH score.', 'error');
    }
}

async function saveScore(score) {
    try {
        const response = await fetch(`${BASE_URL}/api/submit-score`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ score })
        });
        const data = await response.json();
        if (data.success) {
            showMessageBox(data.message.includes('New ATH') ? 'New All-Time High Score! 🎉' : 'Score submitted.', 'success');
        } else {
            showMessageBox('Failed to submit score.', 'error');
        }
    } catch (error) {
        showMessageBox('Network error submitting score.', 'error');
    }
}

async function updateLeaderboard() {
    if (!DOM.single.leaderboard) return;
    try {
        const response = await fetch(`${BASE_URL}/api/leaderboard`);
        const data = await response.json();
        if (data.success) {
            DOM.single.leaderboard.innerHTML = `
                <table class="leaderboard-table">
                    <thead><tr><th>Rank</th><th>Prover</th><th>ATH Score</th></tr></thead>
                    <tbody>
                        ${data.leaderboard.map((entry, i) => {
                            const rank = i + 1;
                            const [rankClass, trophy] = rank === 1 ? ['gold', '🏆'] : rank === 2 ? ['silver', '🥈'] : rank === 3 ? ['bronze', '🥉'] : ['', ''];
                            return `<tr><td class="rank ${rankClass}"><span class="trophy">${trophy}</span>${rank}</td><td class="prover-name">${entry.provername}</td><td class="score">${entry.athScore}</td></tr>`;
                        }).join('')}
                    </tbody>
                </table>
            `;
        } else {
            DOM.single.leaderboard.innerHTML = '<p>Failed to load leaderboard.</p>';
        }
    } catch (error) {
        DOM.single.leaderboard.innerHTML = '<p>Network error: Could not load leaderboard.</p>';
    }
}

// --- Hardcoded Styles ---
const styleShapes = [
    { name: "Square", pattern: [[0,0],[0,1],[1,0],[1,1]] },
    { name: "Line H", pattern: [[0,0],[0,1],[0,2],[0,3]] },
    { name: "Line V", pattern: [[0,0],[1,0],[2,0],[3,0]] },
    { name: "L-TopLeft", pattern: [[0,0],[1,0],[2,0],[2,1]] },
    { name: "L-BottomLeft", pattern: [[0,0],[0,1],[1,1],[2,1]] },
    { name: "L-TopRight", pattern: [[0,1],[1,1],[2,0],[2,1]] },
    { name: "T-Center", pattern: [[0,1],[1,0],[1,1],[1,2]] },
    { name: "Z-Shape", pattern: [[0,0],[0,1],[1,1],[1,2]] },
    { name: "S-Shape", pattern: [[0,1],[0,2],[1,0],[1,1]] },
    { name: "Diagonal", pattern: [[0,0],[1,1],[2,2],[3,3]] },
    { name: "Reverse Diagonal", pattern: [[0,3],[1,2],[2,1],[3,0]] },
    { name: "Arrowhead", pattern: [[0,1],[1,0],[1,2],[2,1]] },
    { name: "Bent Line", pattern: [[0,0],[1,0],[1,1],[2,1]] },
    { name: "Stair", pattern: [[0,0],[1,0],[1,1],[2,1]] },
    { name: "Inverted L", pattern: [[0,1],[1,1],[2,1],[2,0]] },
    { name: "Hook", pattern: [[0,0],[0,1],[1,1],[1,2]] },
    { name: "Half Cross", pattern: [[0,1],[1,0],[1,1],[1,2]] },
    { name: "Tipped T", pattern: [[0,0],[0,1],[0,2],[1,1]] },
    { name: "Snake", pattern: [[0,0],[1,0],[1,1],[0,2]] },
    { name: "C-Left", pattern: [[0,0],[1,0],[2,0],[2,1]] },
    { name: "Y-Fragment", pattern: [[0,1],[1,0],[1,1],[2,1]] },
    { name: "Offset L", pattern: [[0,0],[0,1],[1,0],[1,1]] },
    { name: "Corner Box", pattern: [[0,0],[0,1],[1,0],[1,1]] },
    { name: "Skew T", pattern: [[0,0],[1,0],[1,1],[2,0]] }
];

function generateRandomStylesForClient(count) {
    const styles = [];
    const possiblePatterns = [...styleShapes];
    for (let i = 0; i < count; i++) {
        if (!possiblePatterns.length) {
            possiblePatterns.push(...styleShapes);
            if (!possiblePatterns.length) break;
        }
        const idx = Math.floor(Math.random() * possiblePatterns.length);
        const selectedPattern = { ...possiblePatterns.splice(idx, 1)[0] };
        selectedPattern.id = `client_style_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 8)}`;
        styles.push(selectedPattern);
    }
    return styles;
}

function checkPattern(selectedNodeIndices, patternCoords, localGridSize = GRID_SIZE) {
    if (selectedNodeIndices.length !== patternCoords.length || !selectedNodeIndices.length) return false;
    const coords = selectedNodeIndices.map(idx => [Math.floor(idx / localGridSize), idx % localGridSize]);
    const minRow = Math.min(...coords.map(c => c[0]));
    const minCol = Math.min(...coords.map(c => c[1]));
    const normalizedSelected = coords.map(c => [c[0] - minRow, c[1] - minCol]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const normalizedPattern = [...patternCoords].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return normalizedPattern.every((p, i) => p[0] === normalizedSelected[i][0] && p[1] === normalizedSelected[i][1]);
}

function buildGrid(gridContainer, mode) {
    if (!gridContainer) return;
    gridContainer.style.setProperty('--grid-cols', GRID_SIZE);
    gridContainer.style.setProperty('--grid-rows', GRID_SIZE);
    gridContainer.innerHTML = '';
    activeCells.clear();
    for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
        const node = document.createElement('div');
        node.classList.add('node');
        node.dataset.index = i;
        if (mode === 'single' || mode === 'vs-prover-own' || mode === 'multiprover') {
            node.addEventListener('click', () => toggleCell(node, i, mode));
        }
        gridContainer.appendChild(node);
    }
}

function clearGridAndActive(mode) {
    const grid = mode === 'single' ? DOM.single.grid : mode === 'vs-prover-own' ? DOM.vs.grid : DOM.multi.grid;
    const activeCount = mode === 'single' ? DOM.single.activeCount : mode === 'vs-prover-own' ? DOM.vs.activeCount : DOM.multi.activeCount;
    if (grid) {
        const nodes = grid.querySelectorAll('.node');
        nodes.forEach(node => node.classList.remove('active', 'proof-success', 'proof-fail'));
    }
    activeCells.clear();
    if (activeCount) activeCount.innerText = '0';
}

function toggleCell(nodeElement, index, mode) {
    if (!gameActive) {
        showMessageBox('Game not active. Press Start Game or wait for host.', 'info', 2000);
        return;
    }
    if (nodeElement.classList.contains('active')) {
        activeCells.delete(index);
        nodeElement.classList.remove('active');
    } else {
        if (activeCells.size >= 4) {
            showMessageBox('Maximum 4 cells can be selected for a pattern.', 'info', 1500);
            return;
        }
        activeCells.add(index);
        nodeElement.classList.add('active');
    }
    const selectedCount = activeCells.size;
    const activeCountEl = mode === 'single' ? DOM.single.activeCount : mode === 'vs-prover-own' ? DOM.vs.activeCount : DOM.multi.activeCount;
    if (activeCountEl) activeCountEl.innerText = selectedCount;
    if (selectedCount < 4) return;

    const selectedNodes = Array.from(activeCells);
    const grid = mode === 'single' ? DOM.single.grid : mode === 'vs-prover-own' ? DOM.vs.grid : DOM.multi.grid;
    const nodes = grid?.querySelectorAll('.node') || [];
    const activeNodes = selectedNodes.map(idx => nodes[idx]);

    if (mode === 'single') {
        let proved = false;
        let provedStyle = null;
        for (const style of currentSingleProverStyles) {
            if (checkPattern(selectedNodes, style.pattern)) {
                proved = true;
                provedStyle = style;
                break;
            }
        }
        if (proved) {
            successCount++;
            currentSingleProverScore += 10;
            timeLeft += 5;
            if (DOM.single.timer) DOM.single.timer.innerText = timeLeft;
            showMessageBox('✅Proof Successful +10 score. +5 seconds!', 'success');
            activeNodes.forEach(node => node?.classList.add('proof-success'));
            currentSingleProverStyles = currentSingleProverStyles.filter(s => s.id !== provedStyle.id);
            buildStylePreview(DOM.single.stylePreview, currentSingleProverStyles);
        } else {
            failCount++;
            showMessageBox('❌Fail Proof', 'error');
            activeNodes.forEach(node => node?.classList.add('proof-fail'));
        }
        setTimeout(() => clearGridAndActive(mode), 200);
        if (DOM.single.success) DOM.single.success.innerText = successCount;
        if (DOM.single.fail) DOM.single.fail.innerText = failCount;
        if (DOM.single.score) DOM.single.score.innerText = currentSingleProverScore;
    } else if (mode === 'vs-prover-own' || mode === 'multiprover') {
        if (socket?.connected && currentRoomId) {
            socket.emit('submit-proof', { roomId: currentRoomId, selectedNodes });
            clearGridAndActive(mode);
        } else {
            showMessageBox('Not connected to game. Cannot submit proof.', 'error', 3000);
            activeNodes.forEach(node => node?.classList.add('proof-fail'));
            setTimeout(() => clearGridAndActive(mode), 200);
        }
    }
}

function buildStylePreview(container, styles, provedStyleIdsSet = new Set()) {
    if (!container) return;
    container.innerHTML = '';
    styles.forEach(style => {
        const wrapper = document.createElement('div');
        wrapper.className = 'style-preview-wrapper';
        if (provedStyleIdsSet.has(style.id)) wrapper.classList.add('proved-style');
        const preview = document.createElement('div');
        preview.className = 'style-shape';
        preview.style.gridTemplateColumns = 'repeat(4, 10px)';
        preview.style.gridAutoRows = '10px';
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
                const cell = document.createElement('div');
                cell.classList.add('style-node');
                if (style.pattern.some(([pr, pc]) => pr === r && pc === c)) cell.classList.add('active');
                preview.appendChild(cell);
            }
        }
        const name = document.createElement('span');
        name.className = 'style-name';
        name.textContent = style.name;
        wrapper.appendChild(preview);
        wrapper.appendChild(name);
        container.appendChild(wrapper);
    });
}

// --- Game Mode Selection ---
window.selectMode = function(mode) {
    currentGameMode = mode;
    if (mode === 'single') {
        if (window.showScreen && DOM.single.screen) {
            window.showScreen(DOM.single.screen);
            initializeSingleProverGame();
        } else {
            window.location.href = 'index.html';
        }
    } else if (mode === 'vs') {
        if (window.showScreen && document.getElementById('lobby-screen')) {
            window.showScreen(document.getElementById('lobby-screen'));
            window.showLobbySubScreen?.(DOM.lobby.proverList);
            window.connectSocketForVSMode();
        } else {
            window.location.href = 'versus.html';
        }
    } else if (mode === 'multiprover') {
        if (window.showScreen && document.getElementById('multiprover-lobby-screen')) {
            window.showScreen(document.getElementById('multiprover-lobby-screen'));
            window.showMultiproverSubScreen?.(DOM.lobby.multiProverList);
            window.connectSocketForMultiprover();
        } else {
            window.location.href = 'multi.html';
        }
    }
};

window.backToModes = function() {
    if (socket?.connected && currentRoomId) {
        socket.emit('leave-room', { roomId: currentRoomId });
        socket.disconnect();
        socket = null;
    }
    currentRoomId = null;
    isHost = false;
    gameActive = false;
    activeCells.clear();
    provedStyleIds.clear();
    currentSingleProverStyles = [];
    window.location.href = 'mode.html';
};

// --- Single Prover Mode ---
function initializeSingleProverGame() {
    if (!DOM.single.grid) return;
    buildGrid(DOM.single.grid, 'single');
    currentSingleProverStyles = generateRandomStylesForClient(SINGLE_PROVER_NUM_STYLES_TO_DISPLAY);
    buildStylePreview(DOM.single.stylePreview, currentSingleProverStyles);
    resetSingleProverGame();
}

function resetSingleProverGame() {
    successCount = 0;
    failCount = 0;
    currentSingleProverScore = 0;
    gameActive = false;
    activeCells.clear();
    provedStyleIds.clear();
    clearGridAndActive('single');
    if (DOM.single.success) DOM.single.success.innerText = successCount;
    if (DOM.single.fail) DOM.single.fail.innerText = failCount;
    if (DOM.single.score) DOM.single.score.innerText = currentSingleProverScore;
    if (DOM.single.startBtn) DOM.single.startBtn.disabled = false;
    if (DOM.single.endBtn) DOM.single.endBtn.disabled = true;
    timeLeft = TIMER_DURATION;
    if (DOM.single.timer) DOM.single.timer.innerText = timeLeft;
    stopTimerSingleProver();
    stopSingleProverStyleRefreshLoop();
    if (DOM.single.finalResults) DOM.single.finalResults.classList.add('hidden');
    if (DOM.single.gameOver) DOM.single.gameOver.classList.remove('active');
    if (provername && DOM.single.athScore) fetchAthScore(provername);
    updateLeaderboard();
}

function startTimerSingleProver() {
    timeLeft = TIMER_DURATION;
    if (DOM.single.timer) DOM.single.timer.innerText = timeLeft;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        if (!gameActive) {
            stopTimerSingleProver();
            if (DOM.single.timer) DOM.single.timer.innerText = '0';
            return;
        }
        timeLeft--;
        if (DOM.single.timer) DOM.single.timer.innerText = timeLeft;
        if (timeLeft <= 0) {
            stopTimerSingleProver();
            endSingleProverGame();
            if (DOM.single.timer) DOM.single.timer.innerText = '0';
        }
    }, 1000);
}

function stopTimerSingleProver() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

function startSingleProverStyleRefreshLoop() {
    if (singleProverStyleRefreshInterval) clearInterval(singleProverStyleRefreshInterval);
    currentSingleProverStyles = generateRandomStylesForClient(SINGLE_PROVER_NUM_STYLES_TO_DISPLAY);
    buildStylePreview(DOM.single.stylePreview, currentSingleProverStyles);
    singleProverStyleRefreshInterval = setInterval(() => {
        currentSingleProverStyles = generateRandomStylesForClient(SINGLE_PROVER_NUM_STYLES_TO_DISPLAY);
        buildStylePreview(DOM.single.stylePreview, currentSingleProverStyles);
    }, SINGLE_PROVER_PREVIEW_REFRESH_RATE_MS);
}

function stopSingleProverStyleRefreshLoop() {
    if (singleProverStyleRefreshInterval) {
        clearInterval(singleProverStyleRefreshInterval);
        singleProverStyleRefreshInterval = null;
    }
}

async function endSingleProverGame() {
    if (!gameActive) return;
    gameActive = false;
    stopTimerSingleProver();
    stopSingleProverStyleRefreshLoop();
    if (currentSingleProverScore > athScore) {
        athScore = currentSingleProverScore;
        if (DOM.single.athScore) DOM.single.athScore.innerText = athScore;
        await saveScore(currentSingleProverScore);
    } else {
        showMessageBox(`Score: ${currentSingleProverScore}.`, 'info');
    }
    if (DOM.single.finalResults) {
        DOM.single.finalResults.innerHTML = `
            <p>Your Final Score: <strong>${currentSingleProverScore}</strong></p>
            <p>Proved: <strong>${successCount}</strong></p>
            <p>Failed: <strong>${failCount}</strong></p>
            <p>All-Time High: <strong>${athScore}</strong></p>
        `;
        DOM.single.finalResults.classList.remove('hidden');
    }
    if (DOM.single.screen) DOM.single.screen.classList.remove('active');
    if (DOM.single.gameOver && window.showScreen) window.showScreen(DOM.single.gameOver);
    if (DOM.single.startBtn) DOM.single.startBtn.disabled = false;
    if (DOM.single.endBtn) DOM.single.endBtn.disabled = true;
    updateLeaderboard();
}

window.startGame = function() {
    gameActive = true;
    resetSingleProverGame();
    startTimerSingleProver();
    startSingleProverStyleRefreshLoop();
    if (DOM.single.startBtn) DOM.single.startBtn.disabled = true;
    if (DOM.single.endBtn) DOM.single.endBtn.disabled = false;
};

window.playAgainSingleProver = function() {
    if (DOM.single.gameOver) DOM.single.gameOver.classList.remove('active');
    if (DOM.single.screen) DOM.single.screen.classList.add('active');
    initializeSingleProverGame();
    startGame();
};

// --- Multiplayer Socket.IO ---
window.connectSocketForVSMode = function() {
    connectToMultiproverServer('vs');
};

window.connectSocketForMultiprover = function() {
    connectToMultiproverServer('multiprover');
};

function connectToMultiproverServer(mode) {
    if (socket && socket.connected && currentGameMode === mode) return;
    if (socket && socket.connected) socket.disconnect();
    currentGameMode = mode;
    socket = io(BASE_URL, { auth: { token, provername } });
    socket.on('connect', () => {
        updateConnectionStatus('connected');
        if (mode === 'multiprover') {
            if (DOM.lobby.multiHostBtn) DOM.lobby.multiHostBtn.disabled = false;
            if (DOM.lobby.multiJoinBtn) DOM.lobby.multiJoinBtn.disabled = false;
        }
        if (mode === 'vs' && window.showLobbySubScreen) {
            window.showLobbySubScreen(DOM.lobby.proverList);
        } else if (mode === 'multiprover' && window.showMultiproverSubScreen) {
            window.showMultiproverSubScreen(DOM.lobby.waitingList);
        }
        socket.emit('get-rooms');
    });
    socket.on('disconnect', (reason) => {
        updateConnectionStatus('disconnected');
        gameActive = false;
        showMessageBox(`Disconnected: ${reason}`, 'error', 5000);
        const criticalReasons = ['io server disconnect', 'transport close', 'ping timeout', 'bad handshake'];
        setTimeout(() => {
            if (criticalReasons.includes(reason)) {
                localStorage.removeItem('nzkp-token');
                localStorage.removeItem('nzkp-provername');
                window.location.href = 'login.html';
            } else {
                window.location.href = 'mode.html';
            }
        }, 1000);
        currentRoomId = null;
        isHost = false;
        activeCells.clear();
        provedStyleIds.clear();
    });
    socket.on('error', (data) => {
        showMessageBox(`Server Error: ${data.message}`, 'error', 5000);
        setTimeout(() => {
            if (data.message.includes('Authentication error') || data.message.includes('Invalid token')) {
                localStorage.removeItem('nzkp-token');
                localStorage.removeItem('nzkp-provername');
                window.location.href = 'login.html';
            } else {
                window.location.href = 'mode.html';
            }
        }, 1000);
    });
    socket.on('room-created', handleRoomCreated);
    socket.on('room-joined', handleRoomJoined);
    socket.on('prover-joined', handleProverJoined);
    socket.on('prover-left', handleProverLeft);
    socket.on('prover-ready-update', handleProverReadyUpdate);
    socket.on('rooms-list', handleRoomsList);
    socket.on('rooms-updated', handleRoomsUpdated);
    socket.on('game-started', handleGameStarted);
    socket.on('game-state-update', handleGameStateUpdate);
    socket.on('proof-submitted', handleProofSubmitted);
    socket.on('game-ended', handleGameEnded);
}

window.emitCreateRoom = function(mode, timer, maxProvers) {
    if (!socket || !socket.connected) {
        showMessageBox('Not connected to server. Please wait or refresh.', 'error', 3000);
        return;
    }
    socket.emit('create-room', { mode, timer, maxProvers });
    showMessageBox('Creating room...', 'info', 1500);
};

window.emitJoinRoom = function(roomId) {
    if (!socket || !socket.connected) {
        showMessageBox('Not connected to server. Please wait or refresh.', 'error', 3000);
        return;
    }
    if (roomId) {
        socket.emit('join-room', { roomId });
        showMessageBox('Attempting to join room...', 'info', 1500);
    } else {
        showMessageBox('Please enter a room code.', 'error', 2000);
    }
};

window.emitLeaveRoom = function() {
    if (currentRoomId && socket && socket.connected) {
        socket.emit('leave-room', { roomId: currentRoomId });
        showMessageBox('Leaving room...', 'info', 1500);
    } else {
        window.location.href = 'mode.html';
    }
};

window.emitToggleReady = function(readyStatus) {
    if (currentRoomId && socket && socket.connected) {
        socket.emit('toggle-ready', { roomId: currentRoomId, ready: readyStatus });
        showMessageBox(`You are now ${readyStatus ? 'READY' : 'NOT READY'}.`, 'info', 1500);
    } else {
        showMessageBox('Cannot toggle ready, not in a room.', 'error', 2000);
    }
};

window.emitStartGame = function() {
    if (isHost && currentRoomId && socket && socket.connected) {
        socket.emit('start-game', { roomId: currentRoomId });
        showMessageBox('Starting game...', 'info', 1500);
    } else {
        showMessageBox('Only the host can start the game, or not in a room.', 'error', 3000);
    }
};

function handleRoomCreated(data) {
    currentRoomId = data.roomId;
    isHost = data.isHost;
    showMessageBox(`Room created! Code: ${data.roomId}`, 'success', 3000);
    if (currentGameMode === 'vs' && window.showLobbySubScreen) {
        window.showLobbySubScreen(DOM.lobby.hostControls);
        if (DOM.lobby.roomCode) DOM.lobby.roomCode.value = data.roomId;
        if (DOM.lobby.currentRoomCode) DOM.lobby.currentRoomCode.textContent = data.roomId;
        if (DOM.lobby.hostControls) DOM.lobby.hostControls.classList.remove('hidden');
        if (DOM.lobby.startVsGame) DOM.lobby.startVsGame.disabled = true;
        updateProverList(data.roomInfo.leaderboard || [], 'vs');
    } else if (currentGameMode === 'multiprover' && window.showMultiproverSubScreen) {
        window.showMultiproverSubScreen(DOM.lobby.multiHostControls);
        if (DOM.lobby.multiRoomCode) DOM.lobby.multiRoomCode.value = data.roomId;
        if (DOM.lobby.multiCurrentRoomCode) DOM.lobby.multiCurrentRoomCode.textContent = data.roomId;
        if (DOM.lobby.multiHostControls) DOM.lobby.multiHostControls.classList.remove('hidden');
        if (DOM.lobby.multiStartGame) DOM.lobby.multiStartGame.disabled = true;
        updateProverList(data.roomInfo.leaderboard || [], 'multiprover-waiting');
    }
}

function handleRoomJoined(data) {
    currentRoomId = data.roomId;
    isHost = data.isHost;
    showMessageBox(`Joined room: ${data.roomId}`, 'success', 3000);
    if (currentGameMode === 'vs' && window.showLobbySubScreen) {
        window.showLobbySubScreen(DOM.lobby.hostControls);
        if (DOM.lobby.currentRoomCode) DOM.lobby.currentRoomCode.textContent = data.roomId;
        if (DOM.lobby.hostControls) DOM.lobby.hostControls.classList.toggle('hidden', !isHost);
        if (DOM.lobby.startVsGame) DOM.lobby.startVsGame.disabled = true;
        updateProverList(data.roomInfo.leaderboard || [], 'vs');
    } else if (currentGameMode === 'multiprover' && window.showMultiproverSubScreen) {
        window.showMultiproverSubScreen(DOM.lobby.multiHostControls);
        if (DOM.lobby.multiCurrentRoomCode) DOM.lobby.multiCurrentRoomCode.textContent = data.roomId;
        if (DOM.lobby.multiHostControls) DOM.lobby.multiHostControls.classList.toggle('hidden', !isHost);
        if (DOM.lobby.multiStartGame) DOM.lobby.multiStartGame.disabled = true;
        updateProverList(data.roomInfo.leaderboard || [], 'multiprover-waiting');
    }
}

function handleProverJoined(data) {
    showMessageBox(`${data.provername} joined the room.`, 'info', 2000);
    if (currentGameMode === 'vs') {
        updateProverList(data.leaderboard || [], 'vs');
        if (isHost && DOM.lobby.startVsGame) {
            const readyProvers = data.leaderboard.filter(p => p.ready).length;
            DOM.lobby.startVsGame.disabled = !(readyProvers === 2 && data.leaderboard.length === 2);
        }
    } else if (currentGameMode === 'multiprover') {
        updateProverList(data.leaderboard || [], 'multiprover-waiting');
        if (isHost && DOM.lobby.multiStartGame) {
            DOM.lobby.multiStartGame.disabled = (data.proverCount < 3 || !data.allReady);
        }
    }
}

function handleProverLeft(data) {
    showMessageBox(`${data.provername} left the room.`, 'info', 2000);
    if (currentGameMode === 'vs') {
        updateProverList(data.leaderboard || [], 'vs');
        if (isHost && DOM.lobby.startVsGame) {
            const readyProvers = data.leaderboard.filter(p => p.ready).length;
            DOM.lobby.startVsGame.disabled = !(readyProvers === 2 && data.leaderboard.length === 2);
            if (data.proverCount < 2) {
                showMessageBox(`Opponent disconnected. Waiting for another prover...`, 'info', 3000);
            }
        } else if (data.proverCount === 0 && currentRoomId) {
            showMessageBox('Host left or opponent disconnected. Returning to lobby.', 'info', 3000);
            window.emitLeaveRoom();
        }
    } else if (currentGameMode === 'multiprover') {
        updateProverList(data.leaderboard || [], 'multiprover-waiting');
        if (isHost && DOM.lobby.multiStartGame) {
            DOM.lobby.multiStartGame.disabled = (data.proverCount < 3 || !data.allReady);
            if (data.proverCount === 0) {
                showMessageBox('All other provers left. Returning to lobby.', 'info', 3000);
                window.emitLeaveRoom();
            }
        } else if (data.proverCount === 0 && currentRoomId) {
            showMessageBox('Host left or room became empty. Returning to lobby.', 'info', 3000);
            window.emitLeaveRoom();
        }
    }
}

function handleProverReadyUpdate(data) {
    showMessageBox(`${data.provername} is ${data.ready ? 'ready' : 'not ready'}.`, 'info', 1500);
    if (currentGameMode === 'vs') {
        updateProverList(data.leaderboard || [], 'vs');
        if (isHost && DOM.lobby.startVsGame) {
            const readyProvers = data.leaderboard.filter(p => p.ready).length;
            DOM.lobby.startVsGame.disabled = !(readyProvers === 2 && data.leaderboard.length === 2);
        }
    } else if (currentGameMode === 'multiprover') {
        updateProverList(data.leaderboard || [], 'multiprover-waiting');
        if (isHost && DOM.lobby.multiStartGame) {
            DOM.lobby.multiStartGame.disabled = (data.leaderboard.length < 3 || !data.allReady);
        }
    }
}

function handleRoomsList(rooms) {
    // Placeholder for future lobby UI to display available rooms
}

function handleRoomsUpdated() {
    if (socket && socket.connected && (currentGameMode === 'vs' || currentGameMode === 'multiprover')) {
        socket.emit('get-rooms');
    }
}

function handleGameStarted(data) {
    showMessageBox('Game Started! Good luck!', 'success', 2500);
    gameActive = true;
    activeCells.clear();
    provedStyleIds.clear();
    if (currentGameMode === 'vs' && window.showScreen) {
        window.showScreen(DOM.vs.gameOver);
        if (DOM.vs.grid) buildGrid(DOM.vs.grid, 'vs-prover-own');
        if (DOM.vs.yourScore) DOM.vs.yourScore.textContent = '0';
        if (DOM.vs.opponentScore) DOM.vs.opponentScore.textContent = '0';
        if (DOM.vs.activeCount) DOM.vs.activeCount.textContent = '0';
        if (DOM.vs.stylePreview) buildStylePreview(DOM.vs.stylePreview, data.activeChallenges, provedStyleIds);
        if (data.initialLeaderboard) updateVsScoreboard(data.initialLeaderboard);
        if (DOM.vs.opponentStatus) DOM.vs.opponentStatus.textContent = 'Waiting for opponent\'s move...';
        if (DOM.vs.yourProvername) DOM.vs.yourProvername.textContent = provername;
        const opponentProver = data.initialLeaderboard.find(p => p.provername !== provername);
        if (DOM.vs.opponentProvername) DOM.vs.opponentProvername.textContent = opponentProver ? opponentProver.provername : '-';
    } else if (currentGameMode === 'multiprover' && window.showScreen) {
        window.showScreen(DOM.multi.gameOver);
        if (DOM.multi.grid) buildGrid(DOM.multi.grid, 'multiprover');
        if (DOM.multi.score) DOM.multi.score.textContent = '0';
        if (DOM.multi.proverCount) DOM.multi.proverCount.textContent = data.initialLeaderboard.length;
        if (DOM.multi.provername) DOM.multi.provername.textContent = provername;
        if (DOM.multi.activeCount) DOM.multi.activeCount.textContent = '0';
        if (DOM.multi.stylePreview) buildStylePreview(DOM.multi.stylePreview, data.activeChallenges, provedStyleIds);
        if (data.initialLeaderboard) updateMultiproverScoreboard(data.initialLeaderboard);
        if (DOM.multi.leader && data.initialLeaderboard.length > 0) DOM.multi.leader.textContent = data.initialLeaderboard[0].provername;
    }
}

function handleGameStateUpdate(data) {
    if (!gameActive) return;
    if (currentGameMode === 'vs') {
        if (DOM.vs.timer) DOM.vs.timer.textContent = data.timeRemaining;
        if (data.leaderboard) updateVsScoreboard(data.leaderboard);
        if (data.activeChallenges) buildStylePreview(DOM.vs.stylePreview, data.activeChallenges, provedStyleIds);
    } else if (currentGameMode === 'multiprover') {
        if (DOM.multi.timer) DOM.multi.timer.textContent = data.timeRemaining;
        if (DOM.multi.proverCount) DOM.multi.proverCount.textContent = data.leaderboard.length;
        if (data.leaderboard) updateMultiproverScoreboard(data.leaderboard);
        if (DOM.multi.stylePreview) buildStylePreview(DOM.multi.stylePreview, data.activeChallenges, provedStyleIds);
        if (DOM.multi.leader && data.leaderboard.length > 0) DOM.multi.leader.textContent = data.leaderboard[0].provername;
    }
}

function handleProofSubmitted(data) {
    if (data.isCorrect && data.provedStyleId) provedStyleIds.add(data.provedStyleId);
    const grid = currentGameMode === 'vs' ? DOM.vs.grid : DOM.multi.grid;
    const activeCount = currentGameMode === 'vs' ? DOM.vs.activeCount : DOM.multi.activeCount;
    if (grid && data.provername === provername) {
        const flashNodes = data.selectedNodes.map(index => grid.querySelector(`.node[data-index="${index}"]`));
        flashNodes.forEach(node => {
            if (node) node.classList.add(data.isCorrect ? 'proof-success' : 'proof-fail');
        });
        setTimeout(() => {
            flashNodes.forEach(node => {
                if (node) node.classList.remove('proof-success', 'proof-fail');
            });
            clearGridAndActive(currentGameMode === 'vs' ? 'vs-prover-own' : 'multiprover');
        }, 200);
        if (activeCount) activeCount.innerText = '0';
    }
    if (currentGameMode === 'vs' && DOM.vs.opponentStatus) {
        if (data.provername === provername) {
            showMessageBox(data.message, data.isCorrect ? 'success' : 'error');
        } else {
            DOM.vs.opponentStatus.textContent = `${data.provername} proved ${data.isCorrect ? 'correctly!' : 'incorrectly!'}`;
            setTimeout(() => {
                if (DOM.vs.opponentStatus) DOM.vs.opponentStatus.textContent = 'Waiting for opponent\'s move...';
            }, 2000);
        }
    } else if (currentGameMode === 'multiprover' && data.provername === provername) {
        showMessageBox(data.message, data.isCorrect ? 'success' : 'error');
    }
}

async function handleGameEnded(data) {
    showMessageBox('Game Over!', 'info', 3000);
    gameActive = false;
    clearGridAndActive(currentGameMode === 'vs' ? 'vs-prover-own' : 'multiprover');
    activeCells.clear();
    provedStyleIds.clear();
    const yourResult = data.results.find(p => p.provername === provername);
    if (yourResult && yourResult.score > athScore) {
        athScore = yourResult.score;
        if (DOM.single.athScore) DOM.single.athScore.innerText = athScore;
        showMessageBox(`New All-Time High Score: ${athScore}!`, 'success', 3000);
    } else if (yourResult) {
        showMessageBox(`Your score: ${yourResult.score}.`, 'info', 3000);
    }
    if (currentGameMode === 'vs' && window.showScreen && DOM.vs.gameOver) {
        window.showScreen(DOM.vs.gameOver);
        if (DOM.vs.finalResults) {
            let html = '<h3>Final Scores:</h3>';
            data.results.sort((a, b) => b.score - a.score).forEach(prover => {
                const isWinner = data.results.length > 0 && data.results[0].score === prover.score && prover.score > 0;
                html += `
                    <div class="final-score-item">
                        <span class="final-name">${prover.provername}</span>
                        <span class="final-score">${prover.score} ${isWinner ? '🏆' : ''}</span>
                    </div>`;
            });
            DOM.vs.finalResults.innerHTML = html;
        }
    } else if (currentGameMode === 'multiprover' && window.showScreen && DOM.multi.gameOver) {
        window.showScreen(DOM.multi.gameOver);
        if (DOM.multi.finalResults) {
            let html = '<h3>Final Scores:</h3>';
            data.results.sort((a, b) => b.score - a.score).forEach(prover => {
                const isWinner = data.results.length > 0 && data.results[0].score === prover.score && prover.score > 0;
                html += `
                    <div class="final-score-item">
                        <span class="final-name">${prover.provername}</span>
                        <span class="final-score">${prover.score} ${isWinner ? '🏆' : ''}</span>
                    </div>`;
            });
            DOM.multi.finalResults.innerHTML = html;
        }
    }
}

function updateProverList(provers, type) {
    const actualProvers = provers || [];
    let targetListDiv, proverCountSpan, setReadyBtn, readyStatusSpan;
    if (type === 'vs') {
        targetListDiv = DOM.lobby.proverList;
        proverCountSpan = DOM.lobby.proverCount;
        setReadyBtn = DOM.lobby.setReadyBtn;
        readyStatusSpan = DOM.lobby.readyStatus;
    } else if (type === 'multiprover-waiting') {
        targetListDiv = DOM.lobby.waitingList;
        proverCountSpan = DOM.lobby.waitingCount;
        setReadyBtn = DOM.lobby.multiSetReadyBtn;
        readyStatusSpan = DOM.lobby.multiReadyStatus;
    }
    if (!targetListDiv || !proverCountSpan) return;
    proverCountSpan.textContent = actualProvers.length;
    targetListDiv.innerHTML = '';
    let allProversReady = true;
    let yourReadyStatus = false;
    actualProvers.forEach(prover => {
        const proverItem = document.createElement('div');
        proverItem.classList.add('prover-item');
        if (prover.provername === provername) {
            proverItem.classList.add('current-prover');
            yourReadyStatus = prover.ready;
        }
        proverItem.innerHTML = `
            <span class="provername">${prover.provername} ${prover.provername === provername ? '(You)' : ''}</span>
            <span class="ready-status ${prover.ready ? 'ready' : ''}">${prover.ready ? 'Ready' : 'Not Ready'}</span>
        `;
        targetListDiv.appendChild(proverItem);
        if (!prover.ready) allProversReady = false;
    });
    if (setReadyBtn) {
        setReadyBtn.dataset.ready = String(yourReadyStatus);
        setReadyBtn.textContent = yourReadyStatus ? 'Unready' : 'Ready';
    }
    if (readyStatusSpan) readyStatusSpan.textContent = yourReadyStatus ? 'READY' : 'NOT READY';
    if (isHost) {
        if (type === 'vs' && DOM.lobby.startVsGame) {
            DOM.lobby.startVsGame.disabled = !(actualProvers.length === 2 && allProversReady);
        } else if (type === 'multiprover-waiting' && DOM.lobby.multiStartGame) {
            DOM.lobby.multiStartGame.disabled = (actualProvers.length < 3 || !allProversReady);
        }
    }
}

function updateVsScoreboard(leaderboard) {
    const yourProverState = leaderboard.find(p => p.provername === provername);
    if (yourProverState && DOM.vs.yourScore) DOM.vs.yourScore.textContent = yourProverState.score;
    const opponentProverState = leaderboard.find(p => p.provername !== provername);
    if (opponentProverState && DOM.vs.opponentScore) {
        DOM.vs.opponentScore.textContent = opponentProverState.score;
    } else if (DOM.vs.opponentScore) {
        DOM.vs.opponentScore.textContent = '0';
    }
    if (DOM.vs.opponentProvername) {
        DOM.vs.opponentProvername.textContent = opponentProverState ? opponentProverState.provername : '-';
    }
}

function updateMultiproverScoreboard(leaderboard) {
    if (!DOM.multi.proverList) return;
    const sortedScores = [...leaderboard].sort((a, b) => b.score - a.score);
    DOM.multi.proverList.innerHTML = sortedScores.map((prover, index) => {
        const rankEmoji = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '';
        const isCurrentProver = prover.provername === provername;
        return `
            <div class="prover-score-item ${isCurrentProver ? 'current-prover' : ''}">
                <span class="prover-name">${rankEmoji} ${prover.provername} ${isCurrentProver ? '(You)' : ''}</span>
                <span class="prover-score">${prover.score}</span>
            </div>
        `;
    }).join('');
    const yourProverState = leaderboard.find(p => p.provername === provername);
    if (yourProverState && DOM.multi.score) DOM.multi.score.textContent = yourProverState.score;
    if (DOM.multi.leader && sortedScores.length > 0) {
        DOM.multi.leader.textContent = sortedScores[0].provername;
    } else if (DOM.multi.leader) {
        DOM.multi.leader.textContent = '-';
    }
}