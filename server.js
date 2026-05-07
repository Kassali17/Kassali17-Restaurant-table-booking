const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
const port = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Default Route
app.get('/', (req, res) => {
    res.redirect('/start.html');
});

// Initialize SQLite Database
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initDatabase();
    }
});

// Create tables if they don't exist
function initDatabase() {
    db.serialize(() => {
        // Users Table
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            email TEXT UNIQUE,
            phone TEXT,
            password TEXT
        )`);

        // Bookings Table
        db.run(`CREATE TABLE IF NOT EXISTS bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            name TEXT,
            phone TEXT,
            table_id TEXT,
            guests INTEGER,
            booking_datetime TEXT,
            status TEXT DEFAULT 'Confirmed',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (!err) {
                db.run(`ALTER TABLE bookings ADD COLUMN status TEXT DEFAULT 'Confirmed'`, (err) => {});
            }
        });

        // Orders Table (Takeaway & Delivery)
        db.run(`CREATE TABLE IF NOT EXISTS orders (
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
        )`, (err) => {
            if (!err) {
                // Add columns if they were missing (for existing databases)
                db.run(`ALTER TABLE orders ADD COLUMN address TEXT`, (err) => {});
                db.run(`ALTER TABLE orders ADD COLUMN payment_method TEXT`, (err) => {});
                db.run(`ALTER TABLE orders ADD COLUMN transaction_id TEXT`, (err) => {});
                db.run(`ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT 'Pending'`, (err) => {});
            }
        });

        // Order Items Table
        db.run(`CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            item_name TEXT,
            quantity INTEGER,
            price INTEGER,
            FOREIGN KEY (order_id) REFERENCES orders(id)
        )`);
        
        console.log('Database tables initialized.');
    });
}

// ==========================================
// API ROUTES
// ==========================================

// 1. REGISTER USER
app.post('/api/register', (req, res) => {
    const { name, email, phone, password } = req.body;
    
    // Hash password
    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(password, salt);
    
    db.run(
        `INSERT INTO users (name, email, phone, password) VALUES (?, ?, ?, ?)`,
        [name, email, phone, hashedPassword],
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(400).json({ error: "Email already registered." });
                }
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, message: "Registration successful!", userId: this.lastID });
        }
    );
});

// 2. LOGIN USER
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    
    db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(401).json({ error: "Invalid email or password." });
        
        // Check password
        const validPassword = bcrypt.compareSync(password, user.password);
        if (!validPassword) return res.status(401).json({ error: "Invalid email or password." });
        
        const { password: _, ...userWithoutPassword } = user;
        res.json({ success: true, message: "Login successful!", user: userWithoutPassword });
    });
});

// 3. BOOK A TABLE
app.post('/api/bookings', (req, res) => {
    const { name, phone, table_id, guests, booking_datetime } = req.body;
    
    db.run(
        `INSERT INTO bookings (name, phone, table_id, guests, booking_datetime, status) VALUES (?, ?, ?, ?, ?, 'Confirmed')`,
        [name, phone, table_id, guests, booking_datetime],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            // Return realistic booking number using the ID
            const bookingRef = 'BKG-' + String(this.lastID).padStart(4, '0');
            res.json({ success: true, bookingRef: bookingRef });
        }
    );
});

