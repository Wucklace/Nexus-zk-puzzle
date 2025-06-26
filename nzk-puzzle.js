// --- Global Constants and Variables for Style Refresh (confirm these are at the top of nzk-puzzle.js) ---
const SINGLE_PROVER_PREVIEW_REFRESH_RATE_MS = 10 * 1000; // 10 seconds for full style refresh
const SINGLE_PROVER_NUM_STYLES_TO_DISPLAY = 4; // // The number of styles to show initially and on full refresh

let singleProverStyleRefreshInterval = null; // To hold the setInterval ID

// This will be used to dynamically set the base URL for API calls
const BASE_URL = window.location.origin; // This will dynamically get your app's URL on Render.com

function showMessageBox(message, type = 'info', duration = 3000) {
    let msgBox = document.getElementById('custom-message-box');
    if (!msgBox) {
        msgBox = document.createElement('div');
        msgBox.id = 'custom-message-box';
        document.body.appendChild(msgBox);
    }

    msgBox.className = 'custom-message-box'; // Reset classes
    msgBox.textContent = message;

    // Add type-specific classes for styling (e.g., green for success, red for error)
    if (type === 'success') {
        msgBox.classList.add('success');
    } else if (type === 'error') {
        msgBox.classList.add('error');
    } else {
        msgBox.classList.add('info');
    }

    msgBox.classList.add('show'); // Show the message box

    setTimeout(() => {
        msgBox.classList.remove('show'); // Hide after duration
    }, duration);
}

// === DOM Element References ===
// Elements for index.html (Single Prover)
const singleGrid = document.getElementById('grid');
const singleStylePreviewContainer = document.getElementById('styles-preview');
const singleActiveCountEl = document.getElementById('active-count');
const singleSuccessEl = document.getElementById('success');
const singleFailEl = document.getElementById('fail');
const singleScoreEl = document.getElementById('score');
const singleTimerEl = document.getElementById('timer');
const singleAthScoreEl = document = document.getElementById('ath-score'); // Corrected typo here
const singleStartBtn = document.getElementById('start-btn');
const singleEndBtn = document.getElementById('end-btn');
const singleLeaderboardDiv = document.getElementById('leaderboard');
const singleFinalResultsDisplay = document.getElementById('single-final-results-display');
const singleProverScreen = document.getElementById('single-prover-screen');
const gameOverScreenSingle = document.getElementById('game-over-screen-single');

// Elements for versus.html (VS Mode)
const vsYourGridDiv = document.getElementById('vs-your-grid');
const vsActiveStylesPreviewDiv = document.getElementById('vs-active-styles-preview');
const vsYourActiveCountSpan = document.getElementById('vs-your-active-count');
const vsYourScoreSpan = document.getElementById('vs-your-score');
const vsOpponentScoreSpan = document.getElementById('vs-opponent-score');
const vsOpponentStatusDiv = document.getElementById('vs-opponent-status');
const vsOpponentProvernameSpan = document.getElementById('vs-opponent-provername');
const vsYourProvernameSpan = document.getElementById('vs-your-provername');


// Elements for multi.html (Multiprover Mode)
const multiGridDiv = document.getElementById('multi-grid');
const multiStylesPreviewDiv = document.getElementById('multi-styles-preview');
const multiProvernameSpan = document.getElementById('multi-provername');
const multiTimerSpan = document.getElementById('multi-timer');
const multiScoreSpan = document.getElementById('multi-score');
const multiProverCountSpan = document.getElementById('multi-prover-count');
const multiLeaderSpan = document.getElementById('multi-leader');
const multiProverListDiv = document.getElementById('multi-prover-list');
const multiActiveCountSpan = document.getElementById('multi-active-count');


// === Global Game State Variables ===
let currentGameMode = null; // 'single', 'vs', 'multiprover'
let socket = null; // WebSocket connection for multiprover (now truly global)
let currentRoomId = null; // Current room ID for multiprover games
let isHost = false; // Is the current prover the host of a room?

// Single Prover State
let successCount = 0;
let failCount = 0;
let athScore = 0;
let timerDuration = 90; // Default 90 seconds (1.5 minutes)
let timeLeft = timerDuration;
let timerInterval = null;
let gameActive = false;
let currentSingleProverScore = 0; // Separate score for single prover
let currentSingleProverStyles = []; // Stores the styles currently active for the single prover game

// Uniform 10x10 grid system for all devices
// Simple and consistent across all screen sizes
// Multiprover/VS State (managed by server, client reflects it)
let activeCells = new Set(); // Stores indices of currently active (selected) cells on the local grid
const gridSize = 10; // Consistent grid size for all modes (10x10)

// Set to keep track of proved style IDs for visual feedback in previews
const provedStyleIds = new Set();


// === Authentication Check and Redirection ===
const token = localStorage.getItem('nzkp-token');
const provername = localStorage.getItem('nzkp-provername');

// This logic runs as soon as nzk-puzzle.js is loaded on ANY page.
document.addEventListener('DOMContentLoaded', () => {
    const currentPage = window.location.pathname.split('/').pop();
    console.log(`[nzk-puzzle.js][DOMContentLoaded] on page: ${currentPage}`);

    // Set up logout buttons (apply this to all relevant HTML elements)
    document.querySelectorAll('[id*="logout-btn"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            console.log('[nzk-puzzle.js][Logout] button clicked.');
            try {
                await fetch('${BASE_URL}/api/logout', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
            } catch (error) {
                console.error('[nzk-puzzle.js][Logout] API call failed:', error);
                showMessageBox('Logout failed due to network error.', 'error');
            } finally {
                localStorage.removeItem('nzkp-token');
                localStorage.removeItem('nzkp-provername');
                console.log('[nzk-puzzle.js][Logout] Token cleared, redirecting to login.html.');
                window.location.href = 'login.html';
            }
        });
    });

    if (!token || !provername) {
        console.log('[nzk-puzzle.js][Auth] No token or provername found in localStorage.');
        if (currentPage !== 'login.html') {
            console.log('[nzk-puzzle.js][Auth] Redirecting to login.html due to missing token.');
            redirectToLogin();
        } else {
            console.log('[nzk-puzzle.js][Auth] On login.html, allowing prover to login/register.');
        }
    } else {
        console.log(`[nzk-puzzle.js][Auth] Token and provername found. Verifying for prover: ${provername}`);
        verifyAuthentication(currentPage);
    }

    // Initialize specific game mode if on its page
    if (currentPage === 'index.html') {
        currentGameMode = 'single';
        initializeSingleProverGame();
    } else if (currentPage === 'versus.html') {
        currentGameMode = 'vs';
        window.connectSocketForVSMode();
    } else if (currentPage === 'multi.html') {
        currentGameMode = 'multiprover';
        window.connectSocketForMultiprover();
    } else if (currentPage === 'mode.html') {
        const modeSelectionScreen = document.getElementById('mode-selection');
        if (modeSelectionScreen && window.showScreen) {
            window.showScreen(modeSelectionScreen);
        }
    }
});


function redirectToLogin() {
    localStorage.removeItem('nzkp-token');
    localStorage.removeItem('nzkp-provername');
    window.location.href = 'login.html';
}

