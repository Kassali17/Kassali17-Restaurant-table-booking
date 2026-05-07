const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');
db.all('SELECT id, payment_method, transaction_id FROM orders ORDER BY id DESC LIMIT 5', (err, rows) => {
    if (err) throw err;
    console.log(JSON.stringify(rows, null, 2));
    db.close();
});
