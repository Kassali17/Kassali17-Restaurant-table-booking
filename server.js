const express = require('express');
const { createClient } = require('@libsql/client');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Default Route
app.get('/', (req, res) => {
    res.redirect('/start.html');
});

// Initialize Local SQLite Database
// NOTE: On Vercel, /tmp is the only writable directory.
// Data stored here is TEMPORARY and will be lost when the function restarts.
const db = createClient({
    url: process.env.VERCEL ? 'file:/tmp/local.db' : 'file:local.db',
});


// Create tables if they don't exist
async function initDatabase() {
    await db.batch([
        `CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            email TEXT UNIQUE,
            phone TEXT,
            password TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            name TEXT,
            phone TEXT,
            table_id TEXT,
            guests INTEGER,
            booking_datetime TEXT,
            status TEXT DEFAULT 'Confirmed',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            order_type TEXT,
            pickup_time TEXT,
            address TEXT,
            payment_method TEXT,
            transaction_id TEXT,
            payment_status TEXT DEFAULT 'Pending',
            subtotal INTEGER,
            total INTEGER,
            status TEXT DEFAULT 'Pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            item_name TEXT,
            quantity INTEGER,
            price INTEGER,
            FOREIGN KEY (order_id) REFERENCES orders(id)
        )`
    ], 'write');
    console.log('Database tables initialized.');
}

// Lazy initialization for serverless (Vercel cold starts)
let dbReady = false;
async function ensureDb() {
    if (!dbReady) {
        await initDatabase();
        dbReady = true;
    }
}

// Ensure DB is ready before handling any API request
app.use('/api', async (req, res, next) => {
    try {
        await ensureDb();   
        next();
    } catch (err) {
        console.error('DB init error:', err);
        res.status(500).json({ error: 'Database initialization failed' });
    }
});

// ==========================================
// API ROUTES
// ==========================================

// 1. REGISTER USER
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, phone, password } = req.body;
        
        // Hash password
        const salt = bcrypt.genSaltSync(10);
        const hashedPassword = bcrypt.hashSync(password, salt);
        
        const result = await db.execute({
            sql: `INSERT INTO users (name, email, phone, password) VALUES (?, ?, ?, ?)`,
            args: [name, email, phone, hashedPassword]
        });
        
        res.json({ success: true, message: "Registration successful!", userId: Number(result.lastInsertRowid) });
    } catch (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: "Email already registered." });
        }
        res.status(500).json({ error: err.message });
    }
});

// 2. LOGIN USER
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        const result = await db.execute({
            sql: `SELECT * FROM users WHERE email = ?`,
            args: [email]
        });
        const user = result.rows[0];
        
        if (!user) return res.status(401).json({ error: "Invalid email or password." });
        
        // Check password
        const validPassword = bcrypt.compareSync(password, user.password);
        if (!validPassword) return res.status(401).json({ error: "Invalid email or password." });
        
        const { password: _, ...userWithoutPassword } = user;
        res.json({ success: true, message: "Login successful!", user: userWithoutPassword });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. BOOK A TABLE
