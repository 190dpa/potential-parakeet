// index.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();

// Compatibilidade fetch no Node.js (CJS)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Pasta pública (inclui/uploads)
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Certifique-se que a pasta existe
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// armazenamento de multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.random().toString(36).slice(2,8)}${ext}`;
    cb(null, name);
  }
});
const upload = multer({ storage });

// CONFIG — substitua mainWebhookURL/messageId se quiser usar o webhook principal para o embed global
const mainWebhookURL = 'https://discord.com/api/webhooks/1430367755839868938/tM2Vrs_oi4_Ed4V_bOfEJQmpZPngVcYmvodDaGXWva4aIlkehnoiORkN7KITE6_A5jqM'; // opcional
let mainMessageId = '1430373050779697288'; // se quiser editar um embed existente, coloque aqui; ou use /set-message-id

// Estoque padrão (será carregado do stock.json quando existente)
let stock = [
  { id: "TOMATRIO", name: "TOMATRIO", emoji: "🍅", quantity: 202, price: 0.50, max: 300 },
  { id: "MANGO", name: "MANGO", emoji: "🥭", quantity: 260, price: 0.70, max: 300 },
  { id: "MR_CARROT", name: "MR CARROT", emoji: "🥕", quantity: 74, price: 0.40, max: 150 },
  { id: "PLANTA", name: "PLANTA (100k ~ 500k DPS)", emoji: "🌱", quantity: 12, price: 7.50, max: 20 }
];

const STOCK_FILE = path.join(__dirname, 'stock.json');

// load stock.json if exists
if (fs.existsSync(STOCK_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(STOCK_FILE));
    // merge to keep default fields if new
    stock = stock.map(item => {
      const found = saved.find(s => s.id === item.id);
      return found ? { ...item, quantity: found.quantity, price: found.price } : item;
    });
    // include any extra saved items not in defaults
    saved.forEach(s => {
      if (!stock.find(i => i.id === s.id)) stock.push(s);
    });
  } catch (e) {
    console.error('Erro ao ler stock.json:', e);
  }
}

// helper: save stock
function saveStockToFile() {
  fs.writeFileSync(STOCK_FILE, JSON.stringify(stock, null, 2));
}

// ---------- endpoints API ---------- //

// Get stock (front-end)
app.get('/get-stock', (req, res) => {
  res.json(stock);
});

// Add new fruit (creates entry in stock.json and returns updated list)
app.post('/add-fruit', (req, res) => {
  const { id, name, emoji, price, quantity, max } = req.body;
  if (!id || !name) return res.status(400).json({ status: 'error', message: 'id e name obrigatórios' });

  if (stock.find(s => s.id === id)) {
    return res.status(400).json({ status: 'error', message: 'ID já existe' });
  }

  const item = {
    id: String(id).toUpperCase().replace(/\s+/g, '_'),
    name: name.toUpperCase(),
    emoji: emoji || '',
    price: Number(price) || 0,
    quantity: Number(quantity) || 0,
    max: Number(max) || (Number(quantity) || 100)
  };

  stock.push(item);
  saveStockToFile();
  return res.json({ status: 'success', stock, item });
});

// Update stock/prices (from panel)
app.post('/update-stock', (req, res) => {
  const newStock = req.body; // keys like TOMATRIO_quantity, TOMATRIO_price
  stock = stock.map(it => {
    const qk = `${it.id}_quantity`;
    const pk = `${it.id}_price`;
    return {
      ...it,
      quantity: newStock[qk] !== undefined ? parseInt(newStock[qk]) : it.quantity,
      price: newStock[pk] !== undefined ? parseFloat(newStock[pk]) : it.price
    };
  });
  saveStockToFile();
  // optionally update main embed if mainMessageId & mainWebhookURL configured
  if (mainWebhookURL && mainMessageId) updateMainEmbed().catch(err => console.error('Erro updateMainEmbed:', err));
  res.json({ status: 'success', stock });
});

// Set which message id to read/update for main embed
app.post('/set-message-id', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ status: 'error', message: 'id requerido' });
  mainMessageId = id;
  // try fetch to populate stock from that embed
  try {
    await fetchSelectedMessage();
    res.json({ status: 'success', message: 'messageId setado', mainMessageId, stock });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'erro ao ler mensagem', err: String(err) });
  }
});

