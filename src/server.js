const express = require('express');
const mongoose = require('mongoose');
const { Session } = require('./models');

// Import Controllers and Functions
const { restoreSessions } = require('./services/whatsapp');
const sessionRoutes = require('./routes/sessionRoutes');
const messageRoutes = require('./routes/messageRoutes');
const businessRoutes = require('./routes/businessRoutes');
const infoRoutes = require('./routes/infoRoutes'); // Make sure you have this file from our previous steps

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connect to MongoDB and Auto-Restore Sessions
mongoose.connect(process.env.MONGO_URL)
    .then(async () => {
        console.log('✅ Connected to MongoDB');
        await restoreSessions();
    })
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Global Auth Guard Middleware
const authGuard = async (req, res, next) => {
    const { session } = req.params;
    
    // Skip auth requirement for generating a new token
    if (req.path.includes('generate-token')) return next();

    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;

    const sessionDb = await Session.findOne({ sessionId: session });
    
    if (!sessionDb) {
        return res.status(401).json({ error: 'Unauthorized. Session not found.', status: 'error' });
    }
    if (sessionDb.token !== token) {
        return res.status(401).json({ error: 'Unauthorized. Token mismatch.', status: 'error' });
    }
    
    req.sessionDb = sessionDb;
    next();
};

// Apply Middleware
app.use('/api/:session', authGuard);

// Register Modular Routes
app.use('/api/:session', sessionRoutes);
app.use('/api/:session', messageRoutes);
app.use('/api/:session', businessRoutes);
app.use('/api/:session', infoRoutes);

// Health Check
app.get('/', (req, res) => res.send('🚀 WhatsApp Modular API Running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));