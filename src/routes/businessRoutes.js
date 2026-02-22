const express = require('express');
const { getSession } = require('../services/whatsapp');
const router = express.Router({ mergeParams: true });

const requireSock = (req, res, next) => {
    req.sock = getSession(req.params.session);
    if (!req.sock) return res.status(400).json({ error: 'Disconnected. Session is not active.' });
    next();
};

router.use(requireSock);

// Helper to safely format the Business JID (removes multi-device session tags)
const getBusinessJid = (sock) => sock.user.id.split(':')[0] + '@s.whatsapp.net';

// ==========================================
// 🛍️ PRODUCTS API
// ==========================================

// 1. Get All Products (Catalog)
router.get('/products', async (req, res) => {
    try {
        const products = await req.sock.getCatalog({ jid: getBusinessJid(req.sock) });
        res.json({ status: 'success', response: products });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. View Product Details (Single Product)
router.get('/product/:productId', async (req, res) => {
    try {
        // Baileys doesn't have a direct "getProductById" method, so we fetch the catalog and filter
        const catalog = await req.sock.getCatalog({ jid: getBusinessJid(req.sock) });
        const product = catalog.products.find(p => p.id === req.params.productId);
        
        if (!product) return res.status(404).json({ status: 'error', message: 'Product not found in catalog' });
        res.json({ status: 'success', response: product });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. Create Product
router.post('/product', async (req, res) => {
    const { name, description, price, url, images } = req.body;
    try {
        const result = await req.sock.productCreate({
            name,
            description,
            priceAmount1000: price * 1000, // WhatsApp calculates price in thousands
            url,
            images: images // Array of Base64 or URLs mapped to Baileys Media
        });
        res.json({ status: 'success', response: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. Edit / Update a Product
router.put('/product/:productId', async (req, res) => {
    const { name, description, price, url, images, isHidden } = req.body;
    try {
        const result = await req.sock.productUpdate(req.params.productId, {
            name,
            description,
            priceAmount1000: price ? price * 1000 : undefined,
            url,
            images,
            isHidden 
        });
        res.json({ status: 'success', response: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. Hide a Product
router.post('/product/:productId/hide', async (req, res) => {
    try {
        const result = await req.sock.productUpdate(req.params.productId, { isHidden: true });
        res.json({ status: 'success', message: 'Product hidden successfully', response: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 6. Unhide a Product
router.post('/product/:productId/unhide', async (req, res) => {
    try {
        const result = await req.sock.productUpdate(req.params.productId, { isHidden: false });
        res.json({ status: 'success', message: 'Product is now visible', response: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 7. Delete Product
router.delete('/product/:productId', async (req, res) => {
    try {
        const result = await req.sock.productDelete([req.params.productId]);
        res.json({ status: 'success', response: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ==========================================
// 🗂️ COLLECTIONS API
// ==========================================

// 8. Get All Collections
router.get('/collections', async (req, res) => {
    try {
        const collections = await req.sock.getCollections(getBusinessJid(req.sock));
        res.json({ status: 'success', response: collections });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 9. View Products within a specific Collection
router.get('/collection/:collectionId/products', async (req, res) => {
    try {
        const collectionsData = await req.sock.getCollections(getBusinessJid(req.sock));
        const collection = collectionsData.collections.find(c => c.id === req.params.collectionId);
        
        if (!collection) return res.status(404).json({ status: 'error', message: 'Collection not found' });
        
        // The collection object contains a 'products' array natively
        res.json({ status: 'success', response: collection.products });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 10. Create Collection (Unsupported by WA Web Protocol)
router.post('/collection', async (req, res) => {
    res.status(501).json({ 
        status: 'error', 
        message: 'The WhatsApp Web API (Baileys) does not support creating collections. Please create collections via the WhatsApp Business mobile app.' 
    });
});

// 11. Add Product to Collection (Unsupported by WA Web Protocol)
router.post('/collection/:collectionId/product', async (req, res) => {
    res.status(501).json({ 
        status: 'error', 
        message: 'The WhatsApp Web API (Baileys) does not support adding products to collections. Please manage this via the WhatsApp Business mobile app.' 
    });
});

// 12. Remove Product from Collection (Unsupported by WA Web Protocol)
router.delete('/collection/:collectionId/product/:productId', async (req, res) => {
    res.status(501).json({ 
        status: 'error', 
        message: 'The WhatsApp Web API (Baileys) does not support removing products from collections. Please manage this via the WhatsApp Business mobile app.' 
    });
});

module.exports = router;