// Deliveries: create delivery (with optional file upload)
// Fields expected: webhook (delivery webhook URL), mention (string), itemId, quantity, note (optional)
// multipart/form-data with file field 'photo' (optional)
app.post('/deliver', upload.single('photo'), async (req, res) => {
  try {
    const { webhook, mention, itemId, quantity, note } = req.body;
    if (!webhook) return res.status(400).json({ status: 'error', message: 'webhook de entrega requerido' });
    if (!itemId) return res.status(400).json({ status: 'error', message: 'itemId requerido' });

    const item = stock.find(s => s.id === itemId);
    if (!item) return res.status(400).json({ status: 'error', message: 'item não encontrado' });

    const qty = Number(quantity) || 1;

    // save photo URL if uploaded
    let photoUrl = null;
    if (req.file) {
      photoUrl = `${getServerBaseUrl(req)}/uploads/${req.file.filename}`;
    }

    // build embed payload for delivery
    const embed = {
      title: '📦 Entrega Confirmada',
      color: 3066993,
      thumbnail: photoUrl ? { url: photoUrl } : undefined,
      fields: [
        { name: 'Destinatário', value: mention || 'Não informado', inline: true },
        { name: 'Produto', value: `${item.emoji} ${item.name}`, inline: true },
        { name: 'Quantidade', value: String(qty), inline: true },
        { name: 'Preço Unit.', value: `R$${item.price.toFixed(2)}`, inline: true },
      ],
      description: note ? `${note}` : undefined,
      footer: { text: 'DOLLYA STORE — Entrega' }
    };

    // send to provided webhook
    const body = {
      username: 'DOLLYA - Entregas',
      avatar_url: '', // opcional
      embeds: [embed]
    };

    const resWebhook = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    // save delivery log locally
    const deliveriesFile = path.join(__dirname, 'deliveries.json');
    let deliveries = [];
    if (fs.existsSync(deliveriesFile)) {
      try { deliveries = JSON.parse(fs.readFileSync(deliveriesFile)); } catch(e){ deliveries = []; }
    }
    const deliveryRecord = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      mention: mention || null,
      itemId,
      itemName: item.name,
      quantity: qty,
      photoUrl,
      webhookSent: resWebhook.ok,
      webhookStatus: resWebhook.status
    };
    deliveries.unshift(deliveryRecord);
    fs.writeFileSync(deliveriesFile, JSON.stringify(deliveries, null, 2));

    res.json({ status: 'success', delivery: deliveryRecord, webhookStatus: resWebhook.status });
  } catch (err) {
    console.error('Erro em /deliver:', err);
    res.status(500).json({ status: 'error', message: String(err) });
  }
});

// Get deliveries history
app.get('/get-deliveries', (req, res) => {
  const deliveriesFile = path.join(__dirname, 'deliveries.json');
  let deliveries = [];
  if (fs.existsSync(deliveriesFile)) {
    try { deliveries = JSON.parse(fs.readFileSync(deliveriesFile)); } catch(e){ deliveries = []; }
  }
  res.json(deliveries);
});

// Serve frontend
app.use(express.static('public'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- helper functions ---------- //

// get base url from request
function getServerBaseUrl(req) {
  // If behind proxy, you might want to use X-Forwarded-Proto/header; this is a simple approach
  const host = req.get('host');
  const proto = req.protocol;
  return `${proto}://${host}`;
}

// generate main embed from stock (if you want to update the main store embed)
function generateMainEmbed() {
  return {
    username: "DOLLYA VS BRAINROTS [PREÇOS]",
    avatar_url: "", // optional
    embeds: [{
      title: "🧠 DOLLYA STORE | TABELA DE PREÇOS",
      color: 16753920,
      fields: stock.map(item => ({
        name: `${item.emoji} ${item.name}`,
        value: `**Preço:** R$${item.price.toFixed(2)}\n**Estoque:** ${item.quantity > 0 ? item.quantity : 'ESGOTADO'}`,
        inline: true
      })),
      footer: { text: '🛒 DOLLYA STORE' }
    }]
  };
}

// update the main embed (if configured)
async function updateMainEmbed() {
  if (!mainWebhookURL || !mainMessageId) {
    console.log('mainWebhookURL ou mainMessageId não configurados; pulando updateMainEmbed.');
    return;
  }
  try {
    await fetch(`${mainWebhookURL}/messages/${mainMessageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(generateMainEmbed())
    });
    console.log('Main embed atualizado.');
  } catch (err) {
    console.error('Erro ao atualizar main embed:', err);
  }
}

// read selected message to populate stock (if you used a message to store stock)
async function fetchSelectedMessage() {
  if (!mainWebhookURL || !mainMessageId) {
    console.log('mainWebhookURL/mainMessageId não configurados para leitura.');
    return;
  }
  try {
    const res = await fetch(`${mainWebhookURL}/messages/${mainMessageId}`);
    const data = await res.json();
    if (data && data.embeds && data.embeds.length > 0) {
      const fields = data.embeds[0].fields || [];
      stock = stock.map(item => {
        const field = fields.find(f => f.name.includes(item.name));
        if (!field) return item;
        const cleaned = String(field.value).replace(/\*\*/g, '');
        const matchQty = cleaned.match(/Estoque:\s*([0-9]+|ESGOTADO)/i);
        const matchPrice = cleaned.match(/Preço:\s*R\$([\d,.]+)/i);
        return {
          ...item,
          quantity: matchQty ? (matchQty[1].toUpperCase() === 'ESGOTADO' ? 0 : parseInt(matchQty[1])) : item.quantity,
          price: matchPrice ? parseFloat(matchPrice[1].replace(',', '.')) : item.price
        };
      });
      saveStockToFile();
      console.log('Stock populado a partir da mensagem selecionada.');
    }
  } catch (err) {
    console.error('Erro ao buscar mensagem selecionada:', err);
  }
}

// ---------- start server ---------- //
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  // se mainMessageId configurado, tenta popular a partir do Discord
  if (mainWebhookURL && mainMessageId) await fetchSelectedMessage();
});
