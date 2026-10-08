/* ==========================================================
   Credit Card Processing System - script.js
   One JavaScript file shared by every page.

   HOW IT IS ORGANISED
   1. Settings          - easy numbers you can change
   2. Storage helpers   - read/write LocalStorage
   3. Small utilities   - money, dates, hashing, DOM helpers
   4. Card helpers      - card number / expiry checks
   5. Data helpers      - customers, transactions, summaries
   6. Sessions          - login, logout, page protection
   7. Page code         - one function per page
   8. Start-up          - runs the right page function

   WHERE DATA IS KEPT (browser LocalStorage / SessionStorage)
   - ccps_customers      : list of all customers (each with their own card)
   - ccps_transactions   : list of all transactions (each has a customerId)
   - ccps_online         : which customers were recently active
   - ccps_admin          : the administrator account
   - sessionStorage      : who is logged in right now in THIS browser tab
   ========================================================== */

'use strict';

/* ---------- 1. SETTINGS ---------- */
const DEFAULT_CREDIT_LIMIT = 50000;   // every new customer gets this limit (INR)
const ONLINE_TIMEOUT_MINUTES = 5;     // a customer counts as "logged in" if active within this time

const KEYS = {
  customers: 'ccps_customers',
  transactions: 'ccps_transactions',
  online: 'ccps_online',
  admin: 'ccps_admin'
};
const SESSION_CUSTOMER = 'ccps_session_customer';
const SESSION_ADMIN = 'ccps_session_admin';