async function verifyAuthentication(currentPage) {
    console.log(`[nzk-puzzle.js][Auth] Attempting to verify authentication for ${provername}.`);
    try {
        const response = await fetch(`${BASE_URL}/api/verify`, { // Corrected: Using BASE_URL variable
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[nzk-puzzle.js][Auth] API Verify failed with HTTP status ${response.status}: ${errorText}`);
            console.warn(`[nzk-puzzle.js][Auth] Redirecting to login.html because API Verify returned non-OK HTTP status.`);
            showMessageBox(`Authentication failed (${response.status}). Redirecting to login.`, 'error');
            redirectToLogin();
            return;
        }

        const data = await response.json();
        console.log(`[nzk-puzzle.js][Auth] API Verify response data:`, data);

        if (data.success) {
            console.log(`[nzk-puzzle.js][Auth] Authentication successful for ${data.provername}.`);
            // Update all prover name displays
            const proverNameElements = document.querySelectorAll('[id*="prover-name"], #current-prover, #multi-provername, #vs-your-provername');
            proverNameElements.forEach(el => {
                if (el) el.innerText = data.provername;
            });

            // Only fetch ATH score if on a page that displays it (e.g., index.html)
            if (singleAthScoreEl) {
                fetchAthScore(data.provername);
            }

            if (currentPage === 'login.html') {
                console.log('[nzk-puzzle.js][Auth] Verified on login.html, redirecting to mode.html for game mode selection.');
                window.location.href = 'mode.html';
            } else {
                console.log(`[nzk-puzzle.js][Auth] Authentication successful on ${currentPage}. Remaining on this page.`);
            }
        } else {
            console.warn(`[nzk-puzzle.js][Auth] Authentication verification failed: ${data.error || 'Unknown reason'}.`);
            console.warn(`[nzk-puzzle.js][Auth] Redirecting to login.html because API Verify returned success: false.`);
            showMessageBox(`Authentication failed: ${data.error}. Redirecting to login.`, 'error');
            redirectToLogin();
        }
    } catch (error) {
        console.error('[nzk-puzzle.js][Auth] Network or unexpected error during authentication verification:', error);
        console.warn(`[nzk-puzzle.js][Auth] Redirecting to login.html due to network or unexpected error during verification.`);
        showMessageBox('Network error during authentication. Redirecting to login.', 'error');
        redirectToLogin();
    }
}

// Global function to fetch and display ATH score
async function fetchAthScore(provername) {
    if (!provername) return;
    try {
const response = await fetch(`${BASE_URL}/api/prover/${provername}`, { // Corrected: Using BASE_URL variable
    headers: { 'Authorization': `Bearer ${token}` }
});
        const data = await response.json();
        if (data.success) {
            athScore = data.athScore || 0;
            if (singleAthScoreEl) singleAthScoreEl.innerText = athScore;
            console.log(`[nzk-puzzle.js][ATH] Fetched ATH score for ${provername}: ${athScore}`);
        } else {
            console.error('[nzk-puzzle.js][ATH] Failed to fetch ATH score:', data.error);
            if (singleAthScoreEl) singleAthScoreEl.innerText = 'N/A';
            showMessageBox('Failed to fetch ATH score.', 'error');
        }
    } catch (error) {
        console.error('[nzk-puzzle.js][ATH] Network error fetching ATH score:', error);
        if (singleAthScoreEl) singleAthScoreEl.innerText = 'Error';
        showMessageBox('Network error fetching ATH score.', 'error');
    }
}

// Global function to save score (primarily for single prover)
async function saveScore(score) {
    try {
        const response = await fetch(`${BASE_URL}/api/submit-score`, { // Corrected: Using BASE_URL variable
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`   // Ensure token is sent for authentication
            },
            body: JSON.stringify({ provername, score }) // Ensure correct data is sent
        });
        const data = await response.json();
        if (data.success) {
            console.log('[nzk-puzzle.js][Score] score submitted successfully:', data.message);
            if (data.message.includes('New ATH')) {
                showMessageBox('New All-Time High Score! 🎉', 'success');
            } else {
                showMessageBox('Score submitted.', 'info');
            }
        } else {
            console.error('[nzk-puzzle.js][Score] Failed to submit score:', data.error);
            showMessageBox('Failed to submit score.', 'error');
        }
    } catch (error) {
        console.error('[nzk-puzzle.js][Score] Network error submitting score:', error);
        showMessageBox('Network error submitting score.', 'error');
    }
}

// Global function to update leaderboard display
async function updateLeaderboard() {
    if (!singleLeaderboardDiv) return;

    try {
        const response = await fetch(`${BASE_URL}/api/leaderboard`); // Corrected: Using BASE_URL variable
        const data = await response.json();

        if (data.success) {
            let html = `
                <table class="leaderboard-table">
                    <thead>
                        <tr>
                            <th>Rank</th>
                            <th>Prover</th>
                            <th>ATH Score</th>
                        </tr>
                    </thead>
                    <tbody>
            `;
            data.leaderboard.forEach((entry, index) => {
                const rank = index + 1;
                let rankClass = '';
                let trophy = '';
                if (rank === 1) { rankClass = 'gold'; trophy = '🏆'; }
                else if (rank === 2) { rankClass = 'silver'; trophy = '🥈'; }
                else if (rank === 3) { rankClass = 'bronze'; trophy = '🥉'; }

                html += `
                    <tr>
                        <td class="rank ${rankClass}"><span class="trophy">${trophy}</span>${rank}</td>
                        <td class="prover-name">${entry.provername}</td>
                        <td class="score">${entry.athScore}</td>
                    </tr>
                `;
            });
            html += `
                    </tbody>
                </table>
            `;
            singleLeaderboardDiv.innerHTML = html;
        } else {
            console.error('[nzk-puzzle.js][Leaderboard] Failed to fetch leaderboard:', data.error);
            singleLeaderboardDiv.innerHTML = '<p>Failed to load leaderboard.</p>';
        }
    } catch (error) {
        console.error('[nzk-puzzle.js][Leaderboard] Network error fetching leaderboard:', error);
        singleLeaderboardDiv.innerHTML = '<p>Network error: Could not load leaderboard.</p>';
    }
}

// Global function to update connection status UI
function updateConnectionStatus(status) {
    const statusDiv = document.getElementById('connection-status');
    const indicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');

    if (!statusDiv || !indicator || !statusText) return;

    if (status === 'connected') {
        indicator.textContent = '🟢';
        statusText.textContent = 'Connected';
        statusDiv.classList.add('connected');
        statusDiv.classList.remove('disconnected', 'hidden');
    } else {
        indicator.textContent = '🔴';
        statusText.textContent = 'Disconnected';
        statusDiv.classList.add('disconnected');
        statusDiv.classList.remove('connected', 'hidden');
    }
    // Fade out after a short while if connected, stay if disconnected
    if (status === 'connected') {
        setTimeout(() => {
            statusDiv.classList.add('hidden');
        }, 3000);
    }
}


// === Hardcoded Styles (for client-side reference, should match server's logic) ===
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
]

/**
 * Generates random styles for client-side use (e.g., Single Prover mode).
 * In Multiprover/VS, styles are generated and sent by the server.
 * @param {number} count - The number of styles to generate.
 * @returns {Array<Object>} An array of style objects.
 */
function generateRandomStylesForClient(count) {
    const styles = [];
    const possiblePatterns = [...styleShapes];

    for (let i = 0; i < count; i++) {
        if (possiblePatterns.length === 0) {
            console.warn("[generateRandomStylesForClient] Not enough unique patterns to generate the requested count. Re-using patterns.");
            possiblePatterns.push(...styleShapes);
            if (possiblePatterns.length === 0) break;
        }
        const randomIndex = Math.floor(Math.random() * possiblePatterns.length);
        const selectedPattern = { ...possiblePatterns.splice(randomIndex, 1)[0] };

        selectedPattern.id = `${selectedPattern.id}_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 8)}`;
        styles.push(selectedPattern);
    }
    return styles;
}


/**
 * Checks if a selected set of nodes matches a given pattern.
 * @param {Array<number>} selectedNodeIndices - Array of flat indices of selected nodes.
 * @param {Array<Array<number>>} patternCoords - Array of [row, col] relative coordinates for the pattern.
 * @param {number} localGridSize - The number of rows/columns in the square grid.
 * @returns {boolean} True if the pattern matches, false otherwise.
 */
function checkPattern(selectedNodeIndices, patternCoords, localGridSize = gridSize) {
    if (selectedNodeIndices.length !== patternCoords.length) {
        return false;
    }

    if (selectedNodeIndices.length === 0) return false;

    const selectedRelativeCoords = selectedNodeIndices.map(index => [
        Math.floor(index / localGridSize),
        index % localGridSize
    ]);

    const minRow = Math.min(...selectedRelativeCoords.map(c => c[0]));
    const minCol = Math.min(...selectedRelativeCoords.map(c => c[1]));

    const normalizedSelected = selectedRelativeCoords.map(c => [c[0] - minRow, c[1] - minCol])
                                                     .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    const normalizedPattern = [...patternCoords].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    for (let i = 0; i < normalizedPattern.length; i++) {
        if (normalizedSelected[i][0] !== normalizedPattern[i][0] || normalizedSelected[i][1] !== normalizedPattern[i][1]) {
            return false;
        }
    }
    return true;
}

/**
 * Builds the interactive puzzle grid for a given container.
 * @param {HTMLElement} gridContainer - The DOM element to build the grid inside.
 * @param {string} mode - 'single', 'vs-prover-own', 'multiprover' (determines click behavior).
 */
function buildGrid(gridContainer, mode) {
    if (!gridContainer) {
        console.error(`[buildGrid] Grid container not found for mode: ${mode}`);
        return;
    }
      
    // Always set to 10x10
    gridContainer.style.setProperty('--grid-cols', gridSize);
    gridContainer.style.setProperty('--grid-rows', gridSize);

    gridContainer.innerHTML = '';
    activeCells.clear();

    for (let i = 0; i < gridSize * gridSize; i++) {
        const node = document.createElement('div');
        node.classList.add('node');
        node.dataset.index = i;

        if (mode === 'single' || mode === 'vs-prover-own' || mode === 'multiprover') {
            node.addEventListener('click', () => toggleCell(node, i, mode));
        }

        gridContainer.appendChild(node);
    }
    console.log(`[buildGrid] Grid built for mode: ${mode} in container: ${gridContainer.id}`);
}

