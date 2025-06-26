const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { MongoClient } = require('mongodb');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Configure Socket.IO to allow CORS for client connections
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware (applied globally, but API routes will only be used after DB connects)
app.use(express.json());
app.use(cors());

// Configuration from .env or default fallbacks
const JWT_SECRET = process.env.JWT_SECRET;
const SALT_ROUNDS = parseInt(process.env.SALT_ROUNDS, 10) || 12;
const MONGODB_URL = process.env.MONGODB_URL;
const PORT = process.env.PORT;

console.log(`[Server Config] JWT_SECRET loaded: ${JWT_SECRET ? 'YES' : 'NO'}`);
console.log(`[Server Config] MONGODB_URL loaded: ${MONGODB_URL ? 'YES' : 'NO'}`);

// Rate limiting for authentication endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 requests per windowMs
    message: { success: false, error: 'Too many authentication attempts, please try again later' }
});

// MongoDB Connection
let proversCollection; // To hold the reference to the provers collection

// IMPORTANT: Wrap server initialization in an async function to await MongoDB connection
(async function initServer() {
    const client = new MongoClient(MONGODB_URL);
    try {
        await client.connect();
        console.log('Connected to MongoDB Atlas');
        const db = client.db('nzkp');
        proversCollection = db.collection('provers'); // This assignment must happen BEFORE routes are active

        // --- All server setup that depends on DB connection goes AFTER this point ---

        // Serve socket.io client files explicitly and *before* general static serving
        app.use('/socket.io', express.static(path.join(__dirname, 'node_modules', 'socket.io', 'client-dist')));
        // Serve your own static files (HTML, CSS, JS, images) from the current directory
        app.use(express.static(__dirname));

        // Middleware to verify JWT token
        const authenticateToken = (req, res, next) => {
            const authHeader = req.headers['authorization'];
            const token = authHeader && authHeader.split(' ')[1];

            if (!token) {
                console.warn('[authenticateToken] No token provided in Authorization header.');
                return res.status(401).json({ success: false, error: 'Access token required' });
            }

            jwt.verify(token, JWT_SECRET, (err, prover) => {
                if (err) {
                    console.error('[authenticateToken] JWT verification failed:', err.message);
                    return res.status(403).json({ success: false, error: 'Invalid or expired token' });
                }
                req.prover = prover;
                next();
            });
        };

        // Socket authentication middleware
        const authenticateSocket = (socket, next) => {
            const token = socket.handshake.auth.token;
            if (!token) {
                console.warn('[authenticateSocket] No token provided for socket connection.');
                return next(new Error('Authentication error: No token provided'));
            }

            jwt.verify(token, JWT_SECRET, (err, prover) => {
                if (err) {
                    console.error('[authenticateSocket] JWT verification failed for socket:', err.message);
                    return next(new Error('Authentication error: Invalid token'));
                }
                socket.prover = prover;
                next();
            });
        };

        // --- GAME ROOM & STYLE LOGIC ---

        // Game Room Management
        const gameRooms = new Map();
        const proverSockets = new Map();

        // --- FINAL, CORRECTED, AND UNIQUE STYLESHAPES ARRAY (24 Patterns) ---
        // This array must match the one in nzk-puzzle.js exactly.
        const serverStyleShapes = [
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

        let serverStyleIdCounter = 0;

        function generateServerRandomStyles(count) {
            const styles = [];
            const availableShapes = [...serverStyleShapes]; // Use a fresh copy for selection
            for (let i = 0; i < count; i++) {
                if (availableShapes.length === 0) {
                    console.warn("Server: Not enough unique patterns to generate the requested count. Re-using patterns.");
                    availableShapes.push(...serverStyleShapes); // Replenish if run out
                    if (availableShapes.length === 0) break; // Should not happen if serverStyleShapes is not empty
                }
                const randomIndex = Math.floor(Math.random() * availableShapes.length);
                const selectedPattern = { ...availableShapes.splice(randomIndex, 1)[0] };
                selectedPattern.id = `style_${serverStyleIdCounter++}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; // Ensure unique IDs
                styles.push(selectedPattern);
            }
            return styles;
        }

        // Updated gridSize for server-side pattern checking to 10
        function serverCheckPattern(selectedNodeIndices, pattern, gridSize = 10) { 
            if (selectedNodeIndices.length !== pattern.length) {
                return false;
            }
            if (selectedNodeIndices.length === 0) return false;
            const selectedCoords = selectedNodeIndices.map(index => [
                Math.floor(index / gridSize), 
                index % gridSize              
            ]);
            const minRow = Math.min(...selectedCoords.map(c => c[0]));
            const minCol = Math.min(...selectedCoords.map(c => c[1]));
            const normalizedSelected = selectedCoords.map(c => [c[0] - minRow, c[1] - minCol])
                                                      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
            const normalizedPattern = [...pattern].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
            for (let i = 0; i < normalizedPattern.length; i++) {
                if (normalizedSelected[i][0] !== normalizedPattern[i][0] || normalizedSelected[i][1] !== normalizedPattern[i][1]) {
                    return false;
                }
            }
            return true;
        }

        class GameRoom {
            constructor(id, hostSocketId, hostProvername, mode, timer, maxProvers = 500) {
                this.id = id;
                this.hostSocketId = hostSocketId;
                this.hostProvername = hostProvername;
                this.mode = mode;
                this.timer = timer;
                this.provers = new Map();
                this.gameState = 'waiting';
                this.startTime = null;
                this.endTime = null;
                this.activeChallenges = [];
                this.maxProvers = maxProvers;
                this.challengeCount = 0;
                this.createdAt = Date.now();
                this.gameInterval = null;
                this.styleRefreshInterval = null; // Added for periodic style refresh
                this.lastGameUpdate = Date.now();
            }

            addProver(socketId, provername) {
                if (this.provers.size >= this.maxProvers || this.gameState !== 'waiting') {
                    return false;
                }
                if (Array.from(this.provers.values()).some(p => p.provername === provername)) {
                    console.warn(`Attempt to add duplicate prover ${provername} to room ${this.id}`);
                    return false;
                }
                this.provers.set(socketId, {
                    provername,
                    score: 0,
                    ready: false,
                    correctProofs: 0,
                    wrongProofs: 0,
                    lastProofTime: null,
                    provedStyleIds: new Set() // Track proved styles per prover
                });
                return true;
            }

            removeProver(socketId) {
                const provername = this.provers.get(socketId)?.provername;
                this.provers.delete(socketId);
                if (socketId === this.hostSocketId && this.provers.size > 0) {
                    const firstProverSocketId = this.provers.keys().next().value;
                    this.hostSocketId = firstProverSocketId;
                    this.hostProvername = this.provers.get(firstProverSocketId).provername;
                    console.log(`Host transferred in room ${this.id} to ${this.hostProvername}`);
                } else if (this.provers.size === 0) {
                    if (this.gameInterval) {
                        clearInterval(this.gameInterval);
                        this.gameInterval = null;
                    }
                    if (this.styleRefreshInterval) { // Clear style refresh interval
                        clearInterval(this.styleRefreshInterval);
                        this.styleRefreshInterval = null;
                    }
                    this.gameState = 'empty';
                    console.log(`Room ${this.id} is now empty.`);
                } else {
                    console.log(`Prover ${provername} left room ${this.id}. Remaining: ${this.provers.size}`);
                }
                return this.provers.size === 0;
            }

            setProverReady(socketId, ready) {
                const prover = this.provers.get(socketId);
                if (prover) {
                    prover.ready = ready;
                }
            }

            allProversReady() {
                return Array.from(this.provers.values()).every(prover => prover.ready);
            }

            startGame() {
                if (this.gameState !== 'waiting') return false;
                this.gameState = 'active';
                this.startTime = Date.now();
                this.endTime = this.startTime + (this.timer * 60 * 1000);
                
                this.initializeChallenges(); // Initial challenges
                console.log(`Game started in room ${this.id}. Mode: ${this.mode}`);

                this.gameInterval = setInterval(() => {
                    if (this.isGameFinished()) {
                        const finalResults = this.finishGame();
                        io.to(this.id).emit('game-ended', { results: finalResults });
                        gameRooms.delete(this.id);
                        io.emit('rooms-updated');
                        console.log(`Room ${this.id} game ended and cleaned up.`);
                    } else {
                        this.broadcastGameState();
                    }
                }, 1000);

                // Add style refresh interval only for multiplayer/VS modes
                if (this.mode === 'vs' || this.mode === 'multiprover') {
                    this.styleRefreshInterval = setInterval(() => {
                        if (this.gameState === 'active' && !this.isGameFinished()) {
                            this.refreshChallenges(); // Refresh styles periodically
                            this.broadcastGameState(); // Broadcast the new challenges
                            console.log(`Room ${this.id}: Challenges refreshed.`);
                        }
                    }, 15 * 1000); // 15 seconds refresh rate
                }
                
                return true;
            }
            
            // Function to refresh ALL active challenges
            refreshChallenges() {
                this.activeChallenges = generateServerRandomStyles(6); // Generate 6 new styles
                // Clear proved styles for all provers in the room as new challenges are presented
                this.provers.forEach(prover => {
                    prover.provedStyleIds.clear();
                });
            }

            // Generate 6 initial challenges for multiplayer modes
            initializeChallenges() {
                // For VS and Multiprover, always start with 6 challenges.
                this.activeChallenges = generateServerRandomStyles(6); 
                console.log(`Initialized ${this.activeChallenges.length} challenges for room ${this.id}.`);
            }

            findAndRemoveProvedStyle(selectedNodeIndices) {
                for (let i = 0; i < this.activeChallenges.length; i++) {
                    const style = this.activeChallenges[i];
                    // Pass the room's gridSize (which is implicitly 10 now)
                    if (serverCheckPattern(selectedNodeIndices, style.pattern, 10)) { 
                        // Do NOT splice/remove the style here.
                        // The style remains in activeChallenges for other players to prove.
                        // Instead, we mark it as 'proved' for the specific player.
                        console.log(`Style '${style.name}' proved by a prover in room ${this.id}.`);
                        return style;
                    }
                }
                return null;
            }

            // submitProof logic to NOT add new styles immediately
            submitProof(socketId, selectedNodes) {
                const prover = this.provers.get(socketId);
                if (!prover || this.gameState !== 'active') {
                    return { isCorrect: false, message: 'Game not active or prover not found.', selectedNodes };
                }

                const provedStyle = this.findAndRemoveProvedStyle(selectedNodes);

                if (provedStyle) {
                    // Check if this specific prover has already proved this style in the current set of challenges
                    if (prover.provedStyleIds.has(provedStyle.id)) {
                        prover.score = Math.max(0, prover.score - 5); // Penalize for re-proving
                        prover.wrongProofs += 1;
                        prover.lastProofTime = Date.now();
                        return {
                            isCorrect: false,
                            message: '❌Already proved this style! -5 points!',
                            selectedNodes
                        };
                    }

                    prover.score += 10;
                    prover.correctProofs += 1;
                    prover.lastProofTime = Date.now();
                    prover.provedStyleIds.add(provedStyle.id); // Mark style as proved for this specific prover

                    // No immediate style replacement. New styles ONLY appear during 15-second refresh.
                    return {
                        isCorrect: true,
                        message: `Proof of ${provedStyle.name}✅Proof Successful! +10 points!`,
                        provedStyleId: provedStyle.id,
                        selectedNodes
                    };
                } else {
                    prover.score = Math.max(0, prover.score - 5);
                    prover.wrongProofs += 1;
                    prover.lastProofTime = Date.now();
                    return {
                        isCorrect: false,
                        message: ' ❌Proof Fail. -5 points!',
                        selectedNodes
                    };
                }
            }

            getLeaderboard() {
                return Array.from(this.provers.entries())
                    .map(([socketId, prover]) => ({
                        socketId,
                        provername: prover.provername,
                        score: prover.score,
                        correctProofs: prover.correctProofs,
                        wrongProofs: prover.wrongProofs,
                        isHost: socketId === this.hostSocketId,
                        ready: prover.ready
                    }))
                    .sort((a, b) => b.score - a.score);
            }

            getTimeRemaining() {
                if (!this.startTime) return this.timer * 60;
                const elapsed = Date.now() - this.startTime;
                const remaining = Math.max(0, (this.timer * 60 * 1000) - elapsed);
                return Math.ceil(remaining / 1000);
            }

            isGameFinished() {
                if (this.gameState === 'finished' || this.gameState === 'empty') return true;
                return Date.now() >= this.endTime;
            }

            finishGame() {
                this.gameState = 'finished';
                if (this.gameInterval) {
                    clearInterval(this.gameInterval);
                    this.gameInterval = null;
                }
                if (this.styleRefreshInterval) { // Clear style refresh interval
                    clearInterval(this.styleRefreshInterval);
                    this.styleRefreshInterval = null;
                }
                const finalResults = this.getLeaderboard();
                console.log(`Game ${this.id} finished. Final Results:`, finalResults);

                finalResults.forEach(async (proverResult) => {
                    try {
                        const existingProver = await proversCollection.findOne({ provername: proverResult.provername });
                        if (existingProver && proverResult.score > (existingProver.athScore || 0)) {
                            await proversCollection.updateOne(
                                { provername: proverResult.provername },
                                { $set: { athScore: proverResult.score, athScoreTimestamp: new Date() } }
                            );
                            console.log(`Updated ATH for ${proverResult.provername} to ${proverResult.score}`);
                        }
                    } catch (error) {
                        console.error(`Failed to update ATH for ${proverResult.provername}:`, error);
                    }
                });
                return finalResults;
            }

            broadcastGameState() {
                const leaderboard = this.getLeaderboard();
                const timeRemaining = this.getTimeRemaining();
                
                // For each prover, tailor the activeChallenges to include their proved styles
                this.provers.forEach((prover, socketId) => {
                    const proverSocket = io.sockets.sockets.get(socketId);
                    if (proverSocket) {
                        // Create a copy of activeChallenges and mark proved ones for this specific prover
                        const challengesToSend = this.activeChallenges.map(challenge => ({
                            ...challenge,
                            isProved: prover.provedStyleIds.has(challenge.id)
                        }));

                        proverSocket.emit('game-state-update', {
                            timeRemaining,
                            leaderboard,
                            activeChallenges: challengesToSend, // Send tailored challenges
                            proverScore: prover.score // Send prover's individual score
                        });
                    }
                });
                this.lastGameUpdate = Date.now();
            }

            getRoomInfo() {
                return {
                    id: this.id,
                    hostProvername: this.hostProvername,
                    mode: this.mode,
                    timer: this.timer,
                    proverCount: this.provers.size,
                    maxProvers: this.maxProvers,
                    gameState: this.gameState,
                    timeRemaining: this.getTimeRemaining(),
                    activeChallenges: this.gameState === 'active' ? this.activeChallenges : [],
                    leaderboard: this.getLeaderboard() // Include leaderboard in roomInfo
                };
            }
        }


        // --- REST API ENDPOINTS ---

        app.post('/api/register', authLimiter, async (req, res) => {
            const { provername, password } = req.body;

            if (!provername || typeof provername !== 'string' || provername.trim().length <= 1) {
                return res.status(400).json({ success: false, error: 'Invalid provername (minimum 2 characters)' });
            }
            if (!password || typeof password !== 'string' || password.length < 6) {
                return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long' });
            }

            const cleanProvername = provername.trim();

            try {
                const existingProver = await proversCollection.findOne({ provername: cleanProvername });
                if (existingProver) {
                    return res.status(409).json({ success: false, error: 'Provername already exists' });
                }

                const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

                await proversCollection.insertOne({
                    provername: cleanProvername,
                    password: hashedPassword,
                    athScore: 0,
                    athScoreTimestamp: null,
                    createdAt: new Date(),
                    lastLogin: new Date()
                });

                const token = jwt.sign(
                    { provername: cleanProvername },
                    JWT_SECRET,
                    { expiresIn: '24h' }
                );

                res.json({
                    success: true,
                    message: 'Registration successful',
                    token,
                    provername: cleanProvername
                });
            } catch (error) {
                console.error('Registration error:', error);
                res.status(500).json({ success: false, error: 'Failed to register prover' });
            }
        });

        app.post('/api/login', authLimiter, async (req, res) => {
            const { provername, password } = req.body;

            if (!provername || !password) {
                return res.status(400).json({ success: false, error: 'Provername and password required' });
            }

            try {
                const prover = await proversCollection.findOne({ provername: provername.trim() });
                if (!prover) {
                    return res.status(401).json({ success: false, error: 'Invalid credentials' });
                }

                const validPassword = await bcrypt.compare(password, prover.password);
                if (!validPassword) {
                    return res.status(401).json({ success: false, error: 'Invalid credentials' });
                }

                await proversCollection.updateOne(
                    { provername: provername.trim() },
                    { $set: { lastLogin: new Date() } }
                );

                const token = jwt.sign(
                    { provername: prover.provername },
                    JWT_SECRET,
                    { expiresIn: '24h' }
                );

                res.json({
                    success: true,
                    message: 'Login successful',
                    token,
                    provername: prover.provername,
                    athScore: prover.athScore || 0,
                    athScoreTimestamp: prover.athScoreTimestamp || null
                });
            } catch (error) {
                console.error('Login error:', error);
                res.status(500).json({ success: false, error: 'Failed to login' });
            }
        });

        app.get('/api/verify', authenticateToken, async (req, res) => {
            try {
                const prover = await proversCollection.findOne({ provername: req.prover.provername });
                if (!prover) {
                    return res.status(404).json({ success: false, error: 'Prover not found' });
                }

                res.json({
                    success: true,
                    provername: prover.provername,
                    athScore: prover.athScore || 0,
                    athScoreTimestamp: prover.athScoreTimestamp || null
                });
            } catch (error) {
                console.error('Verify error:', error);
                res.status(500).json({ success: false, error: 'Failed to verify token' });
            }
        });

        app.post('/api/submit-score', authenticateToken, async (req, res) => {
            const { score } = req.body;
            const provername = req.prover.provername;

            if (typeof score !== 'number' || score < 0) {
                return res.status(400).json({ success: false, error: 'Invalid score' });
            }

            try {
                const prover = await proversCollection.findOne({ provername });

                if (score > (prover?.athScore || 0)) {
                    await proversCollection.updateOne(
                        { provername },
                        { $set: { athScore: score, athScoreTimestamp: new Date() } }
                    );
                    res.json({ success: true, message: 'New ATH score recorded!' });
                } else {
                    res.json({ success: true, message: 'Score submitted.' });
                }
            } catch (error) {
                console.error('Score submission error:', error);
                res.status(500).json({ success: false, error: 'Failed to submit score' });
            }
        });

        app.get('/api/leaderboard', async (req, res) => {
            try {
                const leaderboard = await proversCollection
                    .find({})
                    .sort({ athScore: -1 })
                    .limit(10)
                    .project({
                        _id: 0,
                        provername: 1,
                        athScore: 1,
                        athScoreTimestamp: 1
                    })
                    .toArray();

                res.json({ success: true, leaderboard });
            } catch (error) {
                console.error('Leaderboard error:', error);
                res.status(500).json({ success: false, error: 'Internal server error while fetching leaderboard' });
            }
        });

        app.get('/api/prover/:provername', authenticateToken, async (req, res) => {
            const { provername } = req.params;

            if (req.prover.provername !== provername) {
                return res.status(403).json({ success: false, error: 'Access denied' });
            }

            try {
                const prover = await proversCollection.findOne({ provername: provername.trim() });
                res.json({
                    success: true,
                    athScore: prover?.athScore || 0,
                    provername: prover?.provername,
                    athScoreTimestamp: prover?.athScoreTimestamp || null
                });
            } catch (error) {
                console.error('Prover fetch error:', error);
                res.status(500).json({ success: false, error: 'Failed to fetch prover ATH' });
            }
        });

        app.post('/api/logout', authenticateToken, (req, res) => {
            res.json({ success: true, message: 'Logged out successfully' });
        });

        app.get('/api/rooms', authenticateToken, (req, res) => {
            const rooms = Array.from(gameRooms.values())
                .filter(room => room.gameState === 'waiting')
                .map(room => room.getRoomInfo());
            
            res.json({ success: true, rooms });
        });


        // --- SOCKET.IO CONNECTION HANDLING ---
        io.use(authenticateSocket);

        io.on('connection', (socket) => {
            console.log(`Prover ${socket.prover.provername} connected via Socket.IO (ID: ${socket.id})`);
            proverSockets.set(socket.prover.provername, socket.id);

            socket.on('disconnect', () => {
                console.log(`Socket disconnected: ${socket.prover.provername} (ID: ${socket.id})`);
                proverSockets.delete(socket.prover.provername);

                let roomIdToCleanup = null;
                for (const [id, room] of gameRooms.entries()) {
                    if (room.provers.has(socket.id)) {
                        roomIdToCleanup = id;
                        break;
                    }
                }

                if (roomIdToCleanup) {
                    const room = gameRooms.get(roomIdToCleanup);
                    if (room) {
                        const leavingProvername = socket.prover.provername;
                        const wasHost = socket.id === room.hostSocketId;
                        const shouldDeleteRoom = room.removeProver(socket.id);
                        if (shouldDeleteRoom) {
                            gameRooms.delete(roomIdToCleanup);
                            console.log(`Room ${roomIdToCleanup} deleted as it became empty.`);
                        } else {
                            io.to(roomIdToCleanup).emit('prover-left', {
                                provername: leavingProvername,
                                proverCount: room.provers.size,
                                leaderboard: room.getLeaderboard(),
                                newHost: wasHost ? room.hostProvername : null
                            });
                            // Condition for ending VS game on player departure: requires at least 2 players
                            if (room.gameState === 'active' && room.mode === 'vs' && room.provers.size < 2) {
                                const finalResults = room.finishGame();
                                io.to(roomIdToCleanup).emit('game-ended', { results: finalResults, message: `${leavingProvername} left the game. Game Over.` });
                                gameRooms.delete(roomIdToCleanup);
                            }
                            // No specific end condition for multiprover if players leave, as it can continue with fewer.
                        }
                        io.emit('rooms-updated');
                    }
                }
            });

            socket.on('create-room', (data) => {
                const { mode, timer, maxProvers } = data;
                const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                
                const room = new GameRoom(
                    roomId,
                    socket.id,
                    socket.prover.provername,
                    mode,
                    parseInt(timer),
                    parseInt(maxProvers)
                );
                
                room.addProver(socket.id, socket.prover.provername);
                gameRooms.set(roomId, room);
                
                socket.join(roomId);
                socket.emit('room-created', {
                    roomId,
                    roomInfo: room.getRoomInfo(),
                    isHost: true
                });
                
                io.emit('rooms-updated');
                console.log(`Prover ${socket.prover.provername} created room: ${roomId} (Mode: ${mode}, Max: ${maxProvers})`);
            });

            socket.on('join-room', (data) => {
                const { roomId } = data;
                const room = gameRooms.get(roomId);
                
                if (!room) {
                    socket.emit('error', { message: 'Room not found' });
                    return;
                }
                
                if (!room.addProver(socket.id, socket.prover.provername)) {
                    socket.emit('error', { message: 'Cannot join room (full, game in progress, or prover already in room)' });
                    return;
                }
                
                socket.join(roomId);
                socket.emit('room-joined', {
                    roomId,
                    roomInfo: room.getRoomInfo(),
                    isHost: socket.id === room.hostSocketId
                });
                
                io.to(roomId).emit('prover-joined', {
                    provername: socket.prover.provername,
                    proverCount: room.provers.size,
                    leaderboard: room.getLeaderboard(),
                    newProver: {
                        socketId: socket.id,
                        provername: socket.prover.provername,
                        isHost: socket.id === room.hostSocketId
                    }
                });

                io.emit('rooms-updated');
                console.log(`Prover ${socket.prover.provername} joined room: ${roomId}`);
            });

            socket.on('leave-room', (data) => {
                const { roomId } = data;
                const room = gameRooms.get(roomId);
                
                if (room) {
                    const leavingProvername = socket.prover.provername;
                    const wasHost = socket.id === room.hostSocketId;
                    const shouldDelete = room.removeProver(socket.id);
                    socket.leave(roomId);
                    
                    if (shouldDelete) {
                        gameRooms.delete(roomId);
                        console.log(`Room ${roomId} deleted as it became empty.`);
                    } else {
                        io.to(roomId).emit('prover-left', {
                            provername: leavingProvername,
                            proverCount: room.provers.size,
                            leaderboard: room.getLeaderboard(),
                            newHost: wasHost ? room.hostProvername : null
                        });
                        // Condition for ending VS game on player departure: requires at least 2 players
                        if (room.gameState === 'active' && room.mode === 'vs' && room.provers.size < 2) {
                            const finalResults = room.finishGame();
                            io.to(roomId).emit('game-ended', { results: finalResults, message: `${leavingProvername} left the game. Game Over.` });
                            gameRooms.delete(roomId);
                        }
                        // No specific end condition for multiprover if players leave, as it can continue with fewer.
                    }
                    io.emit('rooms-updated');
                }
            });

            // Changed from 'toggle-ready' to 'set-ready' to match client's emit
            socket.on('set-ready', (data) => {
                const { roomId, ready } = data;
                const room = gameRooms.get(roomId);
                
                if (room && room.gameState === 'waiting') {
                    room.setProverReady(socket.id, ready);
                    
                    let minPlayersForStart = 0; // Default, will be set based on mode
                    if (room.mode === 'vs') {
                        minPlayersForStart = 2; // VS mode requires 2 players
                    } else if (room.mode === 'multiprover') {
                        minPlayersForStart = 3; // Multiprover mode requires 3 players
                    }

                    // Broadcast the updated ready status to all provers in the room
                    io.to(roomId).emit('prover-ready-update', {
                        provername: socket.prover.provername,
                        ready: ready,
                        leaderboard: room.getLeaderboard(), // Send full leaderboard with updated ready status
                        allReady: room.allProversReady(), // Indicate if ALL current provers are ready
                        proverCount: room.provers.size // Send current prover count
                    });
                    console.log(`Prover ${socket.prover.provername} in room ${roomId} is now ${ready ? 'ready' : 'not ready'}.`);

                    // Auto-start game if all conditions are met
                    if (room.allProversReady() && room.provers.size >= minPlayersForStart && room.gameState === 'waiting') {
                        room.startGame(); // Start the game if all ready and min players met
                        room.broadcastGameState(); // Initial broadcast of active game state
                    }
                } else {
                    socket.emit('error', { message: 'Cannot change ready status in current room state.' });
                }
            });

            // Changed from 'start-game' to 'host-start-game' to match client's emit
            socket.on('host-start-game', (data) => {
                const { roomId } = data;
                const room = gameRooms.get(roomId);
                
                if (!room) {
                    socket.emit('error', { message: 'Room not found.' });
                    return;
                }
                if (socket.id !== room.hostSocketId) {
                    socket.emit('error', { message: 'Only the host can start the game.' });
                    return;
                }
                if (room.gameState === 'active') {
                    socket.emit('error', { message: 'Game already active.' });
                    return;
                }
                
                let minPlayersForStart = 0; 
                if (room.mode === 'vs') {
                    minPlayersForStart = 2; 
                } else if (room.mode === 'multiprover') {
                    minPlayersForStart = 3; 
                }

                if (room.provers.size < minPlayersForStart) {
                    socket.emit('error', { message: `Need at least ${minPlayersForStart} prover(s) to start this game mode.` });
                    return;
                }
                
                if (!room.allProversReady()) {
                    socket.emit('error', { message: 'All provers must be ready to start the game.' });
                    return;
                }

                if (room.startGame()) {
                    // Send initial game state to all clients in the room
                    io.to(roomId).emit('game-started', {
                        timeRemaining: room.getTimeRemaining(),
                        activeChallenges: room.activeChallenges.map(challenge => ({
                            ...challenge,
                            isProved: false // Initially no styles are proved for any player
                        })),
                        leaderboard: room.getLeaderboard() // Send full leaderboard
                    });
                    console.log(`Host ${socket.prover.provername} started game in room ${roomId}.`);
                } else {
                    socket.emit('error', { message: 'Failed to start game. Check room state.' });
                }
            });

            // Handle submitted proofs from clients
            socket.on('submit-proof', (data) => {
                const { roomId, selectedNodes } = data;
                const room = gameRooms.get(roomId);

                if (!room) {
                    socket.emit('error', { message: 'Room not found for proof submission.' });
                    return;
                }

                const result = room.submitProof(socket.id, selectedNodes);
                socket.emit('proof-submitted', result); // Send result back to the submitting prover
                room.broadcastGameState(); // Broadcast updated state to all provers in the room
            });

            socket.on('get-rooms', () => {
                const roomsList = Array.from(gameRooms.values())
                    .filter(room => room.gameState === 'waiting')
                    .map(room => ({
                        id: room.id,
                        hostProvername: room.hostProvername,
                        mode: room.mode,
                        proverCount: room.provers.size,
                        maxProvers: room.maxProvers,
                        timer: room.timer,
                        allReady: room.allProversReady()
                    }));
                socket.emit('rooms-list', roomsList);
                console.log(`Prover ${socket.prover.provername} requested rooms list. Sent ${roomsList.length} rooms.`);
            });

            // Host can end game
            socket.on('host-end-game', (data) => {
                const { roomId } = data;
                const room = gameRooms.get(roomId);
                if (room && socket.id === room.hostSocketId && room.gameState === 'active') {
                    const finalResults = room.finishGame();
                    io.to(roomId).emit('game-ended', { results: finalResults, message: 'Host ended the game.' });
                    gameRooms.delete(roomId);
                    io.emit('rooms-updated');
                }
            });

            // Host can reset room
            socket.on('host-reset-room', (data) => {
                const { roomId } = data;
                const room = gameRooms.get(roomId);
                if (room && socket.id === room.hostSocketId) {
                    // Clear existing intervals if any
                    if (room.gameInterval) clearInterval(room.gameInterval);
                    if (room.styleRefreshInterval) clearInterval(room.styleRefreshInterval); 

                    // Reset room state
                    room.gameState = 'waiting';
                    room.startTime = null;
                    room.endTime = null;
                    room.activeChallenges = [];
                    room.challengeCount = 0;
                    room.provers.forEach(prover => {
                        prover.score = 0;
                        prover.ready = false;
                        prover.correctProofs = 0;
                        prover.wrongProofs = 0;
                        prover.lastProofTime = null;
                        prover.provedStyleIds.clear(); // Clear proved styles
                    });
                    room.broadcastGameState(); // Broadcast reset state
                    io.emit('rooms-updated'); // Update room list
                    socket.emit('room-reset-success', { roomId });
                    console.log(`Room ${roomId} reset by host.`);
                } else if (!room) {
                    socket.emit('error', { message: 'Room not found.' });
                } else if (socket.id !== room.hostSocketId) {
                    socket.emit('error', { message: 'Only the host can reset the room.' });
                }
            });
        });

        // Start listening after MongoDB connection
        server.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });

    } catch (err) {
        console.error('Failed to connect to MongoDB', err);
        process.exit(1); // Exit if DB connection fails
    }
})();