// 4. SUBMIT ORDER
app.post('/api/orders', (req, res) => {
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
        db.get(`SELECT id FROM orders WHERE transaction_id = ?`, [tid], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (row) {
                console.warn(`Blocked duplicate ID: ${tid}`);
                return res.status(400).json({ 
                    error: "This Transaction ID has already been used. Please verify your payment or contact support." 
                });
            }
            // All checks passed — order awaits admin confirmation before being placed
            proceedToInsert('Pending Admin Verification', 'Awaiting Confirmation');
        });
    } else {
        // COD: no transaction ID needed — order is placed directly
        proceedToInsert('Pending (COD)', 'Pending');
    }

    function proceedToInsert(paymentStatus, orderStatus) {
        db.run('BEGIN TRANSACTION');
        
        db.run(
            `INSERT INTO orders (order_type, pickup_time, address, payment_method, transaction_id, payment_status, subtotal, total, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [order_type, pickup_time, address, payment_method, tid || 'N/A', paymentStatus, subtotal, total, orderStatus],
            function(err) {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: err.message });
                }
                
                const orderId = this.lastID;
                const orderRef = 'ORD-' + String(orderId).padStart(4, '0');
                
                const stmt = db.prepare(`INSERT INTO order_items (order_id, item_name, quantity, price) VALUES (?, ?, ?, ?)`);
                for (let item of items) {
                    stmt.run([orderId, item.name, item.qty, item.price]);
                }
                stmt.finalize();
                
                db.run('COMMIT');
                console.log(`Order ${orderRef} placed. Method: ${payment_method}, Status: ${paymentStatus}`);
                res.json({ success: true, orderRef: orderRef, paymentStatus: paymentStatus });
            }
        );
    }
});

// 5. GET ADMIN DATA
app.get('/api/admin/data', (req, res) => {
    db.all(`SELECT id, name, email, phone FROM users ORDER BY id DESC`, [], (err, users) => {
        if (err) return res.status(500).json({ error: err.message });

        db.all(`SELECT * FROM bookings ORDER BY created_at DESC`, [], (err, bookings) => {
            if (err) return res.status(500).json({ error: err.message });
            
            db.all(`SELECT * FROM orders ORDER BY created_at DESC`, [], (err, orders) => {
                if (err) return res.status(500).json({ error: err.message });
                
                db.all(`SELECT * FROM order_items`, [], (err, items) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, users, bookings, orders, items });
                });
            });
        });
    });
});

// 5b. GET ADMIN STATS
app.get('/api/admin/stats', (req, res) => {
    const stats = {};
    
    db.get(`SELECT COUNT(*) as count FROM users`, (err, row) => {
        stats.totalUsers = row ? row.count : 0;
        
        db.get(`SELECT COUNT(*) as count, SUM(total) as revenue FROM orders WHERE status != 'Cancelled'`, (err, row) => {
            stats.totalOrders = row ? row.count : 0;
            stats.totalRevenue = row ? (row.revenue || 0) : 0;
            
            db.get(`SELECT COUNT(*) as count FROM bookings WHERE status != 'Cancelled'`, (err, row) => {
                stats.totalBookings = row ? row.count : 0;
                
                // Get Most Popular Dish
                db.get(`
                    SELECT item_name, SUM(quantity) as qty 
                    FROM order_items i 
                    JOIN orders o ON i.order_id = o.id 
                    WHERE o.status != 'Cancelled'
                    GROUP BY item_name 
                    ORDER BY qty DESC LIMIT 1
                `, (err, row) => {
                    stats.popularDish = row ? row.item_name : 'N/A';
                    res.json({ success: true, stats });
                });
            });
        });
    });
});

// 5c. GET FOOD SALES ANALYTICS
app.get('/api/admin/food-sales', (req, res) => {
    const query = `
        SELECT 
            i.item_name, 
            SUM(i.quantity) as total_sold, 
            SUM(i.quantity * i.price) as revenue 
        FROM order_items i 
        JOIN orders o ON i.order_id = o.id 
        WHERE o.status != 'Cancelled' 
        GROUP BY i.item_name 
        ORDER BY total_sold DESC
    `;
    
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, sales: rows });
    });
});

// 6. UPDATE STATUS (ADMIN)
app.post('/api/admin/update-status', (req, res) => {
    const { type, id, status } = req.body;
    const table = type === 'order' ? 'orders' : 'bookings';
    
    db.run(`UPDATE ${table} SET status = ? WHERE id = ?`, [status, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.post('/api/admin/confirm-payment', (req, res) => {
    const { id } = req.body;
    db.run(`UPDATE orders SET payment_status = 'Paid', status = 'Preparing' WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// 5d. VERIFY/FINALIZE PAYMENT STATUS
app.post('/api/orders/verify', (req, res) => {
    const { orderRef } = req.body;
    if (!orderRef) return res.status(400).json({ error: "Missing order reference" });

    // Extract ID from ref (e.g., ORD-0005 -> 5)
    const id = parseInt(orderRef.split('-')[1]);

    db.run(`UPDATE orders SET payment_status = 'Paid' WHERE id = ? AND payment_status = 'Awaiting Payment'`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// 7. TRACK ORDER (CUSTOMER)
app.get('/api/track/:ref', (req, res) => {
    const ref = req.params.ref;
    const id = parseInt(ref.split('-')[1]);
    
    db.get(`SELECT * FROM orders WHERE id = ?`, [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Order not found" });
        
        db.all(`SELECT * FROM order_items WHERE order_id = ?`, [id], (err, items) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, order: row, items: items });
        });
    });
});

// Start Server
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
    console.log(`Serving static files from /public`);
});