/**
 * Toggles the 'active' state of a cell and updates the global activeCells set.
 * Automatically attempts to prove a style if a pattern is formed.
 * @param {HTMLElement} nodeElement - The clicked grid node element.
 * @param {number} index - The flat index of the node.
 * @param {string} mode - The current game mode.
 */
function toggleCell(nodeElement, index, mode) {
    if (!gameActive) {
        showMessageBox('Game not active. Press Start Game or wait for host.', 'info', 2000);
        return;
    }

    if (nodeElement.classList.contains('active')) {
        activeCells.delete(index);
        nodeElement.classList.remove('active');
    } else {
        if (activeCells.size >= 6) { // Max 6 cells to prevent excessively large selections for single patterns
            showMessageBox("Maximum 6 cells can be selected for a pattern.", 'info', 1500);
            return;
        }
        activeCells.add(index);
        nodeElement.classList.add('active');
    }

    const selectedCount = activeCells.size;
    if (mode === 'single' && singleActiveCountEl) {
        singleActiveCountEl.innerText = selectedCount;
    } else if (mode === 'vs-prover-own' && vsYourActiveCountSpan) {
        vsYourActiveCountSpan.innerText = selectedCount;
    } else if (mode === 'multiprover' && multiActiveCountSpan) {
        multiActiveCountSpan.innerText = selectedCount;
    }


    if (selectedCount >= 4) { // Minimum 4 nodes for any pattern in styleShapes (Line)
        const selectedNodeIndices = Array.from(activeCells);

        if (mode === 'single') {
            let proved = false;
            let provedStyle = null;

            for (const style of currentSingleProverStyles) {
                if (checkPattern(selectedNodeIndices, style.pattern, gridSize)) {
                    proved = true;
                    provedStyle = style;
                    console.log(`[Single Prover] Matched style: ${style.name}`);
                    break;
                }
            }

            const currentGridNodes = singleGrid.querySelectorAll('.node');
            const activeNodeElements = selectedNodeIndices.map(idx => currentGridNodes[idx]);

            if (proved) {
                successCount++;
                currentSingleProverScore += 10; // +10 points for successful proof
                timeLeft += 5; // Add 5 seconds to timer for successful prove (Single Prover only)
                if (singleTimerEl) singleTimerEl.innerText = timeLeft; // Update timer display
                showMessageBox('✅Proof Successful +10 score. +5 seconds!', 'success');

                // Visual feedback for success
                activeNodeElements.forEach(node => node.classList.add('proof-success'));

                // Remove the proved style and add a new one
                currentSingleProverStyles = currentSingleProverStyles.filter(s => s.id !== provedStyle.id);
                /**const newStyle = generateRandomStylesForClient(1)[0];  The lines to generate and add a newStyle are REMOVED here
                if (newStyle) {
                    currentSingleProverStyles.push(newStyle);   because proved styles should be subtracted, not replaced immediately.
                } else {
                    console.warn("[Single Prover] Could not generate a new style. Running out of unique styles?");
                }**/

                buildStylePreview(singleStylePreviewContainer, currentSingleProverStyles);
                console.log(`[Single Prover] Score: ${currentSingleProverScore}`);

            } else {
                failCount++;
                // currentSingleProverScore = Math.max(0, currentSingleProverScore - 5); // REMOVED: No penalty for single prover fail
                showMessageBox('❌Fail Proof', 'error'); // Message updated, no score deduction mentioned

                // Visual feedback for failure
                activeNodeElements.forEach(node => node.classList.add('proof-fail'));
                console.log(`[Single Prover] Score: ${currentSingleProverScore}`);
            }

            // Clear selection and remove visual feedback after a short delay
            setTimeout(() => {
                activeNodeElements.forEach(node => node.classList.remove('active', 'proof-success', 'proof-fail'));
                activeCells.clear();
                if (singleActiveCountEl) singleActiveCountEl.innerText = 0;
            }, 200);

            // Update score and counts in UI
            if (singleSuccessEl) singleSuccessEl.innerText = successCount;
            if (singleFailEl) singleFailEl.innerText = failCount;
            if (singleScoreEl) singleScoreEl.innerText = currentSingleProverScore;

        } else if (mode === 'vs-prover-own' || mode === 'multiprover') {
            // For multiplayer modes, attempt to submit proof to server
            // The server will validate and send back game-state-update / proof-submitted events
            if (socket && socket.connected && currentRoomId) {
                // Client-side check for a match *before* sending to server to reduce unnecessary network traffic
                let clientProved = false;
                for (const style of styleShapes) { // Check against base styleShapes for client-side validation
                    if (checkPattern(selectedNodeIndices, style.pattern, gridSize)) {
                        clientProved = true;
                        break;
                    }
                }

                if (clientProved) {
                    // This will trigger the server-side validation and scoring
                    console.log(`[${mode}] Emitting submit-proof to server:`, selectedNodeIndices);
                    socket.emit('submit-proof', { roomId: currentRoomId, selectedNodes: selectedNodeIndices });
                    // Clear local selection immediately after emitting, feedback handled by server response
                    const currentGrid = (mode === 'vs-prover-own') ? vsYourGridDiv : multiGridDiv;
                    selectedNodeIndices.forEach(idx => {
                        const node = currentGrid.querySelector(`.node[data-index="${idx}"]`);
                        if (node) node.classList.remove('active');
                    });
                    activeCells.clear();
                    // Update active count display
                    if (mode === 'vs-prover-own' && vsYourActiveCountSpan) {
                        vsYourActiveCountSpan.innerText = 0;
                    } else if (mode === 'multiprover' && multiActiveCountSpan) {
                        multiActiveCountSpan.innerText = 0;
                    }

                } else {
                    showMessageBox('No matching pattern found with current selection. Try again.', 'info', 2000);
                    // Provide temporary visual feedback for client-side failure (then clear)
                    const currentGrid = (mode === 'vs-prover-own') ? vsYourGridDiv : multiGridDiv;
                    const activeNodeElements = selectedNodeIndices.map(idx => currentGrid.querySelector(`.node[data-index="${idx}"]`));
                    if (activeNodeElements.length > 0) {
                        activeNodeElements.forEach(node => {
                            if (node) node.classList.add('proof-fail');
                        });
                        setTimeout(() => {
                            activeNodeElements.forEach(node => {
                                if (node) node.classList.remove('active', 'proof-fail');
                            });
                            activeCells.clear(); // Clear local selection after feedback
                            // Reset active count display in current mode
                            if (mode === 'vs-prover-own' && vsYourActiveCountSpan) {
                                vsYourActiveCountSpan.innerText = 0;
                            } else if (mode === 'multiprover' && multiActiveCountSpan) {
                                multiActiveCountSpan.innerText = 0;
                            }
                        }, 200);
                    }
                }
            } else {
                console.warn(`[${mode}] Not connected to socket or no room ID. Cannot submit proof.`);
                showMessageBox('Not connected to game. Cannot submit proof.', 'error', 3000);
            }
        }
    }
}

/**
 * Builds and updates the style preview container.
 * @param {HTMLElement} container - The DOM element to build previews inside.
 * @param {Array<Object>} styles - An array of style objects ({ id, name, pattern }).
 * @param {Set<string>} [provedStyleIdsSet=new Set()] - Set of IDs of styles that have been proved (for visual fading).
 */
function buildStylePreview(container, styles, provedStyleIdsSet = new Set()) {
    if (!container) return;
    container.innerHTML = ''; // Clear previous previews

    styles.forEach(style => {
        const previewWrapper = document.createElement('div');
        previewWrapper.className = 'style-preview-wrapper';
        if (provedStyleIdsSet.has(style.id)) {
            previewWrapper.classList.add('proved-style');
        }

        const preview = document.createElement('div');
        preview.className = 'style-shape';

        const previewGridSize = 4; // Consistent 4x4 grid for all previews
        preview.style.gridTemplateColumns = `repeat(${previewGridSize}, 10px)`;
        preview.style.gridAutoRows = `10px`;

        for (let r = 0; r < previewGridSize; r++) {
            for (let c = 0; c < previewGridSize; c++) {
                const cell = document.createElement('div');
                cell.classList.add('style-node');
                const isActive = style.pattern.some(([pr, pc]) => pr === r && pc === c);
                if (isActive) {
                    cell.classList.add('active');
                }
                preview.appendChild(cell);
            }
        }

        const styleName = document.createElement('span');
        styleName.className = 'style-name';
        styleName.textContent = style.name;

        previewWrapper.appendChild(preview);
        previewWrapper.appendChild(styleName);

        container.appendChild(previewWrapper);
    });
    console.log(`[buildStylePreview] Styles preview built for container: ${container.id}, styles count: ${styles.length}`);
}


