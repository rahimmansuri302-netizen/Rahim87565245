
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

// अपनी UPI ID और Admin PIN यहाँ सेट करें (या Railway Variables में भी रख सकते हैं)
const UPI_ID = process.env.UPI_ID || 'yourname@okaxis';
const PAYEE_NAME = process.env.PAYEE_NAME || 'AK777';
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// डेमो / इन-मेमोरी डेटा (सर्वर रीस्टार्ट होने पर रीसेट हो सकता है; आगे DB जोड़ा जा सकता है)
const state = {
  balance: 1350.0,
  withdrawable: 0.0,
  deposits: [
    { id: 'DEP-1001', amount: 500, status: 'SUCCESS', createdAt: new Date().toISOString() },
    { id: 'DEP-1002', amount: 500, status: 'SUCCESS', createdAt: new Date().toISOString() }
  ],
  withdrawals: []
};

// स्टेटस / बैलेंस / हिस्ट्री / पेंडिंग रिक्वेस्ट्स
app.get('/api/state', (req, res) => {
  res.json({
    balance: state.balance,
    withdrawable: state.withdrawable,
    deposits: state.deposits,
    withdrawals: state.withdrawals
  });
});

// 1. Deposit: QR / UPI ऑर्डर बनाएं (तुरंत बैलेंस नहीं जुड़ेगा, कन्फ़र्म/अप्रूव होने पर जुड़ेगा)
app.post('/api/deposit/create', (req, res) => {
  const amount = Number(req.body.amount);
  if (!amount || amount < 10) {
    return res.status(400).json({ error: 'कम से कम INR 10 डालें' });
  }

  const orderId = 'ORD-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const upiLink = `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(PAYEE_NAME)}&am=${amount}&cu=INR&tn=${encodeURIComponent(orderId)}`;
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(upiLink)}`;

  const order = {
    orderId,
    amount,
    upiId: UPI_ID,
    upiLink,
    qrImageUrl,
    status: 'PENDING',
    utr: '',
    createdAt: new Date().toISOString()
  };

  state.deposits.unshift(order);
  res.json({ order });
});

// यूज़र द्वारा UTR / पेमेंट सबमिट करना (अभी भी PENDING रहेगा जब तक आप Approve न करें)
app.post('/api/deposit/submit-utr', (req, res) => {
  const { orderId, utr } = req.body;
  const order = state.deposits.find((d) => d.orderId === orderId);
  if (!order) {
    return res.status(404).json({ error: 'ऑर्डर नहीं मिला' });
  }
  order.utr = (utr || '').trim();
  order.status = 'AWAITING_APPROVAL';
  res.json({ message: 'पेमेंट डिटेल भेज दी गई है। एडमिन अप्रूवल के बाद बैलेंस जुड़ेगा।', order });
});

// 2. Withdrawal: यूज़र की विथड्रॉल रिक्वेस्ट बनाएं
app.post('/api/withdraw/request', (req, res) => {
  const { accountHolder, accountNumber, ifsc, amount } = req.body;
  const amt = Number(amount);

  if (!accountHolder || !accountNumber || !ifsc) {
    return res.status(400).json({ error: 'नाम, अकाउंट नंबर और IFSC भरें' });
  }
  if (!amt || amt < 110) {
    return res.status(400).json({ error: 'न्यूनतम विथड्रॉल INR 110 है' });
  }
  if (amt > state.withdrawable) {
    return res.status(400).json({ error: 'Withdrawable बैलेंस पर्याप्त नहीं है' });
  }

  state.withdrawable = Number((state.withdrawable - amt).toFixed(2));

  const reqItem = {
    id: 'WD-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
    accountHolder: accountHolder.trim(),
    accountNumber: accountNumber.trim(),
    ifsc: ifsc.trim().toUpperCase(),
    amount: amt,
    status: 'PENDING',
    createdAt: new Date().toISOString()
  };

  state.withdrawals.unshift(reqItem);
  res.json({ message: 'Withdrawal request भेज दी गई है', request: reqItem, withdrawable: state.withdrawable });
});

// 3. Admin: Deposit Approve / Reject करें
app.post('/api/admin/deposit/action', (req, res) => {
  const { pin, orderId, action } = req.body;
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: 'गलत Admin PIN' });
  }

  const order = state.deposits.find((d) => d.orderId === orderId);
  if (!order) {
    return res.status(404).json({ error: 'Deposit ऑर्डर नहीं मिला' });
  }

  if (action === 'APPROVE' && order.status !== 'SUCCESS') {
    order.status = 'SUCCESS';
    state.balance = Number((state.balance + order.amount).toFixed(2));
  } else if (action === 'REJECT' && order.status !== 'REJECTED') {
    order.status = 'REJECTED';
  }

  res.json({ state });
});

// 4. Admin: Withdrawal Approve (Paid) / Reject करें
app.post('/api/admin/withdraw/action', (req, res) => {
  const { pin, id, action } = req.body;
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: 'गलत Admin PIN' });
  }

  const item = state.withdrawals.find((w) => w.id === id);
  if (!item) {
    return res.status(404).json({ error: 'Withdrawal रिक्वेस्ट नहीं मिली' });
  }

  if (action === 'APPROVE' && item.status === 'PENDING') {
    item.status = 'PAID';
    state.balance = Number(Math.max(0, state.balance - item.amount).toFixed(2));
  } else if (action === 'REJECT' && item.status === 'PENDING') {
    item.status = 'REJECTED';
    state.withdrawable = Number((state.withdrawable + item.amount).toFixed(2));
  }

  res.json({ state });
});

// डेमो गेम बेट / विन (ताकि withdrawable बैलेंस भी टेस्ट हो सके)
app.post('/api/game/bet', (req, res) => {
  const bet = Number(req.body.amount) || 50;
  const multiplier = Number(req.body.multiplier) || 1.5;
  if (bet <= 0 || bet > state.balance) {
    return res.status(400).json({ error: 'बैलेंस कम है' });
  }
  const payout = Number((bet * multiplier).toFixed(2));
  const profit = Number((payout - bet).toFixed(2));
  state.balance = Number((state.balance - bet + payout).toFixed(2));
  if (profit > 0) {
    state.withdrawable = Number((state.withdrawable + profit).toFixed(2));
  }
  res.json({ balance: state.balance, withdrawable: state.withdrawable, payout });
});

app.listen(PORT, () => {
  console.log(`AK777 server running on port ${PORT}`);
});

