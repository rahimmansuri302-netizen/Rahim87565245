const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ak777_secret_key';
const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY || '';
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

const users = new Map();
const otps = new Map();
const orders = new Map();
const txMap = new Map();

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

function signToken(p) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const b = b64({ ...p, exp: Date.now() + 86400000 * 30 });
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${sig}`;
}

function verifyToken(t) {
  if (!t) return null;
  const parts = t.split('.');
  if (parts.length !== 3) return null;
  const expSig = crypto.createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expSig))) return null;
  const data = unb64(parts[1]);
  return data.exp && Date.now() < data.exp ? data : null;
}

function fmtUser(u) {
  const reqBet = Number((u.totalDeposited * 1 + u.totalBonus * 4).toFixed(2));
  const remBet = Number(Math.max(0, reqBet - u.validBetAmount).toFixed(2));
  return {
    id: u.id, phone: u.phone, username: u.username,
    balance: Number(u.balance.toFixed(2)),
    totalDeposited: Number(u.totalDeposited.toFixed(2)),
    totalBonus: Number(u.totalBonus.toFixed(2)),
    validBetAmount: Number(u.validBetAmount.toFixed(2)),
    requiredBet: reqBet, remainingBetNeeded: remBet,
    withdrawable: remBet === 0 ? Number(u.balance.toFixed(2)) : 0,
    vipLevel: u.vipLevel, dailyWithdrawCount: u.dailyWithdrawCount,
    bankDetails: u.bankDetails || null
  };
}

function getUser(phone) {
  if (!users.has(phone)) {
    users.set(phone, {
      id: Math.floor(100000 + Math.random() * 900000),
      phone, username: 'AK_' + phone.slice(-4),
      balance: 0, totalDeposited: 0, totalBonus: 0, validBetAmount: 0,
      vipLevel: 1, dailyWithdrawCount: 0, bankDetails: null
    });
  }
  return users.get(phone);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('Invalid JSON')); }
    });
  });
}

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    if (!fs.existsSync(htmlPath)) return sendJson(res, 404, { success: false, message: 'index.html missing' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(htmlPath).pipe(res);
  }

  try {
    if (req.method === 'POST' && u.pathname === '/api/auth/send-otp') {
      const { phone } = await readBody(req);
      const clean = String(phone || '').trim();
      if (!/^[6-9]\d{9}$/.test(clean)) return sendJson(res, 400, { success: false, message: '10 digit mobile number required' });
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      otps.set(clean, { otp, exp: Date.now() + 300000 });
      if (FAST2SMS_API_KEY) {
        const r = await fetch('https://www.fast2sms.com/dev/bulkV2', {
          method: 'POST',
          headers: { authorization: FAST2SMS_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ route: 'otp', variables_values: otp, numbers: clean })
        });
        const j = await r.json();
        if (!j.return) return sendJson(res, 502, { success: false, message: 'SMS failed' });
        return sendJson(res, 200, { success: true, message: 'OTP sent' });
      }
      return sendJson(res, 200, { success: true, message: 'Demo OTP generated', demoOtp: otp });
    }

    if (req.method === 'POST' && u.pathname === '/api/auth/verify-otp') {
      const { phone, otp } = await readBody(req);
      const rec = otps.get(String(phone || '').trim());
      if (!rec || Date.now() > rec.exp || rec.otp !== String(otp || '').trim()) {
        return sendJson(res, 400, { success: false, message: 'Invalid or expired OTP' });
      }
      otps.delete(String(phone).trim());
      const user = getUser(String(phone).trim());
      return sendJson(res, 200, { success: true, token: signToken({ phone: user.phone }), user: fmtUser(user) });
    }

    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const session = verifyToken(token);

    if (req.method === 'GET' && u.pathname === '/api/auth/auto-login') {
      if (!session) return sendJson(res, 401, { success: false, message: 'Unauthorized' });
      return sendJson(res, 200, { success: true, user: fmtUser(getUser(session.phone)) });
    }

    if (req.method === 'POST' && u.pathname === '/api/wallet/deposit/create') {
      if (!session) return sendJson(res, 401, { success: false, message: 'Login required' });
      const amt = Number((await readBody(req)).amount);
      if (!amt || amt < 100) return sendJson(res, 400, { success: false, message: 'Min deposit 100' });
      const bonus = amt >= 200 ? Math.floor(amt * 0.35) : 0;
      let rzpOrder = null;
      if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
        const basic = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
        const r = await fetch('https://api.razorpay.com/v1/orders', {
          method: 'POST',
          headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: Math.round(amt * 100), currency: 'INR', receipt: 'rcpt_' + Date.now() })
        });
        rzpOrder = await r.json();
      }
      const orderId = rzpOrder ? rzpOrder.id : 'ORD_' + Date.now();
      orders.set(orderId, { orderId, phone: session.phone, amount: amt, bonus, status: 'PENDING' });
      return sendJson(res, 200, {
        success: true, orderId, amount: amt, bonus,
        razorpay: rzpOrder ? { keyId: RAZORPAY_KEY_ID, orderId: rzpOrder.id, amountPaise: rzpOrder.amount, currency: rzpOrder.currency } : null
      });
    }

    if (req.method === 'POST' && (u.pathname === '/api/wallet/deposit/verify' || u.pathname === '/api/wallet/deposit/webhook')) {
      const body = await readBody(req);
      const order = orders.get(body.razorpay_order_id || body.orderId);
      if (!order) return sendJson(res, 404, { success: false, message: 'Order not found' });
      if (body.razorpay_payment_id && body.razorpay_signature && RAZORPAY_KEY_SECRET) {
        const exp = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(`${body.razorpay_order_id}|${body.razorpay_payment_id}`).digest('hex');
        if (exp !== body.razorpay_signature) return sendJson(res, 400, { success: false, message: 'Signature mismatch' });
      }
      if (order.status !== 'SUCCESS') {
        order.status = 'SUCCESS';
        const user = getUser(order.phone);
        user.balance += order.amount + order.bonus;
        user.totalDeposited += order.amount;
        user.totalBonus += order.bonus;
        if (user.totalDeposited >= 10000) user.vipLevel = 2;
        const list = txMap.get(order.phone) || [];
        list.unshift({ type: 'DEPOSIT', orderId: order.orderId, amount: order.amount, bonus: order.bonus, status: 'SUCCESS', createdAt: new Date().toISOString() });
        txMap.set(order.phone, list);
      }
      return sendJson(res, 200, { success: true, message: 'Deposit credited', user: fmtUser(getUser(order.phone)) });
    }

    if (req.method === 'POST' && u.pathname === '/api/wallet/withdraw') {
      if (!session) return sendJson(res, 401, { success: false, message: 'Login required' });
      const { name, accountNumber, ifsc, amount } = await readBody(req);
      const user = getUser(session.phone);
      const info = fmtUser(user);
      const wd = Number(amount);
      if (user.dailyWithdrawCount >= 3) return sendJson(res, 400, { success: false, message: 'Daily limit 3 reached' });
      if (!wd || wd < 110 || wd > 50000) return sendJson(res, 400, { success: false, message: 'Amount 110 to 50000' });
      if (info.remainingBetNeeded > 0) return sendJson(res, 400, { success: false, message: `Need ${info.remainingBetNeeded} valid bet` });
      if (wd > user.balance) return sendJson(res, 400, { success: false, message: 'Low balance' });
      if (!name || !accountNumber || !ifsc) return sendJson(res, 400, { success: false, message: 'Bank details required' });
      const fee = Number((wd * 0.035).toFixed(2));
      const net = Number((wd - fee).toFixed(2));
      user.balance -= wd;
      user.dailyWithdrawCount += 1;
      user.bankDetails = { name, accountNumber, ifsc };
      const list = txMap.get(session.phone) || [];
      list.unshift({ type: 'WITHDRAW', orderId: 'WDR_' + Date.now(), amount: wd, fee, netAmount: net, status: 'PROCESSING', createdAt: new Date().toISOString() });
      txMap.set(session.phone, list);
      return sendJson(res, 200, { success: true, message: `Withdraw requested: INR ${net}`, user: fmtUser(user) });
    }

    if (req.method === 'GET' && u.pathname === '/api/wallet/history') {
      if (!session) return sendJson(res, 401, { success: false, message: 'Login required' });
      return sendJson(res, 200, { success: true, history: txMap.get(session.phone) || [] });
    }

    if (req.method === 'POST' && u.pathname === '/api/game/bet') {
      if (!session) return sendJson(res, 401, { success: false, message: 'Login required' });
      const bet = Number((await readBody(req)).amount);
      const user = getUser(session.phone);
      if (!bet || bet <= 0 || bet > user.balance) return sendJson(res, 400, { success: false, message: 'Invalid bet' });
      user.balance -= bet;
      user.validBetAmount += bet;
      return sendJson(res, 200, { success: true, user: fmtUser(user) });
    }

    sendJson(res, 404, { success: false, message: 'Not found' });
  } catch (e) {
    sendJson(res, 400, { success: false, message: e.message });
  }
});

server.listen(PORT, () => console.log('AK-777 Server running on port ' + PORT));