// === Game Mode Selection Functions (Exposed Globally) ===
window.selectMode = function(mode) {
    currentGameMode = mode;
    console.log(`[nzk-puzzle.js][ModeSelection] Mode selected: ${mode}`);

    // Call the appropriate screen display function from the respective HTML
    if (mode === 'single') {
        if (window.showScreen && singleProverScreen) {
            window.showScreen(singleProverScreen);
            initializeSingleProverGame();
        } else {
            window.location.href = 'index.html';
        }
    } else if (mode === 'vs') {
        if (window.showScreen && document.getElementById('lobby-screen')) {
            window.showScreen(document.getElementById('lobby-screen'));
            window.showLobbySubScreen(document.getElementById('lobby-options'));
            window.connectSocketForVSMode(); // Connect socket for VS mode
        } else {
            window.location.href = 'versus.html';
        }
    } else if (mode === 'multiprover') {
        if (window.showScreen && document.getElementById('multiprover-lobby-screen')) {
            window.showScreen(document.getElementById('multiprover-lobby-screen'));
            window.showMultiproverSubScreen(document.getElementById('multi-lobby-options'));
            window.connectSocketForMultiprover(); // Connect socket for Multiprover mode
        } else {
            window.location.href = 'multi.html';
        }
    }
};

window.backToModes = function() {
    console.log('[nzk-puzzle.js][Navigation] Returning to mode selection.');
    // Disconnect socket if connected for VS/Multiprover
    if (socket && socket.connected) {
        if (currentRoomId) {
            console.log(`[nzk-puzzle.js][Socket] Emitting 'leave-room' for room: ${currentRoomId}`);
            socket.emit('leave-room', { roomId: currentRoomId });
        }
        socket.disconnect();
        socket = null;
        console.log('[nzk-puzzle.js][Socket] Socket disconnected.');
    }
    currentRoomId = null;
    isHost = false;
    gameActive = false; // Ensure gameActive is reset
    activeCells.clear(); // Clear any active selection
    provedStyleIds.clear(); // Clear proved styles set
    currentSingleProverStyles = []; // Clear single prover styles

    // Always redirect to mode.html to ensure clean state
    window.location.href = 'mode.html';
};


// === Single Prover Mode Functions ===
function initializeSingleProverGame() {
    if (!singleGrid) {
        console.error("Single prover grid element not found. Cannot initialize single prover game.");
        return;
    }

    buildGrid(singleGrid, 'single');

    //currentSingleProverStyles = generateRandomStylesForClient(5); // 5 styles for single prover
    //buildStylePreview(singleStylePreviewContainer, currentSingleProverStyles);

    resetSingleProverGame();
    console.log('[nzk-puzzle.js][SingleProver] Game Initialized.');
}

function resetSingleProverGame() {
    successCount = 0;
    failCount = 0;
    currentSingleProverScore = 0;
    gameActive = false;
    activeCells.clear();
    provedStyleIds.clear(); // Clear proved styles for the next game

    if (singleSuccessEl) singleSuccessEl.innerText = successCount;
    if (singleFailEl) singleFailEl.innerText = failCount;
    if (singleScoreEl) singleScoreEl.innerText = currentSingleProverScore;
    if (singleActiveCountEl) singleActiveCountEl.innerText = 0;

    // Clear active/feedback classes from grid nodes
    if (singleGrid) {
        singleGrid.querySelectorAll('.node').forEach(n => n.classList.remove('active', 'proof-success', 'proof-fail'));
    }

    if (singleStartBtn) {
        singleStartBtn.disabled = false;
    }
    if (singleEndBtn) {
        singleEndBtn.disabled = true;
    }

    // Initialize timer display
    timeLeft = timerDuration;
    if (singleTimerEl) singleTimerEl.innerText = timeLeft;
    stopTimerSingleProver(); // Ensure timer is stopped on reset

    // ADDED: Stop the style refresh loop on game reset/end
    stopSingleProverStyleRefreshLoop(); // This is important!

    // Hide final results display
    if (singleFinalResultsDisplay) singleFinalResultsDisplay.classList.add('hidden');
    if (gameOverScreenSingle) gameOverScreenSingle.classList.remove('active');

    // Fetch and display ATH score
    if (provername && singleAthScoreEl) {
        fetchAthScore(provername);
    }
    updateLeaderboard(); // Refresh global leaderboard
    console.log('[nzk-puzzle.js][SingleProver] Game State Reset.');
}

function startTimerSingleProver() {
    timeLeft = timerDuration;
    if (singleTimerEl) singleTimerEl.innerText = timeLeft;

    if (timerInterval) {
        clearInterval(timerInterval);
    }
      

    timerInterval = setInterval(() => {
        // This check should be sufficient, but re-ordering for clarity
        // If gameActive somehow became false externally (e.g., from endGame call)
        if (!gameActive) {
            stopTimerSingleProver(); // Ensure interval is cleared
            if (singleTimerEl) singleTimerEl.innerText = '0'; // Force display to 0
            console.log('[Single Prover] Timer found game inactive, stopping.');
            return; // Exit this iteration
        }

        timeLeft--;

        if (singleTimerEl) singleTimerEl.innerText = timeLeft;

        

        if (timeLeft <= 0) {
            console.log('[Single Prover] Timer reached 0. Ending game.');
            stopTimerSingleProver(); // Stop it immediately
            endGame(); // Call the globally exposed endGame function
            if (singleTimerEl) singleTimerEl.innerText = '0'; // Ensure it shows 0
            return; // Exit interval callback immediately after ending game
        }
    }, 1000);
    console.log('[nzk-puzzle.js][SingleProver] Timer started.');
}

/**
 * Starts the continuous refresh loop for Single Prover style previews.
 * his function will completely replace all displayed styles at a set interval.
 */
function startSingleProverStyleRefreshLoop() {
    // Clear any existing interval to prevent multiple loops running concurrently
    if (singleProverStyleRefreshInterval) {
        clearInterval(singleProverStyleRefreshInterval);
    }

    // Perform an initial full refresh of styles when the loop starts
    currentSingleProverStyles = generateRandomStylesForClient(SINGLE_PROVER_NUM_STYLES_TO_DISPLAY);
    buildStylePreview(singleStylePreviewContainer, currentSingleProverStyles);
    console.log(`[Single Prover] Initial full style refresh with ${currentSingleProverStyles.length} styles.`);

    // Set up the interval for subsequent full refreshes
    singleProverStyleRefreshInterval = setInterval(() => {
        currentSingleProverStyles = generateRandomStylesForClient(SINGLE_PROVER_NUM_STYLES_TO_DISPLAY);
        buildStylePreview(singleStylePreviewContainer, currentSingleProverStyles);
        console.log(`[Single Prover] Full style refresh (10s timer) with ${currentSingleProverStyles.length} styles.`);
    },   SINGLE_PROVER_PREVIEW_REFRESH_RATE_MS);
    
}

function stopTimerSingleProver() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
        console.log('[nzk-puzzle.js][SingleProver] Timer stopped.');
    }
}

/**
 * Stops the continuous refresh loop for Single Prover style previews.
 * Call this when the single prover game ends or the mode changes.
 */
function stopSingleProverStyleRefreshLoop() {
    if (singleProverStyleRefreshInterval) {
        clearInterval(singleProverStyleRefreshInterval);
        singleProverStyleRefreshInterval = null; // Reset the interval ID
        console.log("[Single Prover] Style refresh loop stopped.");
    }
}


window.startGame = function() { // Exposed globally for index.html
    gameActive = true;
    successCount = 0;
    failCount = 0;
    currentSingleProverScore = 0;

    if (singleSuccessEl) singleSuccessEl.innerText = successCount;
    if (singleFailEl) singleFailEl.innerText = failCount;
    if (singleScoreEl) singleScoreEl.innerText = currentSingleProverScore;

    if (singleStartBtn) singleStartBtn.disabled = true;
    if (singleEndBtn) singleEndBtn.disabled = false;

    clearGridSelection(singleGrid); // Clear any existing selection and feedback
    activeCells.clear(); // Ensure global set is clear
    if (singleActiveCountEl) singleActiveCountEl.innerText = 0;

    // Reset the game state and timer
    startTimerSingleProver();
    console.log('[nzk-puzzle.js][SingleProver] Game started.');

    // Start the style refresh loop ONLY when the game actively begins
    startSingleProverStyleRefreshLoop(); // Start the style refresh loop
    console.log('[nzk-puzzle.js][SingleProver] Style refresh loop started.');
}

