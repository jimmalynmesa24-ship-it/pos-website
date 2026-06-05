import express from 'express';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = 3000;

const TELEGRAM_BOT_TOKEN = '8632068140:AAEuRFSco9dLeimJkbJp81nmFlbdUKiLEkQ';
const GROQ_KEY = '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';
const TELEGRAM_CHAT_ID = '6710602917';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database('./sari_sari.db', (err) => {
  if (err) console.error('DB Error:', err.message);
  else console.log('Connected to SQLite');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS products ( id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price REAL NOT NULL, stock INTEGER DEFAULT 0, unit TEXT DEFAULT 'pcs', code TEXT )`);
  db.run(`CREATE TABLE IF NOT EXISTS transactions ( id INTEGER PRIMARY KEY AUTOINCREMENT, items TEXT NOT NULL, total REAL NOT NULL, cash REAL NOT NULL, change REAL NOT NULL, date DATETIME DEFAULT CURRENT_TIMESTAMP )`);
});

async function askAI(question, posData) {
  try {
    const prompt = `You are an assistant for a Sari-Sari Store POS. Current data: Total sales ₱${posData.sales || 0}, Transactions today: ${posData.txns || 0}, Low stock items: ${posData.lowStock || 0} Question: ${question} Answer in 2-3 short sentences only. Friendly professional tone.`;
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 150,
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${GROQ_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    return res.data.choices[0].message.content;
  } catch(e) {
    console.log('Groq Error:', e.response?.data?.error?.message || e.message);
    return "AI error. Check Groq key at https://console.groq.com/keys";
  }
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 }
  }
});

bot.on('polling_error', (error) => {
  console.log('Polling error:', error.code);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if(!text) return;
  if(text === '/start') {
  bot.sendMessage(chatId, `Hello. I am your POS AI Assistant.\n\nI can help you with:\nToday Sales\nLow stock items\nSummary\n\nWhat would you like to check?`);
  return;
}
  bot.sendChatAction(chatId, 'typing');
  db.get('SELECT SUM(total) as sales, COUNT(*) as txns FROM transactions WHERE date(date)=date("now")', (err, row) => {
    db.get('SELECT COUNT(*) as lowStock FROM products WHERE stock < 5', (err2, lowRow) => {
      const data = {
        sales: row?.sales || 0,
        txns: row?.txns || 0,
        LowStock: lowRow?.lowStock || 0
      };
      askAI(text, data).then(reply => {
        bot.sendMessage(chatId, reply);
      }).catch(() => {
        bot.sendMessage(chatId, 'Error getting AI response.');
      });
    });
  });
});

app.get('/api/products', (req, res) => {
  db.all('SELECT * FROM products ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/products', (req, res) => {
  const { name, price, stock, unit, code } = req.body;
  if (!name || price === undefined) {
    return res.status(400).json({ error: 'Name and Price required' });
  }
  db.run(
    'INSERT INTO products (name, price, stock, unit, code) VALUES (?, ?, ?, ?, ?)',
    [name, price, stock || 0, unit || 'pcs', code || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, name, price: Number(price), stock: stock || 0, unit: unit || 'pcs', code: code || '' });
    }
  );
});

app.put('/api/products/:id', (req, res) => {
  const { name, price, stock, unit, code } = req.body;
  db.run(
    'UPDATE products SET name=?, price=?, stock=?, unit=?, code=? WHERE id=?',
    [name, price, stock, unit, code, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.delete('/api/products/:id', (req, res) => {
  db.run('DELETE FROM products WHERE id=?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.post('/api/transactions', async (req, res) => {
  const { items, total, cash, change } = req.body;
  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }
  db.run(
    'INSERT INTO transactions (items, total, cash, change) VALUES (?, ?, ?, ?)',
    [JSON.stringify(items), total, cash, change],
    async function(err) {
      if (err) return res.status(500).json({ error: err.message });
      const transactionId = this.lastID;
      const newlyOutOfStock = [];
      const promises = items.map(item => {
        return new Promise((resolve, reject) => {
          db.get('SELECT stock, name, code FROM products WHERE id = ?', [item.id], (err, row) => {
            if (err) return reject(err);
            if (!row) return resolve();
            const oldStock = row.stock;
            const newStock = Math.max(0, oldStock - item.qty);
            db.run('UPDATE products SET stock = ? WHERE id = ?', [newStock, item.id], (err) => {
              if (err) return reject(err);
              if (oldStock > 0 && newStock === 0) {
                newlyOutOfStock.push({ name: row.name, code: row.code });
              }
              resolve();
            });
          });
        });
      });
      await Promise.all(promises);
      if (newlyOutOfStock.length > 0) {
        const grouped = {};
        newlyOutOfStock.forEach(p => {
          if (!grouped[p.code]) {
            grouped[p.code] = { name: p.name, code: p.code };
          }
        });
        const message = `OUT OF STOCK ALERT\n\nProducts:\n${Object.values(grouped).map(p => `${p.name} - ${p.code}`).join('\n')}\n\nPlease restock products.`;
        if (TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN !== 'ILAGAY_TELEGRAM_TOKEN_MO_DITO') {
          try {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
              chat_id: TELEGRAM_CHAT_ID,
              text: message
            });
            console.log('Alert sent:', Object.values(grouped).map(p => p.name).join(', '));
          } catch (e) {
            console.error('Telegram error:', e.response?.data?.description);
          }
        }
      }
      res.json({ id: transactionId, date: new Date().toISOString(), items, total, cash, change });
    }
  );
});

app.get('/api/transactions', (req, res) => {
  db.all('SELECT * FROM transactions ORDER BY date DESC LIMIT 200', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => ({ ...r, items: JSON.parse(r.items) })));
  });
});

app.get('/api/backup', (req, res) => {
  db.all('SELECT * FROM products', [], (err, products) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all('SELECT * FROM transactions ORDER BY date DESC', [], (err, transactions) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ products, transactions: transactions.map(t => ({...t, items: JSON.parse(t.items)})), date: new Date().toISOString() });
    });
  });
});

app.post('/api/reset', (req, res) => {
  db.serialize(() => {
    db.run('DELETE FROM transactions');
    db.run('DELETE FROM products');
    db.run('DELETE FROM sqlite_sequence WHERE name="products"');
    db.run('DELETE FROM sqlite_sequence WHERE name="transactions"');
    res.json({ success: true });
  });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`Telegram Bot running! Type /start in your bot`);
  console.log(`Stop server: Ctrl + C`);
});