app.post('/api/bookings', async (req, res) => {
    try {
        const { name, phone, table_id, guests, booking_datetime } = req.body;
        
        const result = await db.execute({
            sql: `INSERT INTO bookings (name, phone, table_id, guests, booking_datetime, status) VALUES (?, ?, ?, ?, ?, 'Confirmed')`,
            args: [name, phone, table_id, guests, booking_datetime]
        });
        
        // Return realistic booking number using the ID
        const bookingRef = 'BKG-' + String(Number(result.lastInsertRowid)).padStart(4, '0');
        res.json({ success: true, bookingRef: bookingRef });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. SUBMIT ORDER
app.post('/api/orders', async (req, res) => {
    try {
        const { order_type, pickup_time, address, payment_method, transaction_id, subtotal, total, items } = req.body;
        
        // --- SERVER-SIDE VALIDATION ---
        console.log(`Verifying Order: Method=${payment_method}, Total=${total}, Subtotal=${subtotal}`);

        // STEP 0: Only allow known payment methods
        const allowedMethods = ['UPI', 'Credit/Debit Card', 'Cash on Delivery', 'Bank Transfer', 'Razorpay'];
        const isUPI = payment_method.startsWith('UPI');
        if (!allowedMethods.includes(payment_method) && !isUPI) {
            console.warn(`Blocked unknown payment method: ${payment_method}`);
            return res.status(400).json({ error: "Invalid payment method. Please choose UPI, Card, Cash on Delivery, or Razorpay." });
        }
        
        // STEP 1: Math Verification (Total = Sum of items)
        let calculatedSubtotal = 0;
        for (let item of items) {
            calculatedSubtotal += (Number(item.price) * Number(item.qty));
        }
        if (calculatedSubtotal != subtotal || total != calculatedSubtotal) {
            console.error(`Math Mismatch: Calculated=${calculatedSubtotal}, ClientSubtotal=${subtotal}, ClientTotal=${total}`);
            return res.status(400).json({ 
                error: `Security Alert: Payment amount mismatch! Expected ₹${calculatedSubtotal} but received ₹${total}.` 
            });
        }

        const isCOD = (payment_method === 'Cash on Delivery');
        const tid = String(transaction_id || '').trim();

        console.log(`Verifying Transaction ID: "${tid}" for Method: ${payment_method}`);

        // STEP 2: For UPI / Card — enforce a REAL transaction ID
        if (!isCOD) {
            // Must not be empty
            if (!tid) {
                console.warn('Blocked: Empty transaction ID for paid method.');
                return res.status(400).json({ error: "Payment not received. A valid Transaction ID / UTR is required to place this order." });
            }

            // Allow UPI-AUTO- IDs (new seamless flow), but still block placeholder CARD- IDs
            const isAutoUPI = tid.startsWith('UPI-AUTO-');
            if (!isAutoUPI && (/^UPI-\d+$/i.test(tid) || /^CARD-\d+$/i.test(tid))) {
                console.warn(`Blocked auto-generated placeholder ID: ${tid}`);
                return res.status(400).json({ error: "Please enter the actual Reference ID from your bank app. Auto-generated IDs are not accepted for cards." });
            }

            // Must not be on the blacklist of obviously fake values
            const fakePatterns = ['123456789012', '000000000000', '111111111111', '999999999999', 'test', 'dummy', 'fake'];
            if (!isAutoUPI && fakePatterns.includes(tid.toLowerCase())) {
                console.warn(`Blocked blacklisted ID: ${tid}`);
                return res.status(400).json({ error: "Invalid Transaction ID. Please provide a genuine UTR from your app." });
            }

            // Must be at least 8 characters (real UTRs are 12+ digits)
            if (tid.length < 8) {
                console.warn(`Blocked too-short ID: ${tid}`);
                return res.status(400).json({ error: "Transaction ID is too short. Please enter the full UTR number from your bank." });
            }

            // Check for duplicate transaction ID
            const dupCheck = await db.execute({
                sql: `SELECT id FROM orders WHERE transaction_id = ?`,
                args: [tid]
            });
            if (dupCheck.rows.length > 0) {
                console.warn(`Blocked duplicate ID: ${tid}`);
                return res.status(400).json({ 
                    error: "This Transaction ID has already been used. Please verify your payment or contact support." 
                });
            }
            // All checks passed — order awaits admin confirmation before being placed
            await insertOrder('Pending Admin Verification', 'Awaiting Confirmation');
        } else {
            // COD: no transaction ID needed — order is placed directly
            await insertOrder('Pending (COD)', 'Pending');
        }

        async function insertOrder(paymentStatus, orderStatus) {
            // Insert the order
            const orderResult = await db.execute({
                sql: `INSERT INTO orders (order_type, pickup_time, address, payment_method, transaction_id, payment_status, subtotal, total, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [order_type, pickup_time, address, payment_method, tid || 'N/A', paymentStatus, subtotal, total, orderStatus]
            });
            
            const orderId = Number(orderResult.lastInsertRowid);
            const orderRef = 'ORD-' + String(orderId).padStart(4, '0');
            
            // Batch insert order items
            if (items.length > 0) {
                const itemStatements = items.map(item => ({
                    sql: `INSERT INTO order_items (order_id, item_name, quantity, price) VALUES (?, ?, ?, ?)`,
                    args: [orderId, item.name, item.qty, item.price]
                }));
                await db.batch(itemStatements, 'write');
            }
            
            console.log(`Order ${orderRef} placed. Method: ${payment_method}, Status: ${paymentStatus}`);
            res.json({ success: true, orderRef: orderRef, paymentStatus: paymentStatus });
        }
    } catch (err) {
        console.error('Order error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 5. GET ADMIN DATA
app.get('/api/admin/data', async (req, res) => {
    try {
        const [usersResult, bookingsResult, ordersResult, itemsResult] = await Promise.all([
            db.execute('SELECT id, name, email, phone FROM users ORDER BY id DESC'),
            db.execute('SELECT * FROM bookings ORDER BY created_at DESC'),
            db.execute('SELECT * FROM orders ORDER BY created_at DESC'),
            db.execute('SELECT * FROM order_items')
        ]);
        
        res.json({ 
            success: true, 
            users: usersResult.rows, 
            bookings: bookingsResult.rows, 
            orders: ordersResult.rows, 
            items: itemsResult.rows 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5b. GET ADMIN STATS
app.get('/api/admin/stats', async (req, res) => {
    try {
        const [usersCount, ordersData, bookingsCount, popularDish] = await Promise.all([
            db.execute(`SELECT COUNT(*) as count FROM users`),
            db.execute(`SELECT COUNT(*) as count, SUM(total) as revenue FROM orders WHERE status != 'Cancelled'`),
            db.execute(`SELECT COUNT(*) as count FROM bookings WHERE status != 'Cancelled'`),
            db.execute(`
                SELECT item_name, SUM(quantity) as qty 
                FROM order_items i 
                JOIN orders o ON i.order_id = o.id 
                WHERE o.status != 'Cancelled'
                GROUP BY item_name 
                ORDER BY qty DESC LIMIT 1
            `)
        ]);
        
        const stats = {
            totalUsers: usersCount.rows[0] ? Number(usersCount.rows[0].count) : 0,
            totalOrders: ordersData.rows[0] ? Number(ordersData.rows[0].count) : 0,
            totalRevenue: ordersData.rows[0] ? Number(ordersData.rows[0].revenue || 0) : 0,
            totalBookings: bookingsCount.rows[0] ? Number(bookingsCount.rows[0].count) : 0,
            popularDish: popularDish.rows[0] ? popularDish.rows[0].item_name : 'N/A'
        };
        
        res.json({ success: true, stats });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5c. GET FOOD SALES ANALYTICS
app.get('/api/admin/food-sales', async (req, res) => {
    try {
        const result = await db.execute(`
            SELECT 
                i.item_name, 
                SUM(i.quantity) as total_sold, 
                SUM(i.quantity * i.price) as revenue 
            FROM order_items i 
            JOIN orders o ON i.order_id = o.id 
            WHERE o.status != 'Cancelled' 
            GROUP BY i.item_name 
            ORDER BY total_sold DESC
        `);
        
        res.json({ success: true, sales: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. UPDATE STATUS (ADMIN)
app.post('/api/admin/update-status', async (req, res) => {
    try {
        const { type, id, status } = req.body;
        const table = type === 'order' ? 'orders' : 'bookings';
        
        await db.execute({
            sql: `UPDATE ${table} SET status = ? WHERE id = ?`,
            args: [status, id]
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/confirm-payment', async (req, res) => {
    try {
        const { id } = req.body;
        await db.execute({
            sql: `UPDATE orders SET payment_status = 'Paid', status = 'Preparing' WHERE id = ?`,
            args: [id]
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5d. VERIFY/FINALIZE PAYMENT STATUS
app.post('/api/orders/verify', async (req, res) => {
    try {
        const { orderRef } = req.body;
        if (!orderRef) return res.status(400).json({ error: "Missing order reference" });

        // Extract ID from ref (e.g., ORD-0005 -> 5)
        const id = parseInt(orderRef.split('-')[1]);

        await db.execute({
            sql: `UPDATE orders SET payment_status = 'Paid' WHERE id = ? AND payment_status = 'Awaiting Payment'`,
            args: [id]
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. TRACK ORDER (CUSTOMER)
app.get('/api/track/:ref', async (req, res) => {
    try {
        const ref = req.params.ref;
        const id = parseInt(ref.split('-')[1]);
        
        const orderResult = await db.execute({
            sql: `SELECT * FROM orders WHERE id = ?`,
            args: [id]
        });
        const order = orderResult.rows[0];
        
        if (!order) return res.status(404).json({ error: "Order not found" });
        
        const itemsResult = await db.execute({
            sql: `SELECT * FROM order_items WHERE order_id = ?`,
            args: [id]
        });
        
        res.json({ success: true, order: order, items: itemsResult.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Only listen when running locally (not on Vercel)
if (!process.env.VERCEL) {
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });
}

// Export for Vercel serverless
module.exports = app;