window.endGame = async function() { // Exposed globally for index.html
    if (!gameActive) {
        console.log('[nzk-puzzle.js][SingleProver] Game is already inactive. Preventing multiple endGame calls.');
        return;
    }

    gameActive = false;
    stopTimerSingleProver();

    if (singleStartBtn) singleStartBtn.disabled = false;
    if (singleEndBtn) singleEndBtn.disabled = true;

    console.log('[nzk-puzzle.js][SingleProver] Game Over! Your score:', currentSingleProverScore);

    // Update ATH score and save if higher
    if (currentSingleProverScore > athScore) {
        athScore = currentSingleProverScore;
        if (singleAthScoreEl) singleAthScoreEl.innerText = athScore; // Update UI
        await saveScore(currentSingleProverScore); // Save to database via API
        console.log(`[nzk-puzzle.js][SingleProver] New ATH score: ${athScore}`);
    } else {
        console.log(`[nzk-puzzle.js][SingleProver] Current score ${currentSingleProverScore} is not a new ATH. ATH: ${athScore}`);
        showMessageBox(`Score: ${currentSingleProverScore}. score.`, 'info');
    }

// Display final results on the dedicated game over screen
    if (singleFinalResultsDisplay) {
        singleFinalResultsDisplay.innerHTML = `
            <p>Your Final Score: <strong>${currentSingleProverScore}</strong></p>
            <p>Proved: <strong>${successCount}</strong></p>
            <p>Failed: <strong>${failCount}</strong></p>
            <p>All-Time High: <strong>${athScore}</strong></p>
        `;
        singleFinalResultsDisplay.classList.remove('hidden');
    }
    if (singleProverScreen) singleProverScreen.classList.remove('active');
    if (gameOverScreenSingle) gameOverScreenSingle.classList.add('active');

    updateLeaderboard(); // Update global leaderboard display
    // Do NOT call resetSingleProverGame immediately here. Let the user click "Play Again"
    // to trigger reset and new game init, otherwise it resets before they see results.
}

function clearGridSelection(gridContainer) {
    if (gridContainer) {
        gridContainer.querySelectorAll('.node').forEach(n => n.classList.remove('active', 'proof-success', 'proof-fail'));
    }
    activeCells.clear();
}

// Function to handle "Play Again" in Single Prover mode
window.playAgainSingleProver = function() {
    if (gameOverScreenSingle) gameOverScreenSingle.classList.remove('active');
    if (singleProverScreen) singleProverScreen.classList.add('active');
    initializeSingleProverGame(); // This will also call reset
    startGame(); // Start a new game immediately
};


// === Multiprover/VS Lobby & Game Functions (Consolidated Socket Handling) ===

// Exposed globally for HTML files to initiate socket connection for specific modes
window.connectSocketForVSMode = function() {
    console.log("[nzk-puzzle.js][SocketInit] Attempting to connect socket for VS mode.");
    connectToMultiproverServer('vs');
};

window.connectSocketForMultiprover = function() {
    console.log("[nzk-puzzle.js][SocketInit] Attempting to connect socket for Multiprover mode.");
    connectToMultiproverServer('multiprover');
};


function connectToMultiproverServer(mode) {
    console.log(`[nzk-puzzle.js][Socket] connectToMultiproverServer called for mode: ${mode}`);
    if (socket && socket.connected && currentGameMode === mode) {
        console.log(`[nzk-puzzle.js][Socket] Socket already connected for mode ${mode}, skipping reconnection.`);
        return;
    }
    // If connected to a different mode or not connected, disconnect existing and re-connect
    if (socket && socket.connected) {
        console.log(`[nzk-puzzle.js][Socket] Disconnecting from previous mode (${currentGameMode}) to connect to ${mode}.`);
        socket.disconnect();
    }

    currentGameMode = mode; // Ensure global mode is set

    socket = io(BASE_URL, { // Corrected: Using BASE_URL variable
        auth: {
            token: token,
            provername: provername
        }
    });

    socket.on('connect', () => {
        console.log(`[nzk-puzzle.js][Socket] CONNECTED to server for ${mode} mode.`);
        updateConnectionStatus('connected');

        // This is where we ensure the lobby buttons are enabled ONLY if socket is connected
        if (mode === 'multiprover') {
            const multiHostBtn = document.getElementById('multi-host-btn');
            const multiJoinBtn = document.getElementById('multi-join-btn');
            if (multiHostBtn) {
                multiHostBtn.disabled = false;
                console.log("[nzk-puzzle.js][Socket] multi-host-btn enabled.");
            }
            if (multiJoinBtn) {
                multiJoinBtn.disabled = false;
                console.log("[nzk-puzzle.js][Socket] multi-join-btn enabled.");
            }
        }
        
        // Request available rooms upon connection for lobby
        if (mode === 'vs' && window.showLobbySubScreen) {
             window.showLobbySubScreen(document.getElementById('lobby-options'));
        } else if (mode === 'multiprover' && window.showMultiproverSubScreen) {
            window.showMultiproverSubScreen(document.getElementById('multi-lobby-options'));
        }
        socket.emit('get-rooms'); // Request rooms immediately after connection
        console.log(`[nzk-puzzle.js][Socket] Emitted 'get-rooms' after connection.`);

    });

    socket.on('disconnect', (reason) => {
        console.log(`[nzk-puzzle.js][Socket] DISCONNECTED from server. Reason: ${reason}`);
        updateConnectionStatus('disconnected');
        gameActive = false; // Ensure game is marked inactive on disconnect
        showMessageBox(`Disconnected from game. Reason: ${reason}`, 'error', 5000);
        
        // Handle unexpected disconnects / force logout
        if (reason === 'io server disconnect' || reason === 'transport close' || reason === 'ping timeout' || reason === 'bad handshake') {
            console.warn(`[nzk-puzzle.js][Socket] Critical disconnect reason: ${reason}. Forcing logout.`);
            // A small delay before redirect to ensure message box is seen
            setTimeout(() => {
                localStorage.removeItem('nzkp-token');
                localStorage.removeItem('nzkp-provername');
                window.location.href = 'login.html';
            }, 1000);
        } else {
             // For planned disconnects (e.g., leave-room), just redirect to mode selection
             setTimeout(() => {
                window.location.href = 'mode.html';
            }, 1000);
        }
        currentRoomId = null;
        isHost = false;
        activeCells.clear();
        provedStyleIds.clear();
    });

    socket.on('error', (data) => {
        console.error('[nzk-puzzle.js][Socket] Server error message:', data.message);
        showMessageBox(`Server Error: ${data.message}`, 'error', 5000);
        if (data.message.includes('Authentication error') || data.message.includes('Invalid token')) {
            console.warn('[nzk-puzzle.js][Socket] Authentication error, forcing logout.');
            setTimeout(() => {
                localStorage.removeItem('nzkp-token');
                localStorage.removeItem('nzkp-provername');
                window.location.href = 'login.html';
            }, 1000);
        } else {
            // For other errors, try to return to lobby or mode selection
            setTimeout(() => {
                window.location.href = 'mode.html';
            }, 1000);
        }
    });

    // --- Lobby/Room Events (Shared between VS and Multiprover) ---
    socket.on('room-created', handleRoomCreated);
    socket.on('room-joined', handleRoomJoined);
    socket.on('prover-joined', handleProverJoined);
    socket.on('prover-left', handleProverLeft);
    socket.on('prover-ready-update', handleProverReadyUpdate);
    socket.on('rooms-list', handleRoomsList); // Not currently used by UI but useful for debugging
    socket.on('rooms-updated', handleRoomsUpdated);

    // --- In-Game Events (Shared between VS and Multiprover) ---
    socket.on('game-started', handleGameStarted);
    socket.on('game-state-update', handleGameStateUpdate);
    socket.on('proof-submitted', handleProofSubmitted);
    socket.on('game-ended', handleGameEnded);
}

// --- Socket Event Emitters (Exposed Globally for HTML to Call) ---
window.emitCreateRoom = function(mode, timer, maxProvers) {
    console.log(`[nzk-puzzle.js][Emit] emitCreateRoom called (mode: ${mode}, timer: ${timer}, maxProvers: ${maxProvers}). Socket connected: ${socket && socket.connected}`);
    if (!socket || !socket.connected) {
        showMessageBox('Not connected to server. Please wait or refresh.', 'error', 3000);
        return;
    }
    socket.emit('create-room', { mode, timer, maxProvers });
    showMessageBox('Creating room...', 'info', 1500);
};

