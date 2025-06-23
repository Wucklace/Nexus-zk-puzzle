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

        // --- GAME ROOM & STYLE LOGIC (Your existing GameRoom class and helpers) ---
        // These are global variables and functions that depend on collection, but not directly.
        // If they were methods of a class that relied on 'this.proversCollection', they'd be fine.
        // As they are top-level functions, we assume they access the global proversCollection.

        // Game Room Management
        const gameRooms = new Map();
        const proverSockets = new Map();

        const serverStyleShapes = [
            { name: "Square", pattern: [[0, 0], [0, 1], [1, 0], [1, 1]] },
            { name: "Line (Horizontal)", pattern: [[0, 0], [0, 1], [0, 2]] },
            { name: "Line (Vertical)", pattern: [[0, 0], [1, 0], [2, 0]] },
            { name: "L-Shape", pattern: [[0, 0], [1, 0], [1, 1]] },
            { name: "T-Shape", pattern: [[0, 0], [0, 1], [0, 2], [1, 1]] },
            { name: "Cross", pattern: [[0, 1], [1, 0], [1, 1], [1, 2], [2, 1]] },
            { name: "Z-Shape", pattern: [[0, 0], [0, 1], [1, 1], [1, 2]] },
            { name: "Diagonal (TL-BR)", pattern: [[0, 0], [1, 1], [2, 2]] },
            { name: "Diamond", pattern: [[0, 1], [1, 0], [1, 2], [2, 1]] }
        ];

        let serverStyleIdCounter = 0;

        function generateServerRandomStyles(count) {
            const styles = [];
            const availableShapes = [...serverStyleShapes];
            for (let i = 0; i < count; i++) {
                if (availableShapes.length === 0) break;
                const randomIndex = Math.floor(Math.random() * availableShapes.length);
                const selectedPattern = { ...availableShapes.splice(randomIndex, 1)[0] };
                selectedPattern.id = `style_${serverStyleIdCounter++}_${Date.now()}`;
                styles.push(selectedPattern);
            }
            return styles;
        }

        function serverCheckPattern(selectedNodeIndices, pattern, gridSize = 15) {
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
                this.initializeChallenges();
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
                return true;
            }

            initializeChallenges() {
                const numChallenges = this.mode === 'vs' || this.mode === 'multiprover' ? 5 : 5;
                this.activeChallenges = generateServerRandomStyles(numChallenges);
                console.log(`Initialized ${this.activeChallenges.length} challenges for room ${this.id}.`);
            }

            findAndRemoveProvedStyle(selectedNodeIndices) {
                for (let i = 0; i < this.activeChallenges.length; i++) {
                    const style = this.activeChallenges[i];
                    if (serverCheckPattern(selectedNodeIndices, style.pattern, 15)) {
                        this.activeChallenges.splice(i, 1);
                        console.log(`Style '${style.name}' proved and removed from active challenges in room ${this.id}.`);
                        return style;
                    }
                }
                return null;
            }

            submitProof(socketId, selectedNodes) {
                const prover = this.provers.get(socketId);
                if (!prover || this.gameState !== 'active') {
                    return { isCorrect: false, message: 'Game not active or prover not found.', selectedNodes };
                }

                const provedStyle = this.findAndRemoveProvedStyle(selectedNodes);

                if (provedStyle) {
                    prover.score += 10;
                    prover.correctProofs += 1;
                    prover.lastProofTime = Date.now();

                    const newStyle = generateServerRandomStyles(1)[0];
                    if (newStyle) {
                        this.activeChallenges.push(newStyle);
                        console.log(`Generated new challenge for room ${this.id}: ${newStyle.name}`);
                    } else {
                        console.warn(`Server: Could not generate a new style for room ${this.id}.`);
                    }

                    return {
                        isCorrect: true,
                        message: `Proof of ${provedStyle.name} successful! +10 points!`,
                        provedStyleId: provedStyle.id,
                        selectedNodes
                    };
                } else {
                    prover.score = Math.max(0, prover.score - 5);
                    prover.wrongProofs += 1;
                    prover.lastProofTime = Date.now();
                    return {
                        isCorrect: false,
                        message: 'Incorrect proof. -5 points!',
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
                io.to(this.id).emit('game-state-update', {
                    timeRemaining,
                    leaderboard,
                    activeChallenges: this.activeChallenges
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
                    res.json({ success: true, message: 'Score ,', });
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
                            if (room.gameState === 'active' && room.mode === 'vs' && room.provers.size < 2) {
                                const finalResults = room.finishGame();
                                io.to(roomIdToCleanup).emit('game-ended', { results: finalResults, message: `${leavingProvername} left the game. Game Over.` });
                                gameRooms.delete(roomIdToCleanup);
                            }
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
                        if (room.gameState === 'active' && room.mode === 'vs' && room.provers.size < 2) {
                            const finalResults = room.finishGame();
                            io.to(roomId).emit('game-ended', { results: finalResults, message: `${leavingProvername} left the game. Game Over.` });
                            gameRooms.delete(roomId);
                        }
                    }
                    io.emit('rooms-updated');
                } else {
                    console.warn(`Attempted to leave non-existent room: ${roomId}`);
                }
            });

            socket.on('toggle-ready', (data) => {
                const { roomId, ready } = data;
                const room = gameRooms.get(roomId);
                
                if (room && room.gameState === 'waiting') {
                    room.setProverReady(socket.id, ready);
                    
                    let allProversRequiredForStartReady = false;
                    if (room.mode === 'vs') {
                        allProversRequiredForStartReady = room.provers.size === 2 && room.allProversReady();
                    } else if (room.mode === 'multiprover') {
                        allProversRequiredForStartReady = room.provers.size >= 3 && room.allProversReady();
                    }

                    io.to(roomId).emit('prover-ready-update', {
                        provername: socket.prover.provername,
                        ready: ready,
                        leaderboard: room.getLeaderboard(),
                        allReady: allProversRequiredForStartReady
                    });
                    console.log(`Prover ${socket.prover.provername} in room ${roomId} is now ${ready ? 'ready' : 'not ready'}. All required ready: ${allProversRequiredForStartReady}`);
                } else {
                    socket.emit('error', { message: 'Cannot change ready status in current room state.' });
                }
            });

            socket.on('start-game', (data) => {
                const { roomId } = data;
                const room = gameRooms.get(roomId);
                
                if (!room) {
                    return socket.emit('error', { message: 'Room not found.' });
                }
                if (socket.id !== room.hostSocketId) {
                    return socket.emit('error', { message: 'Only the host can start the game.' });
                }
                if (room.gameState === 'active') {
                    return socket.emit('error', { message: 'Game already active.' });
                }
                
                let canStart = false;
                if (room.mode === 'vs') {
                    canStart = room.provers.size === 2 && room.allProversReady();
                    if (!canStart) {
                        return socket.emit('error', { message: 'VS Mode requires exactly 2 ready provers to start.' });
                    }
                } else if (room.mode === 'multiprover') {
                    canStart = room.provers.size >= 3 && room.allProversReady();
                    if (!canStart) {
                        return socket.emit('error', { message: 'Multiprover requires at least 3 ready provers to start.' });
                    }
                } else {
                     return socket.emit('error', { message: 'Invalid game mode for starting.' });
                }


                if (room.startGame()) {
                    io.to(roomId).emit('game-started', {
                        timeRemaining: room.getTimeRemaining(),
                        activeChallenges: room.activeChallenges,
                        initialLeaderboard: room.getLeaderboard()
                    });
                    console.log(`Host ${socket.prover.provername} started game in room ${roomId}.`);
                } else {
                    socket.emit('error', { message: 'Failed to start game. Check room state.' });
                }
            });

            socket.on('submit-proof', (data) => {
                const { roomId, selectedNodes } = data;
                const room = gameRooms.get(roomId);

                if (room && room.gameState === 'active') {
                    const result = room.submitProof(socket.id, selectedNodes);
                    socket.emit('proof-submitted', {
                        provername: socket.prover.provername,
                        isCorrect: result.isCorrect,
                        message: result.message,
                        provedStyleId: result.provedStyleId,
                        selectedNodes: result.selectedNodes
                    });
                } else {
                    socket.emit('error', { message: 'Cannot submit proof. Game not active or room not found.' });
                }
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
        });

        // Start the server only after MongoDB connection is established
        server.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });

    } catch (error) {
        console.error('Failed to connect to MongoDB and start server:', error);
        process.exit(1); // Exit if essential services cannot start
    }
})(); // Immediately invoke the async function