/* ---------- 2. STORAGE HELPERS ---------- */
function loadData(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

function saveData(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}


/* ---------- 3. SMALL UTILITIES ---------- */
function $(id) {
  return document.getElementById(id);
}

// Create an element. Text is added with textContent, which keeps the page safe from injected HTML.
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

const moneyFormatter = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
function formatMoney(amount) {
  return moneyFormatter.format(amount);
}

function round2(number) {
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function formatDateTime(isoString) {
  return new Date(isoString).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

// Show a coloured message box. type = 'error' | 'success' | 'info'
function showMessage(id, text, type) {
  const box = $(id);
  if (!box) return;
  box.textContent = text;
  box.className = 'alert alert-' + (type || 'error');
}

function clearMessage(id) {
  const box = $(id);
  if (!box) return;
  box.textContent = '';
  box.className = 'alert hidden';
}

/* Passwords are never saved as plain text. We save a "hash" (a one-way scrambled version).
   The customer's id is mixed in so two people with the same password get different hashes.
   Note: this is fine for learning/demo, but a real bank system must hash on a secure server. */
async function hashSecret(ownerId, purpose, value) {
  const text = ownerId + ':' + purpose + ':' + value;
  if (window.crypto && window.crypto.subtle) {
    const bytes = new TextEncoder().encode(text);
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return 'plain:' + text; // only used if the browser has no crypto support
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}


/* ---------- 4. CARD HELPERS ---------- */
function digitsOnly(value) {
  return String(value).replace(/\D/g, '');
}

// Luhn check: the standard test that real card numbers pass
function passesLuhn(number) {
  let sum = 0;
  let double = false;
  for (let i = number.length - 1; i >= 0; i--) {
    let digit = parseInt(number[i], 10);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function detectCardType(number) {
  if (/^4/.test(number)) return 'Visa';
  if (/^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/.test(number)) return 'Mastercard';
  if (/^3[47]/.test(number)) return 'American Express';
  if (/^(60|65|81|82|508)/.test(number)) return 'RuPay';
  return null;
}

// Returns { valid: true, type: 'Visa' } or { valid: false, error: '...' }
function checkCardNumber(number) {
  const type = detectCardType(number);
  if (!type) {
    return { valid: false, error: 'Card type not supported. Use Visa, Mastercard, American Express or RuPay.' };
  }
  const expectedLength = type === 'American Express' ? 15 : 16;
  if (number.length !== expectedLength) {
    return { valid: false, error: 'A ' + type + ' card number must have ' + expectedLength + ' digits.' };
  }
  if (!passesLuhn(number)) {
    return { valid: false, error: 'This card number is not valid. Please check it and try again.' };
  }
  return { valid: true, type: type };
}

function maskCardNumber(last4, type) {
  if (type === 'American Express') return '\u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022\u2022\u2022 \u2022' + last4;
  return '\u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022 ' + last4;
}

// "08/27" -> { month: 8, year: 2027 }   (or null if the format is wrong)
function parseExpiry(text) {
  const match = /^(\d{2})\/(\d{2})$/.exec(text);
  if (!match) return null;
  const month = parseInt(match[1], 10);
  if (month < 1 || month > 12) return null;
  return { month: month, year: 2000 + parseInt(match[2], 10) };
}

// A card works until the end of its expiry month
function isExpired(expiry) {
  return new Date(expiry.year, expiry.month, 1) <= new Date();
}

// Automatically adds spaces to a card number while the user types
function attachCardNumberFormatter(input) {
  input.addEventListener('input', function () {
    const groups = digitsOnly(input.value).slice(0, 16).match(/.{1,4}/g) || [];
    input.value = groups.join(' ');
  });
}

// Automatically adds the "/" in MM/YY while the user types
function attachExpiryFormatter(input) {
  input.addEventListener('input', function () {
    const digits = digitsOnly(input.value).slice(0, 4);
    input.value = digits.length > 2 ? digits.slice(0, 2) + '/' + digits.slice(2) : digits;
  });
}


/* ---------- 5. DATA HELPERS ---------- */
function getCustomers() {
  return loadData(KEYS.customers, []);
}

function saveCustomers(list) {
  saveData(KEYS.customers, list);
}

function getCustomerById(id) {
  return getCustomers().find(c => c.id === id) || null;
}

function findCustomerByUsername(username) {
  const wanted = username.trim().toLowerCase();
  return getCustomers().find(c => c.username.toLowerCase() === wanted) || null;
}

function updateCustomer(updated) {
  const list = getCustomers().map(c => (c.id === updated.id ? updated : c));
  saveCustomers(list);
}

function getAllTransactions() {
  return loadData(KEYS.transactions, []);
}

// Only the transactions that belong to ONE customer, newest first
function getCustomerTransactions(customerId) {
  return getAllTransactions()
    .filter(t => t.customerId === customerId)
    .sort((a, b) => new Date(b.dateTime) - new Date(a.dateTime));
}

function createTransactionId() {
  const existing = getAllTransactions().map(t => t.id);
  let id;
  do {
    id = 'TXN' + Date.now().toString().slice(-8) + String(Math.floor(1000 + Math.random() * 9000));
  } while (existing.includes(id));
  return id;
}

/* Available credit is never stored. It is always worked out as:
   credit limit - everything this customer has spent.
   That way it can never get out of sync with the transactions. */
function getSummary(customer) {
  const transactions = getCustomerTransactions(customer.id);
  const now = new Date();
  let total = 0;
  let thisMonth = 0;
  let largest = 0;

  transactions.forEach(t => {
    total += t.amount;
    const when = new Date(t.dateTime);
    if (when.getMonth() === now.getMonth() && when.getFullYear() === now.getFullYear()) {
      thisMonth += t.amount;
    }
    if (t.amount > largest) largest = t.amount;
  });

  total = round2(total);
  return {
    count: transactions.length,
    total: total,
    thisMonth: round2(thisMonth),
    largest: largest,
    available: round2(customer.creditLimit - total),
    usedPercent: customer.creditLimit > 0 ? Math.min(100, Math.round((total / customer.creditLimit) * 100)) : 0
  };
}


/* ---------- 6. SESSIONS (login / logout / page protection) ---------- */

/* "Currently logged-in customers": each customer page records "I was active just now".
   The admin page counts customers who were active in the last few minutes. */
function markOnline(customerId) {
  const online = loadData(KEYS.online, {});
  online[customerId] = Date.now();
  saveData(KEYS.online, online);
}

function markOffline(customerId) {
  const online = loadData(KEYS.online, {});
  delete online[customerId];
  saveData(KEYS.online, online);
}

function getOnlineCustomerIds() {
  const online = loadData(KEYS.online, {});
  const limit = ONLINE_TIMEOUT_MINUTES * 60 * 1000;
  const now = Date.now();
  return Object.keys(online).filter(id => now - online[id] <= limit && getCustomerById(id));
}

function loginCustomer(customer) {
  sessionStorage.setItem(SESSION_CUSTOMER, customer.id);
  markOnline(customer.id);
}

function logoutCustomer() {
  const id = sessionStorage.getItem(SESSION_CUSTOMER);
  if (id) markOffline(id);
  sessionStorage.removeItem(SESSION_CUSTOMER);
  location.replace('index.html');
}

function getCurrentCustomer() {
  const id = sessionStorage.getItem(SESSION_CUSTOMER);
  if (!id) return null;
  const customer = getCustomerById(id);
  if (!customer) sessionStorage.removeItem(SESSION_CUSTOMER);
  return customer;
}

// Call at the top of every customer page. Sends visitors who are not logged in back to the login page.
function requireCustomer() {
  const customer = getCurrentCustomer();
  if (!customer) {
    location.replace('index.html');
    return null;
  }
  markOnline(customer.id);
  setInterval(() => markOnline(customer.id), 60 * 1000); // keep saying "I'm still here"

  document.querySelectorAll('.js-customer-name').forEach(node => {
    node.textContent = customer.fullName;
  });
  document.querySelectorAll('.js-logout').forEach(button => {
    button.addEventListener('click', logoutCustomer);
  });
  document.body.classList.remove('guarded'); // reveal the page
  return customer;
}

function getAdmin() {
  return loadData(KEYS.admin, null);
}

function isAdminLoggedIn() {
  const admin = getAdmin();
  const sessionName = sessionStorage.getItem(SESSION_ADMIN);
  return !!(admin && sessionName && sessionName === admin.username);
}

function logoutAdmin() {
  sessionStorage.removeItem(SESSION_ADMIN);
  location.replace('admin-login.html');
}

function requireAdmin() {
  if (!isAdminLoggedIn()) {
    location.replace('admin-login.html');
    return null;
  }
  document.querySelectorAll('.js-admin-logout').forEach(button => {
    button.addEventListener('click', logoutAdmin);
  });
  document.body.classList.remove('guarded');
  return getAdmin();
}


/* ---------- 7. PAGE CODE ---------- */

/* ===== index.html : login, register, forgot username, forgot password ===== */
function initLoginPage() {
  // Already logged in? Go straight to the dashboard.
  if (getCurrentCustomer()) {
    location.replace('dashboard.html');
    return;
  }

  const panels = ['panel-login', 'panel-register', 'panel-forgot-username', 'panel-forgot-password'];

  function showPanel(panelId) {
    panels.forEach(id => $(id).classList.toggle('hidden', id !== panelId));
    $('authCard').classList.toggle('wide', panelId === 'panel-register');
    ['loginMsg', 'registerMsg', 'forgotUserMsg', 'forgotPassMsg'].forEach(clearMessage);
    // Reset the two-step "forgot password" form each time it is opened
    $('forgotPassForm1').classList.remove('hidden');
    $('forgotPassForm2').classList.add('hidden');
  }

  // Every button with data-show="panel-id" switches to that panel
  document.querySelectorAll('[data-show]').forEach(button => {
    button.addEventListener('click', () => showPanel(button.dataset.show));
  });

  attachCardNumberFormatter($('regCardNumber'));
  attachExpiryFormatter($('regExpiry'));

  /* ----- Login ----- */
  $('loginForm').addEventListener('submit', async function (event) {
    event.preventDefault();
    clearMessage('loginMsg');

    const username = $('loginUsername').value.trim();
    const password = $('loginPassword').value;

    if (!username || !password) {
      showMessage('loginMsg', 'Please enter your username and password.');
      return;
    }

    const customer = findCustomerByUsername(username);
    const hash = customer ? await hashSecret(customer.id, 'password', password) : null;

    if (!customer || hash !== customer.passwordHash) {
      showMessage('loginMsg', 'Incorrect username or password.');
      return;
    }

    loginCustomer(customer);
    location.href = 'dashboard.html';
  });

  /* ----- Register ----- */
  $('registerForm').addEventListener('submit', async function (event) {
    event.preventDefault();
    clearMessage('registerMsg');

    const fullName = $('regFullName').value.trim();
    const email = $('regEmail').value.trim().toLowerCase();
    const username = $('regUsername').value.trim();
    const password = $('regPassword').value;
    const confirm = $('regConfirm').value;
    const question = $('regQuestion').value;
    const answer = $('regAnswer').value.trim().toLowerCase();
    const cardNumber = digitsOnly($('regCardNumber').value);
    const expiryText = $('regExpiry').value.trim();

    function fail(message) { showMessage('registerMsg', message); }

    if (fullName.length < 2) return fail('Please enter your full name.');
    if (!isValidEmail(email)) return fail('Please enter a valid email address.');
    if (!/^[A-Za-z0-9_]{4,20}$/.test(username)) return fail('Username must be 4-20 letters, numbers or underscores.');
    if (findCustomerByUsername(username)) return fail('That username is already taken. Please choose another.');
    if (getCustomers().some(c => c.email === email)) return fail('An account with that email already exists.');
    if (password.length < 6) return fail('Password must be at least 6 characters.');
    if (password !== confirm) return fail('The two passwords do not match.');
    if (answer.length < 2) return fail('Please enter a security answer.');

    const cardCheck = checkCardNumber(cardNumber);
    if (!cardCheck.valid) return fail(cardCheck.error);

    const expiry = parseExpiry(expiryText);
    if (!expiry) return fail('Enter the expiry date as MM/YY, for example 08/29.');
    if (isExpired(expiry)) return fail('That card has expired.');

    const id = 'C' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const customer = {
      id: id,
      fullName: fullName,
      email: email,
      username: username,
      passwordHash: await hashSecret(id, 'password', password),
      securityQuestion: question,
      securityAnswerHash: await hashSecret(id, 'answer', answer),
      payPasswordHash: null,              // the customer creates this on the Payment page
      creditLimit: DEFAULT_CREDIT_LIMIT,
      createdAt: new Date().toISOString(),
      card: {
        type: cardCheck.type,
        last4: cardNumber.slice(-4),      // the full number is never stored
        expiry: expiryText,
        status: 'Active'
      }
    };

    const customers = getCustomers();
    customers.push(customer);
    saveCustomers(customers);

    $('registerForm').reset();
    showPanel('panel-login');
    $('loginUsername').value = username;
    showMessage('loginMsg', 'Account created. Please log in.', 'success');
  });

  /* ----- Forgot username ----- */
  $('forgotUserForm').addEventListener('submit', function (event) {
    event.preventDefault();
    clearMessage('forgotUserMsg');

    const email = $('fuEmail').value.trim().toLowerCase();
    if (!isValidEmail(email)) {
      showMessage('forgotUserMsg', 'Please enter a valid email address.');
      return;
    }
    const customer = getCustomers().find(c => c.email === email);
    if (!customer) {
      showMessage('forgotUserMsg', 'No account was found with that email address.');
      return;
    }
    // A real website would email this. In this demo we show it on screen.
    showMessage('forgotUserMsg', 'Your username is: ' + customer.username, 'success');
  });

  /* ----- Forgot password (2 steps) ----- */
  let resetCustomerId = null;

  $('forgotPassForm1').addEventListener('submit', function (event) {
    event.preventDefault();
    clearMessage('forgotPassMsg');

    const customer = findCustomerByUsername($('fpUsername').value);
    if (!customer) {
      showMessage('forgotPassMsg', 'No account was found with that username.');
      return;
    }
    resetCustomerId = customer.id;
    $('fpQuestion').textContent = customer.securityQuestion;
    $('forgotPassForm1').classList.add('hidden');
    $('forgotPassForm2').classList.remove('hidden');
  });

  $('forgotPassForm2').addEventListener('submit', async function (event) {
    event.preventDefault();
    clearMessage('forgotPassMsg');

    const customer = getCustomerById(resetCustomerId);
    if (!customer) {
      showMessage('forgotPassMsg', 'Something went wrong. Please start again.');
      return;
    }

    const answer = $('fpAnswer').value.trim().toLowerCase();
    const newPassword = $('fpNew').value;
    const confirm = $('fpConfirm').value;

    const answerHash = await hashSecret(customer.id, 'answer', answer);
    if (answerHash !== customer.securityAnswerHash) {
      showMessage('forgotPassMsg', 'That answer is not correct.');
      return;
    }
    if (newPassword.length < 6) {
      showMessage('forgotPassMsg', 'New password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirm) {
      showMessage('forgotPassMsg', 'The two passwords do not match.');
      return;
    }

    customer.passwordHash = await hashSecret(customer.id, 'password', newPassword);
    updateCustomer(customer);

    $('forgotPassForm2').reset();
    $('forgotPassForm1').reset();
    showPanel('panel-login');
    $('loginUsername').value = customer.username;
    showMessage('loginMsg', 'Password changed. Please log in with your new password.', 'success');
  });
}


/* ===== dashboard.html ===== */
function initDashboardPage() {
  const customer = requireCustomer();
  if (!customer) return;

  const summary = getSummary(customer);

  $('availableCredit').textContent = formatMoney(summary.available);
  $('creditLimit').textContent = formatMoney(customer.creditLimit);
  $('usedPercent').textContent = summary.usedPercent + '%';
  $('usedAmount').textContent = formatMoney(summary.total);
  $('meterFill').style.width = summary.usedPercent + '%';
  $('meter').setAttribute('aria-valuenow', summary.usedPercent);

  $('totalSpent').textContent = formatMoney(summary.total);
  $('monthSpent').textContent = formatMoney(summary.thisMonth);
  $('paymentCount').textContent = summary.count;
  $('largestPayment').textContent = summary.count ? formatMoney(summary.largest) : formatMoney(0);

  if (customer.card.status !== 'Active') {
    $('cardWarning').classList.remove('hidden');
  }
}


/* ===== card.html ===== */
function initCardPage() {
  const customer = requireCustomer();
  if (!customer) return;

  const card = customer.card;
  const masked = maskCardNumber(card.last4, card.type);

  $('ccType').textContent = card.type;
  $('ccNumber').textContent = masked;
  $('ccExpiry').textContent = card.expiry;

  $('detType').textContent = card.type;
  $('detNumber').textContent = masked;
  $('detExpiry').textContent = card.expiry;

  const status = $('detStatus');
  status.textContent = card.status;
  status.classList.add(card.status === 'Active' ? 'badge-ok' : 'badge-bad');
}


/* ===== payment.html ===== */
function initPaymentPage() {
  const customer = requireCustomer();
  if (!customer) return;

  attachCardNumberFormatter($('payCardNumber'));
  attachExpiryFormatter($('payExpiry'));

  function refreshPage() {
    const current = getCurrentCustomer();
    $('availableCredit').textContent = formatMoney(getSummary(current).available);

    // First payment: the customer CREATES a payment password. Later: they ENTER it.
    const firstTime = !current.payPasswordHash;
    $('payConfirmField').classList.toggle('hidden', !firstTime);
    $('payPasswordLabel').textContent = firstTime ? 'Create your payment password' : 'Enter your payment password';
    $('payPassword').setAttribute('autocomplete', firstTime ? 'new-password' : 'current-password');
    $('payPasswordNote').textContent = firstTime
      ? 'You have not created a payment password yet. Choose your own (at least 6 characters). You will need it for every payment, so remember it.'
      : 'Enter the payment password you created to approve this payment.';
  }
  refreshPage();

  if (customer.card.status !== 'Active') {
    showMessage('paymentMsg', 'Your card is Deactive, so payments are blocked. Please contact the administrator.');
  }

  $('paymentForm').addEventListener('submit', async function (event) {
    event.preventDefault();
    clearMessage('paymentMsg');

    // Always read fresh data, in case something changed since the page opened
    const current = getCurrentCustomer();
    if (!current) {
      location.replace('index.html');
      return;
    }
    const card = current.card;

    function fail(message) { showMessage('paymentMsg', message); }

    /* 1. Card status */
    if (card.status !== 'Active') return fail('Your card is Deactive, so payments are blocked.');

    /* 2. Amount */
    const amountText = $('payAmount').value.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(amountText)) return fail('Enter a valid amount, for example 499.50 (maximum 2 decimal places).');
    const amount = round2(parseFloat(amountText));
    if (amount <= 0) return fail('The amount must be greater than zero.');

    const available = getSummary(current).available;
    if (amount > available) return fail('Not enough available credit. You can pay up to ' + formatMoney(available) + '.');

    /* 3. Card details */
    if ($('payHolder').value.trim().length < 2) return fail('Please enter the name on the card.');

    const cardNumber = digitsOnly($('payCardNumber').value);
    const cardCheck = checkCardNumber(cardNumber);
    if (!cardCheck.valid) return fail(cardCheck.error);
    if (cardCheck.type !== card.type || cardNumber.slice(-4) !== card.last4) {
      return fail('This card does not match the card registered to your account.');
    }

    const expiryText = $('payExpiry').value.trim();
    const expiry = parseExpiry(expiryText);
    if (!expiry) return fail('Enter the expiry date as MM/YY, for example 08/29.');
    if (isExpired(expiry)) return fail('This card has expired.');
    if (expiryText !== card.expiry) return fail('The expiry date does not match your registered card.');

    const cvvLength = card.type === 'American Express' ? 4 : 3;
    if (!new RegExp('^\\d{' + cvvLength + '}$').test($('payCvv').value)) {
      return fail('The CVV must be ' + cvvLength + ' digits.');
    }

    /* 4. Payment password (the customer's own) */
    const password = $('payPassword').value;
    let newPayHash = null;

    if (!current.payPasswordHash) {
      if (password.length < 6) return fail('Your payment password must be at least 6 characters.');
      if (password !== $('payPasswordConfirm').value) return fail('The two payment passwords do not match.');
      newPayHash = await hashSecret(current.id, 'pay', password);
    } else {
      if (!password) return fail('Please enter your payment password.');
      const hash = await hashSecret(current.id, 'pay', password);
      if (hash !== current.payPasswordHash) return fail('Incorrect payment password.');
    }

    /* 5. Everything is valid: save the password (first time) and the transaction */
    if (newPayHash) {
      current.payPasswordHash = newPayHash;
      updateCustomer(current);
    }

    const transaction = {
      id: createTransactionId(),
      customerId: current.id,              // this links the transaction to the right customer
      amount: amount,
      dateTime: new Date().toISOString(),
      status: 'Successful',
      cardLast4: card.last4
    };
    const all = getAllTransactions();
    all.push(transaction);
    saveData(KEYS.transactions, all);

    $('paymentForm').reset();
    refreshPage();
    showMessage('paymentMsg',
      'Payment successful! ' + formatMoney(amount) + ' was paid. Transaction ID: ' + transaction.id,
      'success');
  });
}


/* ===== transaction.html ===== */
function initTransactionPage() {
  const customer = requireCustomer();
  if (!customer) return;

  // Only THIS customer's transactions
  const transactions = getCustomerTransactions(customer.id);
  const body = $('txnBody');
  body.textContent = '';

  $('txnCount').textContent = transactions.length
    ? transactions.length + ' successful payment' + (transactions.length === 1 ? '' : 's') + ', newest first.'
    : 'Your successful payments will appear here.';

  if (transactions.length === 0) {
    const row = el('tr');
    const cell = el('td', 'No transactions yet. Use Process Payment to make your first payment.', 'empty');
    cell.colSpan = 4;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  transactions.forEach(t => {
    const row = el('tr');
    row.appendChild(el('td', t.id));
    row.appendChild(el('td', formatMoney(t.amount), 'num'));
    row.appendChild(el('td', formatDateTime(t.dateTime)));
    const statusCell = el('td');
    statusCell.appendChild(el('span', t.status, 'badge badge-ok'));
    row.appendChild(statusCell);
    body.appendChild(row);
  });
}


/* ===== admin-login.html ===== */
function initAdminLoginPage() {
  if (isAdminLoggedIn()) {
    location.replace('admin.html');
    return;
  }

  function showCorrectForm() {
    const hasAdmin = !!getAdmin();
    $('adminSetup').classList.toggle('hidden', hasAdmin);
    $('adminLogin').classList.toggle('hidden', !hasAdmin);
  }
  showCorrectForm();

  // First-time setup: the person using the site chooses the admin username and password
  $('adminSetupForm').addEventListener('submit', async function (event) {
    event.preventDefault();
    clearMessage('adminMsg');

    if (getAdmin()) {                       // someone already created it
      showCorrectForm();
      return;
    }

    const username = $('setupUsername').value.trim();
    const password = $('setupPassword').value;
    const confirm = $('setupConfirm').value;

    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
      showMessage('adminMsg', 'Username must be 3-20 letters, numbers or underscores.');
      return;
    }
    if (password.length < 8) {
      showMessage('adminMsg', 'Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      showMessage('adminMsg', 'The two passwords do not match.');
      return;
    }

    saveData(KEYS.admin, {
      username: username,
      passwordHash: await hashSecret('admin', 'password', password)
    });

    $('adminSetupForm').reset();
    showCorrectForm();
    showMessage('adminMsg', 'Administrator created. Please log in.', 'success');
  });

  $('adminLoginForm').addEventListener('submit', async function (event) {
    event.preventDefault();
    clearMessage('adminMsg');

    const admin = getAdmin();
    const username = $('adminUsername').value.trim();
    const password = $('adminPassword').value;

    const hash = await hashSecret('admin', 'password', password);
    if (!admin || username !== admin.username || hash !== admin.passwordHash) {
      showMessage('adminMsg', 'Incorrect admin username or password.');
      return;
    }

    sessionStorage.setItem(SESSION_ADMIN, admin.username);
    location.href = 'admin.html';
  });
}


/* ===== admin.html ===== */
function initAdminPage() {
  const admin = requireAdmin();
  if (!admin) return;

  $('adminName').textContent = admin.username;

  function render() {
    const customers = getCustomers();
    const transactions = getAllTransactions()
      .slice()
      .sort((a, b) => new Date(b.dateTime) - new Date(a.dateTime));
    const onlineIds = getOnlineCustomerIds();

    /* Summary boxes */
    const totalAmount = round2(transactions.reduce((sum, t) => sum + t.amount, 0));
    $('statCustomers').textContent = customers.length;
    $('statOnline').textContent = onlineIds.length;
    $('statTxns').textContent = transactions.length;
    $('statAmount').textContent = formatMoney(totalAmount);

    /* Customer table */
    const customerBody = $('customerBody');
    customerBody.textContent = '';

    if (customers.length === 0) {
      const row = el('tr');
      const cell = el('td', 'No customers have registered yet.', 'empty');
      cell.colSpan = 9;
      row.appendChild(cell);
      customerBody.appendChild(row);
    }

    customers.forEach(customer => {
      const summary = getSummary(customer);
      const row = el('tr');

      row.appendChild(el('td', customer.fullName));
      row.appendChild(el('td', customer.username));
      row.appendChild(el('td', customer.email));
      row.appendChild(el('td', customer.card.type + ' ' + maskCardNumber(customer.card.last4, customer.card.type)));

      // Card status + button to switch it
      const statusCell = el('td');
      const isActive = customer.card.status === 'Active';
      statusCell.appendChild(el('span', customer.card.status, 'badge ' + (isActive ? 'badge-ok' : 'badge-bad')));
      const toggle = el('button', isActive ? 'Deactivate' : 'Activate', 'btn btn-outline btn-small');
      toggle.type = 'button';
      toggle.style.marginLeft = '8px';
      toggle.addEventListener('click', function () {
        const fresh = getCustomerById(customer.id);
        fresh.card.status = fresh.card.status === 'Active' ? 'Deactive' : 'Active';
        updateCustomer(fresh);
        render();
      });
      statusCell.appendChild(toggle);
      row.appendChild(statusCell);

      row.appendChild(el('td', formatMoney(customer.creditLimit), 'num'));
      row.appendChild(el('td', formatMoney(summary.total), 'num'));
      row.appendChild(el('td', formatMoney(summary.available), 'num'));

      const online = onlineIds.includes(customer.id);
      const onlineCell = el('td');
      onlineCell.appendChild(el('span', online ? 'Yes' : 'No', 'badge ' + (online ? 'badge-ok' : 'badge-bad')));
      row.appendChild(onlineCell);

      customerBody.appendChild(row);
    });

    /* Transaction table (all customers, with the owner's name) */
    const txnBody = $('transactionBody');
    txnBody.textContent = '';

    if (transactions.length === 0) {
      const row = el('tr');
      const cell = el('td', 'No transactions yet.', 'empty');
      cell.colSpan = 5;
      row.appendChild(cell);
      txnBody.appendChild(row);
    }

    transactions.forEach(t => {
      const owner = customers.find(c => c.id === t.customerId);
      const row = el('tr');
      row.appendChild(el('td', t.id));
      row.appendChild(el('td', owner ? owner.fullName + ' (' + owner.username + ')' : 'Unknown customer'));
      row.appendChild(el('td', formatMoney(t.amount), 'num'));
      row.appendChild(el('td', formatDateTime(t.dateTime)));
      const statusCell = el('td');
      statusCell.appendChild(el('span', t.status, 'badge badge-ok'));
      row.appendChild(statusCell);
      txnBody.appendChild(row);
    });
  }

  render();
  setInterval(render, 10000); // refresh every 10 seconds so new logins and payments show up
}


/* ---------- 8. START-UP ---------- */
// Each HTML page has <body data-page="...">. This picks the matching function.
const PAGES = {
  'login': initLoginPage,
  'dashboard': initDashboardPage,
  'card': initCardPage,
  'payment': initPaymentPage,
  'transaction': initTransactionPage,
  'admin-login': initAdminLoginPage,
  'admin': initAdminPage
};

document.addEventListener('DOMContentLoaded', function () {
  const start = PAGES[document.body.dataset.page];
  if (start) start();
});

// If the browser shows an old copy of a page when the Back button is pressed
// (for example right after logging out), reload so the login check runs again.
window.addEventListener('pageshow', function (event) {
  if (event.persisted) location.reload();
});