window.emitJoinRoom = function(roomId) {
    console.log(`[nzk-puzzle.js][Emit] emitJoinRoom called (roomId: ${roomId}). Socket connected: ${socket && socket.connected}`);
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
    console.log(`[nzk-puzzle.js][Emit] emitLeaveRoom called. Current room: ${currentRoomId}. Socket connected: ${socket && socket.connected}`);
    if (currentRoomId && socket && socket.connected) {
        socket.emit('leave-room', { roomId: currentRoomId });
        showMessageBox('Leaving room...', 'info', 1500);
    } else {
        console.warn('[nzk-puzzle.js][Emit] Attempted to leave room but not in one or socket not connected. Redirecting to mode.html.');
        window.location.href = 'mode.html'; // Fallback to mode selection
    }
};

window.emitToggleReady = function(readyStatus) {
    console.log(`[nzk-puzzle.js][Emit] emitToggleReady called (ready: ${readyStatus}). Current room: ${currentRoomId}. Socket connected: ${socket && socket.connected}`);
    if (currentRoomId && socket && socket.connected) {
        socket.emit('toggle-ready', { roomId: currentRoomId, ready: readyStatus });
        showMessageBox(`You are now ${readyStatus ? 'READY' : 'NOT READY'}.`, 'info', 1500);
    } else {
        console.warn('[nzk-puzzle.js][Emit] Cannot toggle ready, not in a room.');
        showMessageBox('Cannot toggle ready, not in a room.', 'error', 2000);
    }
};

window.emitStartGame = function() {
    console.log(`[nzk-puzzle.js][Emit] emitStartGame called. Current room: ${currentRoomId}. Is host: ${isHost}. Socket connected: ${socket && socket.connected}`);
    if (isHost && currentRoomId && socket && socket.connected) {
        socket.emit('start-game', { roomId: currentRoomId });
        showMessageBox('Starting game...', 'info', 1500);
    } else {
        showMessageBox('Only the host can start the game, or not in a room.', 'error', 3000);
    }
};


// --- Socket Event Handlers ---
function handleRoomCreated(data) {
    currentRoomId = data.roomId;
    isHost = data.isHost;
    console.log(`[nzk-puzzle.js][SocketEvent] Room created: ${data.roomId}, isHost: ${isHost}`);
    showMessageBox(`Room created! Code: ${data.roomId}`, 'success', 3000);

    if (currentGameMode === 'vs' && window.showLobbySubScreen) {
        window.showLobbySubScreen(document.getElementById('waiting-room'));
        const roomCodeInput = document.getElementById('room-code');
        if (roomCodeInput) roomCodeInput.value = data.roomId;
        const currentRoomCodeSpan = document.getElementById('current-room-code');
        if (currentRoomCodeSpan) currentRoomCodeSpan.textContent = data.roomId;
        const hostControlsDiv = document.getElementById('host-controls');
        if (hostControlsDiv) hostControlsDiv.classList.remove('hidden');
        const startVsGameBtn = document.getElementById('start-vs-game');
        if (startVsGameBtn) startVsGameBtn.disabled = true; // Wait for opponent
        updateProverList(data.roomInfo.leaderboard, 'vs');
    } else if (currentGameMode === 'multiprover' && window.showMultiproverSubScreen) {
        window.showMultiproverSubScreen(document.getElementById('multi-waiting-room'));
        const multiRoomCodeInput = document.getElementById('multi-room-code');
        if (multiRoomCodeInput) multiRoomCodeInput.value = data.roomId;
        const multiCurrentRoomCodeSpan = document.getElementById('multi-current-room-code');
        if (multiCurrentRoomCodeSpan) multiCurrentRoomCodeSpan.textContent = data.roomId;
        const multiHostControlsDiv = document.getElementById('multi-host-controls');
        if (multiHostControlsDiv) multiHostControlsDiv.classList.remove('hidden');
        const multiStartGameBtn = document.getElementById('multi-start-game');
        if (multiStartGameBtn) multiStartGameBtn.disabled = true; // Wait for provers
        // Pass the correct leaderboard from data.roomInfo, defaulting to empty array
        updateProverList(data.roomInfo.leaderboard || [], 'multiprover-waiting');
    }
}

function handleRoomJoined(data) {
    currentRoomId = data.roomId;
    isHost = data.isHost;
    console.log(`[nzk-puzzle.js][SocketEvent] Room joined: ${data.roomId}, isHost: ${isHost}`);
    showMessageBox(`Joined room: ${data.roomId}`, 'success', 3000);

    if (currentGameMode === 'vs' && window.showLobbySubScreen) {
        window.showLobbySubScreen(document.getElementById('waiting-room'));
        const currentRoomCodeSpan = document.getElementById('current-room-code');
        if (currentRoomCodeSpan) currentRoomCodeSpan.textContent = data.roomId;
        const hostControlsDiv = document.getElementById('host-controls');
        if (hostControlsDiv) {
            if (isHost) hostControlsDiv.classList.remove('hidden');
            else hostControlsDiv.classList.add('hidden');
        }
        const startVsGameBtn = document.getElementById('start-vs-game');
        if (startVsGameBtn) startVsGameBtn.disabled = true; // Still wait for host to start or for provers
        updateProverList(data.roomInfo.leaderboard, 'vs');
    } else if (currentGameMode === 'multiprover' && window.showMultiproverSubScreen) {
        window.showMultiproverSubScreen(document.getElementById('multi-waiting-room'));
        const multiCurrentRoomCodeSpan = document.getElementById('multi-current-room-code');
        if (multiCurrentRoomCodeSpan) multiCurrentRoomCodeSpan.textContent = data.roomId;
        const multiHostControlsDiv = document.getElementById('multi-host-controls');
        if (multiHostControlsDiv) {
            if (isHost) multiHostControlsDiv.classList.remove('hidden');
            else multiHostControlsDiv.classList.add('hidden');
        }
        const multiStartGameBtn = document.getElementById('multi-start-game');
        if (multiStartGameBtn) multiStartGameBtn.disabled = true;
        // Pass the correct leaderboard from data.roomInfo, defaulting to empty array
        updateProverList(data.roomInfo.leaderboard || [], 'multiprover-waiting');
    }
}

function handleProverJoined(data) {
    console.log(`[nzk-puzzle.js][SocketEvent] Prover ${data.provername} joined room. Total: ${data.proverCount}`);
    showMessageBox(`${data.provername} joined the room.`, 'info', 2000);

    if (currentGameMode === 'vs') {
        updateProverList(data.leaderboard, 'vs');
        if (isHost) {
            const startVsGameBtn = document.getElementById('start-vs-game');
            if (startVsGameBtn) {
                const readyProvers = data.leaderboard.filter(p => p.ready).length;
                startVsGameBtn.disabled = !(readyProvers === 2 && data.leaderboard.length === 2);
            }
        }
    } else if (currentGameMode === 'multiprover') {
        updateProverList(data.leaderboard, 'multiprover-waiting');
        if (isHost) {
            const multiStartGameBtn = document.getElementById('multi-start-game');
            if (multiStartGameBtn) multiStartGameBtn.disabled = (data.proverCount < 3 || !data.allReady); // Minimum 3 provers AND all ready
        }
    }
}

function handleProverLeft(data) {
    console.log(`[nzk-puzzle.js][SocketEvent] Prover ${data.provername} left. Prover count: ${data.proverCount}`);
    showMessageBox(`${data.provername} left the room.`, 'info', 2000);

    if (currentGameMode === 'vs') {
        updateProverList(data.leaderboard, 'vs');
        if (isHost) {
            const startVsGameBtn = document.getElementById('start-vs-game');
            if (startVsGameBtn) {
                const readyProvers = data.leaderboard.filter(p => p.ready).length;
                startVsGameBtn.disabled = !(readyProvers === 2 && data.leaderboard.length === 2);
                if (data.proverCount < 2) {
                    showMessageBox(`Opponent disconnected. Waiting for another prover...`, 'info', 3000);
                }
            }
        } else if (data.proverCount === 0 && currentRoomId) { // Non-host and room is empty (host left)
            showMessageBox('Host left or opponent disconnected. Returning to lobby.', 'info', 3000);
            window.emitLeaveRoom(); // Clean up if in a room
        }
    } else if (currentGameMode === 'multiprover') {
        updateProverList(data.leaderboard, 'multiprover-waiting');
        if (isHost) {
            const multiStartGameBtn = document.getElementById('multi-start-game');
            if (multiStartGameBtn) multiStartGameBtn.disabled = (data.proverCount < 3 || !data.allReady); // Re-evaluate start button
            if (data.proverCount === 0) { // If host left alone
                showMessageBox('All other provers left. Returning to lobby.', 'info', 3000);
                window.emitLeaveRoom();
            }
        } else if (data.proverCount === 0 && currentRoomId) { // Non-host and room empty
            showMessageBox('Host left or room became empty. Returning to lobby.', 'info', 3000);
            window.emitLeaveRoom();
        }
    }
}

function handleProverReadyUpdate(data) {
    console.log(`[nzk-puzzle.js][SocketEvent] Prover ${data.provername} ready status: ${data.ready}`);
    showMessageBox(`${data.provername} is ${data.ready ? 'ready' : 'not ready'}.`, 'info', 1500);

    if (currentGameMode === 'vs') {
        updateProverList(data.leaderboard, 'vs');
        if (isHost) {
            const startVsGameBtn = document.getElementById('start-vs-game');
            if (startVsGameBtn) {
                const readyProvers = data.leaderboard.filter(p => p.ready).length;
                startVsGameBtn.disabled = !(readyProvers === 2 && data.leaderboard.length === 2); // Host can start if exactly 2 provers AND both are ready
            }
        }
    } else if (currentGameMode === 'multiprover') {
        updateProverList(data.leaderboard, 'multiprover-waiting');
        if (isHost) { // Only host cares about overall readiness for start button
            const multiStartGameBtn = document.getElementById('multi-start-game');
            if (multiStartGameBtn) multiStartGameBtn.disabled = (data.leaderboard.length < 3 || !data.allReady); // Need min 3 AND all ready
        }
    }
}

function handleRoomsList(rooms) {
    console.log('[nzk-puzzle.js][SocketEvent] Received rooms list:', rooms);
    // This function could be used to populate a list of joinable rooms.
    // For now, it's just logging.
}

function handleRoomsUpdated() {
    console.log('[nzk-puzzle.js][SocketEvent] Rooms updated event received. Re-fetching rooms list.');
    if (socket && socket.connected && (currentGameMode === 'vs' || currentGameMode === 'multiprover')) {
        socket.emit('get-rooms'); // Re-fetch rooms if a lobby UI needs to update
    }
}

function handleGameStarted(data) {
    console.log(`[nzk-puzzle.js][SocketEvent] Game started in room ${currentRoomId}! Initial active styles:`, data.activeChallenges);
    showMessageBox('Game Started! Good luck!', 'success', 2500);
    gameActive = true; // Set game active flag for current client
    activeCells.clear(); // Ensure selection is clear at game start
    provedStyleIds.clear(); // Clear proved styles from previous games

    if (currentGameMode === 'vs' && window.showScreen) {
        window.showScreen(document.getElementById('vs-game-screen'));
        if (vsYourGridDiv) buildGrid(vsYourGridDiv, 'vs-prover-own');
        if (vsYourScoreSpan) vsYourScoreSpan.textContent = '0';
        if (vsOpponentScoreSpan) vsOpponentScoreSpan.textContent = '0';
        if (vsYourActiveCountSpan) vsYourActiveCountSpan.textContent = '0';

        if (vsActiveStylesPreviewDiv) buildStylePreview(vsActiveStylesPreviewDiv, data.activeChallenges, provedStyleIds);
        if (data.initialLeaderboard) updateVsScoreboard(data.initialLeaderboard);
        if (vsOpponentStatusDiv) vsOpponentStatusDiv.textContent = 'Waiting for opponent\'s move...';
        // Set your prover name
        if (vsYourProvernameSpan) vsYourProvernameSpan.textContent = provername;
        // Set opponent prover name if exists
        const opponentProver = data.initialLeaderboard.find(p => p.provername !== provername);
        if(vsOpponentProvernameSpan) vsOpponentProvernameSpan.textContent = opponentProver ? opponentProver.provername : '-';

    } else if (currentGameMode === 'multiprover' && window.showScreen) {
        window.showScreen(document.getElementById('multiprover-game-screen'));
        if (multiGridDiv) buildGrid(multiGridDiv, 'multiprover');
        if (multiScoreSpan) multiScoreSpan.textContent = '0';
        if (multiProverCountSpan) multiProverCountSpan.textContent = data.initialLeaderboard.length;
        if (multiProvernameSpan) multiProvernameSpan.textContent = provername;
        // Ensure multiActiveCountSpan is reset
        if (multiActiveCountSpan) multiActiveCountSpan.innerText = '0';


        if (multiStylesPreviewDiv) buildStylePreview(multiStylesPreviewDiv, data.activeChallenges, provedStyleIds);
        if (data.initialLeaderboard) updateMultiproverScoreboard(data.initialLeaderboard);
        if (multiLeaderSpan && data.initialLeaderboard.length > 0) multiLeaderSpan.textContent = data.initialLeaderboard[0].provername;
    }
}

function handleGameStateUpdate(data) {
    if (!gameActive) {
        console.log('[Game State Update] Received update but game is not active.');
        return; // Only process if game is active
    }

    if (currentGameMode === 'vs') {
        if (document.getElementById('vs-timer')) document.getElementById('vs-timer').textContent = data.timeRemaining;
        if (data.leaderboard) updateVsScoreboard(data.leaderboard);
        if (data.activeChallenges) buildStylePreview(vsActiveStylesPreviewDiv, data.activeChallenges, provedStyleIds);
    } else if (currentGameMode === 'multiprover') {
        if (multiTimerSpan) multiTimerSpan.textContent = data.timeRemaining;
        if (multiProverCountSpan) multiProverCountSpan.textContent = data.leaderboard.length;
        if (data.leaderboard) updateMultiproverScoreboard(data.leaderboard);
        if (multiStylesPreviewDiv) buildStylePreview(multiStylesPreviewDiv, data.activeChallenges, provedStyleIds);
        if (multiLeaderSpan && data.leaderboard.length > 0) multiLeaderSpan.textContent = data.leaderboard[0].provername;
    }
}

function handleProofSubmitted(data) {
    console.log(`[Socket.IO] Proof submitted by ${data.provername}. Correct: ${data.isCorrect}. Message: ${data.message}`);
    
    // Add the proved style ID to the set if correct
    if (data.isCorrect && data.provedStyleId) {
        provedStyleIds.add(data.provedStyleId);
    }

    // Apply visual feedback (fast flash) only to the cells that were part of the proof
    const currentGrid = (currentGameMode === 'vs') ? vsYourGridDiv : multiGridDiv;
    if (currentGrid && data.provername === provername) { // Only apply feedback to your own grid for your actions
        const selectedNodesToFlash = data.selectedNodes; // Server should ideally send back the exact nodes that formed the proof
        const flashNodes = selectedNodesToFlash.map(index => currentGrid.querySelector(`.node[data-index="${index}"]`));

        if (flashNodes.length > 0) {
            flashNodes.forEach(node => {
                if (node) node.classList.add(data.isCorrect ? 'proof-success' : 'proof-fail');
            });
            setTimeout(() => {
                flashNodes.forEach(node => {
                    if (node) node.classList.remove('proof-success', 'proof-fail');
                });
            }, 200); // Fast flash duration
        }
        // Clear local selection after visual feedback
        clearGridSelection(currentGrid); // This clears all currently active cells on the *local* grid
        // Update active count display
        if (currentGameMode === 'vs' && vsYourActiveCountSpan) {
            vsYourActiveCountSpan.innerText = 0;
        } else if (currentGameMode === 'multiprover' && multiActiveCountSpan) {
            multiActiveCountSpan.innerText = 0;
        }
    }

    // Update opponent status message in VS mode
    if (currentGameMode === 'vs' && vsOpponentStatusDiv) {
        if (data.provername === provername) {
             showMessageBox(data.message, data.isCorrect ? 'success' : 'error');
        } else {
            vsOpponentStatusDiv.textContent = `${data.provername} proved ${data.isCorrect ? 'correctly!' : 'incorrectly!'}`;
            setTimeout(() => {
                vsOpponentStatusDiv.textContent = 'Waiting for opponent\'s move...';
            }, 2000);
        }
    } else if (currentGameMode === 'multiprover' && data.provername === provername) {
        showMessageBox(data.message, data.isCorrect ? 'success' : 'error');
    }

    // Styles and scores are updated via `game-state-update` which is a periodic broadcast from the server.
    // The `game-state-update` will contain the new set of `activeChallenges` and the updated `leaderboard`.
}

async function handleGameEnded(data) {
    console.log(`[Socket.IO] Game ended in room ${currentRoomId}! Final results:`, data.results);
    showMessageBox('Game Over!', 'info', 3000);
    gameActive = false;
    
    // Clear any active selections and feedback on the grid
    const currentActiveGrid = (currentGameMode === 'vs') ? vsYourGridDiv : multiGridDiv;
    clearGridSelection(currentActiveGrid);
    activeCells.clear();
    provedStyleIds.clear(); // Clear for next game

    // Update ATH scores for all provers who played this game
    const yourResult = data.results.find(p => p.provername === provername);
    if (yourResult && yourResult.score > athScore) {
        athScore = yourResult.score;
        // Update relevant ATH display element if available (e.g., in Single Prover, or general stats)
        if (singleAthScoreEl) singleAthScoreEl.innerText = athScore;
        // No need to call saveScore here, server already handled ATH update
        showMessageBox(`New All-Time High Score: ${athScore}!`, 'success', 3000);
    } else if (yourResult) {
        showMessageBox(`Your score: ${yourResult.score}. Not a new ATH.`, 'info', 3000);
    }


    // Display final results screen (delegated to HTML's embedded script)
    if (currentGameMode === 'vs' && window.showScreen && document.getElementById('game-over-screen')) {
        window.showScreen(document.getElementById('game-over-screen'));
        const vsFinalResultsDiv = document.getElementById('vs-final-results');
        if (vsFinalResultsDiv) {
            let html = '<h3>Final Scores:</h3>';
            data.results.sort((a, b) => b.score - a.score).forEach(prover => {
                const isWinner = data.results.length > 0 && data.results[0].score === prover.score && prover.score > 0;
                html += `
                    <div class="final-score-item">
                        <span class="final-name">${prover.provername}</span>
                        <span class="final-score">${prover.score} ${isWinner ? '🏆' : ''}</span>
                    </div>`;
            });
            vsFinalResultsDiv.innerHTML = html;
        }
    } else if (currentGameMode === 'multiprover' && window.showScreen && document.getElementById('multi-game-over-screen')) {
        window.showScreen(document.getElementById('multi-game-over-screen'));
        const multiFinalResultsDiv = document.getElementById('multi-final-results');
        if (multiFinalResultsDiv) {
            let html = '<h3>Final Scores:</h3>';
            data.results.sort((a, b) => b.score - a.score).forEach(prover => {
                const isWinner = data.results.length > 0 && data.results[0].score === prover.score && prover.score > 0;
                html += `
                    <div class="final-score-item">
                        <span class="final-name">${prover.provername}</span>
                        <span class="final-score">${prover.score} ${isWinner ? '🏆' : ''}</span>
                    </div>`;
            });
            multiFinalResultsDiv.innerHTML = html;
        }
    }
    // No explicit leave-room call here as the server handles room cleanup after game ends.
    // The "Play Again" or "Back to Modes" buttons will handle new connections/redirections.
}


/**
 * Updates the prover list in lobby screens.
 * @param {Array<Object>} provers - Array of prover objects from leaderboard.
 * @param {string} type - 'vs' or 'multiprover-waiting' to determine which list to update.
 */
function updateProverList(provers, type) {
    // Ensure provers is an array, even if it's null or undefined initially
    const actualProvers = provers || [];

    let targetListDiv;
    let proverCountSpan;
    let setReadyBtn;
    let readyStatusSpan;

    if (type === 'vs') {
        targetListDiv = document.getElementById('prover-list');
        proverCountSpan = document.getElementById('prover-count');
        setReadyBtn = document.getElementById('set-ready-btn');
        readyStatusSpan = document.getElementById('ready-status-span');
    } else if (type === 'multiprover-waiting') {
        targetListDiv = document.getElementById('multi-waiting-prover-list');
        proverCountSpan = document.getElementById('multi-waiting-prover-count');
        setReadyBtn = document.getElementById('multi-set-ready-btn');
        readyStatusSpan = document.getElementById('multi-ready-status-span');
    } else {
        return;
    }

    if (!targetListDiv || !proverCountSpan) {
        console.warn(`[updateProverList] Target div or count span not found for type: ${type}`);
        return;
    }

    // Use actualProvers.length here
    proverCountSpan.textContent = actualProvers.length;
    targetListDiv.innerHTML = ''; // Clear existing list

    let allProversReady = true; // For host's "Start Game" button logic
    let yourReadyStatus = false;

    actualProvers.forEach(prover => { // Iterate over actualProvers
        const proverItem = document.createElement('div');
        proverItem.classList.add('prover-item');
        if (prover.provername === provername) {
            proverItem.classList.add('current-prover');
            yourReadyStatus = prover.ready; // Get your own ready status
        }
        proverItem.innerHTML = `
            <span class="provername">${prover.provername} ${prover.provername === provername ? '(You)' : ''}</span>
            <span class="ready-status ${prover.ready ? 'ready' : ''}">${prover.ready ? 'Ready' : 'Not Ready'}</span>
        `;
        targetListDiv.appendChild(proverItem);

        if (!prover.ready) {
            allProversReady = false;
        }
    });
    console.log(`[updateProverList] Prover list updated for ${type}. Total provers: ${actualProvers.length}. All provers ready: ${allProversReady}`);

    // Update the 'Ready' button text and data-ready attribute for the current prover
    if (setReadyBtn) {
        setReadyBtn.dataset.ready = String(yourReadyStatus);
        setReadyBtn.textContent = yourReadyStatus ? 'Unready' : 'Ready';
    }
    // Update the ready status text display
    if (readyStatusSpan) {
        readyStatusSpan.textContent = yourReadyStatus ? 'READY' : 'NOT READY';
    }


    // Enable/disable "Start Game" button for host based on readiness and count
    if (isHost) {
        if (type === 'vs') {
            const startVsGameBtn = document.getElementById('start-vs-game');
            if (startVsGameBtn) {
                // VS mode requires exactly 2 provers AND both ready
                startVsGameBtn.disabled = !(actualProvers.length === 2 && allProversReady);
            }
        } else if (type === 'multiprover-waiting') {
            const multiStartGameBtn = document.getElementById('multi-start-game');
            if (multiStartGameBtn) {
                // Multiprover mode requires minimum 3 provers AND all ready
                multiStartGameBtn.disabled = (actualProvers.length < 3 || !allProversReady); // Corrected logic here
            }
        }
    }
}


/**
 * Updates the in-game scoreboard for VS or Multiprover.
 * @param {Array<Object>} leaderboard - Sorted array of prover objects with scores.
 */
function updateVsScoreboard(leaderboard) {
    const yourProverState = leaderboard.find(p => p.provername === provername);
    if (yourProverState && vsYourScoreSpan) {
        vsYourScoreSpan.textContent = yourProverState.score;
    }

    const opponentProverState = leaderboard.find(p => p.provername !== provername);
    if (opponentProverState && vsOpponentScoreSpan) {
        vsOpponentScoreSpan.textContent = opponentProverState.score;
    } else if (vsOpponentScoreSpan) {
        vsOpponentScoreSpan.textContent = '0'; // If no opponent found
    }

    // Update opponent name display based on the first time opponent is identified
    if (vsOpponentProvernameSpan) {
        if (opponentProverState) {
            vsOpponentProvernameSpan.textContent = opponentProverState.provername;
        } else {
            vsOpponentProvernameSpan.textContent = '-'; // Reset if opponent leaves
        }
    }
}

function updateMultiproverScoreboard(leaderboard) {
    if (!multiProverListDiv) return;

    const sortedScores = [...leaderboard].sort((a, b) => b.score - a.score);

    multiProverListDiv.innerHTML = sortedScores.map((prover, index) => {
        const rankEmoji = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '';
        const isCurrentProver = prover.provername === provername;
        return `
            <div class="prover-score-item ${isCurrentProver ? 'current-prover' : ''}">
                <span class="prover-name">${rankEmoji} ${prover.provername} ${isCurrentProver ? '(You)' : ''}</span>
                <span class="prover-score">${prover.score}</span>
            </div>
        `;
    }).join('');

    // Update your score in the info bar
    const yourProverState = leaderboard.find(p => p.provername === provername);
    if (yourProverState && multiScoreSpan) {
        multiScoreSpan.textContent = yourProverState.score;
    }

    // Update leading prover in the info bar
    if (multiLeaderSpan && sortedScores.length > 0) {
        multiLeaderSpan.textContent = sortedScores[0].provername;
    } else if (multiLeaderSpan) {
        multiLeaderSpan.textContent = '-';
    }
}
