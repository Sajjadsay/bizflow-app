import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { db } from './server/db';
import { aiProvider } from './server/ai';
import { messagingProvider, WhatsAppBusinessProvider } from './server/messaging';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

// Middleware to extract active business context
app.use((req, res, next) => {
  const businessIdHeader = req.headers['x-business-id'] as string;
  (req as any).businessId = businessIdHeader || 'biz-demo-1';
  next();
});

// 1. Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    supabaseConfigured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
  });
});

app.get('/api/database/status', async (req, res) => {
  const hasDbUrl = Boolean(process.env.DATABASE_URL);
  if (!hasDbUrl) {
    return res.json({
      connected: false,
      provider: 'Local Storage / In-Memory Seed',
      message: 'DATABASE_URL is not set.',
    });
  }

  try {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const [userCount, businessCount, customerCount, orderCount] = await Promise.all([
      prisma.user.count(),
      prisma.business.count(),
      prisma.customer.count(),
      prisma.order.count(),
    ]);
    await prisma.$disconnect();

    res.json({
      connected: true,
      provider: 'Supabase PostgreSQL (Prisma ORM)',
      host: 'aws-0-ap-northeast-2.pooler.supabase.com',
      stats: {
        users: userCount,
        businesses: businessCount,
        customers: customerCount,
        orders: orderCount,
      },
      syncedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    res.json({
      connected: false,
      provider: 'Supabase PostgreSQL',
      error: err.message,
    });
  }
});

// 2. Auth & Business Context
app.get('/api/auth/me', (req, res) => {
  const data = db.getData();
  const user = data.users[0];
  const business = db.getBusiness((req as any).businessId) || data.businesses[0];
  const allBusinesses = data.businesses;
  res.json({ user, business, allBusinesses });
});

app.post('/api/business', (req, res) => {
  const { name, category, businessType, currency, phone, email } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Business name is required' });
  }

  const newBiz = db.createBusiness({
    id: `biz-${Date.now()}`,
    ownerId: 'user-demo-1',
    name,
    category: category || 'General Business',
    businessType: businessType || 'both',
    phone: phone || '+14155550100',
    email: email || 'contact@bizflow.app',
    currency: currency || 'USD',
    timezone: 'America/New_York',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  res.status(201).json(newBiz);
});

app.patch('/api/business/:id', (req, res) => {
  const updated = db.updateBusiness(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Business not found' });
  res.json(updated);
});

app.delete('/api/business/:id', (req, res) => {
  const deleted = db.deleteBusiness(req.params.id);
  res.json({ success: deleted });
});

// 3. Customers
app.get('/api/customers', (req, res) => {
  const businessId = (req as any).businessId;
  const customers = db.getCustomers(businessId);
  res.json(customers);
});

app.get('/api/customers/:id', (req, res) => {
  const businessId = (req as any).businessId;
  const customer = db.getCustomer(businessId, req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  res.json(customer);
});

app.post('/api/customers', (req, res) => {
  const businessId = (req as any).businessId;
  const { firstName, lastName, phone, email, company, tags, source, notes, status } = req.body;

  if (!firstName || !phone) {
    return res.status(400).json({ error: 'First name and phone number are required' });
  }

  const newCustomer = db.createCustomer({
    id: `cust-${Date.now()}`,
    businessId,
    firstName,
    lastName: lastName || '',
    phone,
    email: email || '',
    company: company || '',
    tags: Array.isArray(tags) ? tags : [],
    source: source || 'WhatsApp',
    notes: notes || '',
    status: status || 'Lead',
    totalSpent: 0,
    orderCount: 0,
    lastContactAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  res.status(201).json(newCustomer);
});

app.patch('/api/customers/:id', (req, res) => {
  const businessId = (req as any).businessId;
  const updated = db.updateCustomer(businessId, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Customer not found' });
  res.json(updated);
});

app.delete('/api/customers/:id', (req, res) => {
  const businessId = (req as any).businessId;
  const deleted = db.deleteCustomer(businessId, req.params.id);
  res.json({ success: deleted });
});

app.get('/api/customers/:id/activity', (req, res) => {
  const activities = db.getCustomerActivities(req.params.id);
  res.json(activities);
});

app.get('/api/activity', (req, res) => {
  const businessId = (req as any).businessId;
  const limit = Number(req.query.limit) || 20;
  const customers = db.getCustomers(businessId);
  const allActivities: any[] = [];
  for (const c of customers) {
    allActivities.push(...db.getCustomerActivities(c.id));
  }
  allActivities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  res.json(allActivities.slice(0, limit));
});

// 4. Orders & Jobs
app.get('/api/orders', (req, res) => {
  const businessId = (req as any).businessId;
  const orders = db.getOrders(businessId);
  res.json(orders);
});

app.get('/api/orders/:id', (req, res) => {
  const businessId = (req as any).businessId;
  const order = db.getOrder(businessId, req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

app.post('/api/orders', (req, res) => {
  const businessId = (req as any).businessId;
  const biz = db.getBusiness(businessId);
  const { customerId, title, description, status, items, discount = 0, tax = 0, dueDate, notes } = req.body;

  if (!customerId || !title) {
    return res.status(400).json({ error: 'Customer and Order Title are required' });
  }

  const orderItems = Array.isArray(items)
    ? items.map((it: any, index: number) => ({
        id: `item-${Date.now()}-${index}`,
        name: it.name || 'Custom Item',
        description: it.description || '',
        quantity: Number(it.quantity) || 1,
        unitPrice: Number(it.unitPrice) || 0,
        total: (Number(it.quantity) || 1) * (Number(it.unitPrice) || 0),
      }))
    : [];

  const subtotal = orderItems.reduce((sum: number, it: any) => sum + it.total, 0);
  const total = Math.max(0, subtotal - (Number(discount) || 0) + (Number(tax) || 0));

  const existingOrders = db.getOrders(businessId);
  const orderNumber = `ORD-${100 + existingOrders.length + 1}`;

  const newOrder = db.createOrder({
    id: `ord-${Date.now()}`,
    businessId,
    customerId,
    orderNumber,
    title,
    description: description || '',
    status: status || 'New',
    subtotal,
    discount: Number(discount) || 0,
    tax: Number(tax) || 0,
    total,
    currency: biz?.currency || 'USD',
    dueDate: dueDate || undefined,
    notes: notes || '',
    items: orderItems,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  res.status(201).json(newOrder);
});

app.patch('/api/orders/:id', (req, res) => {
  const businessId = (req as any).businessId;
  const updated = db.updateOrder(businessId, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Order not found' });
  res.json(updated);
});

app.delete('/api/orders/:id', (req, res) => {
  const businessId = (req as any).businessId;
  const deleted = db.deleteOrder(businessId, req.params.id);
  res.json({ success: deleted });
});

// 5. Payments
app.get('/api/payments', (req, res) => {
  const businessId = (req as any).businessId;
  const payments = db.getPayments(businessId);
  res.json(payments);
});

app.post('/api/payments', (req, res) => {
  const businessId = (req as any).businessId;
  const biz = db.getBusiness(businessId);
  const { customerId, orderId, amount, method, status = 'Paid', reference, notes } = req.body;

  if (!customerId || !amount) {
    return res.status(400).json({ error: 'Customer and amount are required' });
  }

  const newPayment = db.createPayment({
    id: `pay-${Date.now()}`,
    businessId,
    customerId,
    orderId: orderId || undefined,
    amount: Number(amount),
    currency: biz?.currency || 'USD',
    method: method || 'Cash',
    status: status || 'Paid',
    reference: reference || '',
    paidAt: new Date().toISOString(),
    notes: notes || '',
    createdAt: new Date().toISOString(),
  });

  res.status(201).json(newPayment);
});

app.patch('/api/payments/:id', (req, res) => {
  const businessId = (req as any).businessId;
  const updated = db.updatePayment(businessId, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Payment not found' });
  res.json(updated);
});

// 6. Follow-ups
app.get('/api/followups', (req, res) => {
  const businessId = (req as any).businessId;
  const followUps = db.getFollowUps(businessId);
  res.json(followUps);
});

app.post('/api/followups', (req, res) => {
  const businessId = (req as any).businessId;
  const { customerId, orderId, title, note, dueAt, priority = 'Medium' } = req.body;

  if (!customerId || !title) {
    return res.status(400).json({ error: 'Customer and title are required' });
  }

  const newFollowUp = db.createFollowUp({
    id: `fup-${Date.now()}`,
    businessId,
    customerId,
    orderId: orderId || undefined,
    title,
    note: note || '',
    dueAt: dueAt || new Date(Date.now() + 86400000).toISOString(),
    priority,
    status: 'Pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  res.status(201).json(newFollowUp);
});

app.patch('/api/followups/:id', (req, res) => {
  const businessId = (req as any).businessId;
  const updated = db.updateFollowUp(businessId, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Follow-up not found' });
  res.json(updated);
});

app.post('/api/followups/:id/complete', (req, res) => {
  const businessId = (req as any).businessId;
  const updated = db.updateFollowUp(businessId, req.params.id, {
    status: 'Completed',
    completedAt: new Date().toISOString(),
  });
  if (!updated) return res.status(404).json({ error: 'Follow-up not found' });
  res.json(updated);
});

app.post('/api/followups/:id/snooze', (req, res) => {
  const businessId = (req as any).businessId;
  const days = req.body.days || 1;
  const updated = db.updateFollowUp(businessId, req.params.id, {
    status: 'Pending',
    dueAt: new Date(Date.now() + days * 86400000).toISOString(),
  });
  if (!updated) return res.status(404).json({ error: 'Follow-up not found' });
  res.json(updated);
});

app.delete('/api/followups/:id', (req, res) => {
  const businessId = (req as any).businessId;
  const deleted = db.deleteFollowUp(businessId, req.params.id);
  res.json({ success: deleted });
});

// 7. Quotes
app.get('/api/quotes', (req, res) => {
  const businessId = (req as any).businessId;
  const quotes = db.getQuotes(businessId);
  res.json(quotes);
});

app.post('/api/quotes', (req, res) => {
  const businessId = (req as any).businessId;
  const biz = db.getBusiness(businessId);
  const { customerId, title, items, discount = 0, tax = 0, validUntil, notes } = req.body;

  if (!customerId || !title) {
    return res.status(400).json({ error: 'Customer and Title are required' });
  }

  const quoteItems = Array.isArray(items)
    ? items.map((it: any, index: number) => ({
        id: `qi-${Date.now()}-${index}`,
        name: it.name || 'Item',
        description: it.description || '',
        quantity: Number(it.quantity) || 1,
        unitPrice: Number(it.unitPrice) || 0,
        total: (Number(it.quantity) || 1) * (Number(it.unitPrice) || 0),
      }))
    : [];

  const subtotal = quoteItems.reduce((sum: number, it: any) => sum + it.total, 0);
  const total = Math.max(0, subtotal - (Number(discount) || 0) + (Number(tax) || 0));
  const count = db.getQuotes(businessId).length;

  const newQuote = db.createQuote({
    id: `quote-${Date.now()}`,
    businessId,
    customerId,
    quoteNumber: `Q-${200 + count + 1}`,
    title,
    notes: notes || '',
    subtotal,
    discount: Number(discount) || 0,
    tax: Number(tax) || 0,
    total,
    currency: biz?.currency || 'USD',
    status: 'Draft',
    validUntil: validUntil || new Date(Date.now() + 14 * 86400000).toISOString(),
    items: quoteItems,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  res.status(201).json(newQuote);
});

app.patch('/api/quotes/:id', (req, res) => {
  const businessId = (req as any).businessId;
  const updated = db.updateQuote(businessId, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Quote not found' });
  res.json(updated);
});

// 8. Invoices
app.get('/api/invoices', (req, res) => {
  const businessId = (req as any).businessId;
  const invoices = db.getInvoices(businessId);
  res.json(invoices);
});

app.post('/api/invoices', (req, res) => {
  const businessId = (req as any).businessId;
  const biz = db.getBusiness(businessId);
  const { customerId, orderId, items, discount = 0, tax = 0, dueDate, notes, status = 'Sent' } = req.body;

  if (!customerId) {
    return res.status(400).json({ error: 'Customer is required' });
  }

  const invoiceItems = Array.isArray(items)
    ? items.map((it: any, index: number) => ({
        id: `inv-item-${Date.now()}-${index}`,
        name: it.name || 'Item',
        description: it.description || '',
        quantity: Number(it.quantity) || 1,
        unitPrice: Number(it.unitPrice) || 0,
        total: (Number(it.quantity) || 1) * (Number(it.unitPrice) || 0),
      }))
    : [];

  const subtotal = invoiceItems.reduce((sum: number, it: any) => sum + it.total, 0);
  const total = Math.max(0, subtotal - (Number(discount) || 0) + (Number(tax) || 0));
  const count = db.getInvoices(businessId).length;

  const newInvoice = db.createInvoice({
    id: `inv-${Date.now()}`,
    businessId,
    customerId,
    orderId: orderId || undefined,
    invoiceNumber: `INV-${300 + count + 1}`,
    subtotal,
    discount: Number(discount) || 0,
    tax: Number(tax) || 0,
    total,
    currency: biz?.currency || 'USD',
    status,
    dueDate: dueDate || new Date(Date.now() + 7 * 86400000).toISOString(),
    items: invoiceItems,
    notes: notes || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  res.status(201).json(newInvoice);
});

app.patch('/api/invoices/:id', (req, res) => {
  const businessId = (req as any).businessId;
  const updated = db.updateInvoice(businessId, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Invoice not found' });
  res.json(updated);
});

// 9. Notes
app.get('/api/notes', (req, res) => {
  const businessId = (req as any).businessId;
  const customerId = req.query.customerId as string | undefined;
  res.json(db.getNotes(businessId, customerId));
});

app.post('/api/notes', (req, res) => {
  const businessId = (req as any).businessId;
  const { customerId, orderId, content } = req.body;
  if (!customerId || !content) {
    return res.status(400).json({ error: 'Customer ID and content are required' });
  }

  const newNote = db.createNote({
    id: `note-${Date.now()}`,
    businessId,
    customerId,
    orderId: orderId || undefined,
    content,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  res.status(201).json(newNote);
});

app.delete('/api/notes/:id', (req, res) => {
  const businessId = (req as any).businessId;
  const deleted = db.deleteNote(businessId, req.params.id);
  res.json({ success: deleted });
});

// 10. Conversations & Messages
app.get('/api/conversations', (req, res) => {
  const businessId = (req as any).businessId;
  res.json(db.getConversations(businessId));
});

app.post('/api/conversations/log-message', (req, res) => {
  const businessId = (req as any).businessId;
  const { customerId, content, direction = 'outbound', messageType = 'text' } = req.body;
  if (!customerId || !content) {
    return res.status(400).json({ error: 'customerId and content are required' });
  }

  const conv = db.recordMessage(businessId, customerId, content, direction, messageType);
  res.json(conv);
});

// 11. AI Routes
app.post('/api/ai/reply', async (req, res) => {
  try {
    const { customerName, userPrompt, tone = 'Friendly', previousConversation } = req.body;
    const businessId = (req as any).businessId;
    const biz = db.getBusiness(businessId);

    const options = await aiProvider.generateReply({
      customerName: customerName || 'Valued Customer',
      userPrompt: userPrompt || 'Need a friendly response',
      tone,
      businessName: biz?.name,
      businessType: biz?.businessType,
      previousConversation,
    });

    res.json({ options });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'AI reply failed' });
  }
});

app.post('/api/ai/extract', async (req, res) => {
  try {
    const { transcript } = req.body;
    if (!transcript) {
      return res.status(400).json({ error: 'Transcript is required' });
    }
    const businessId = (req as any).businessId;
    const biz = db.getBusiness(businessId);

    const extracted = await aiProvider.extractVoiceData({
      transcript,
      currency: biz?.currency || 'USD',
    });

    res.json(extracted);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Voice extraction failed' });
  }
});

app.get('/api/ai/followups', async (req, res) => {
  try {
    const businessId = (req as any).businessId;
    const customers = db.getCustomers(businessId);
    const orders = db.getOrders(businessId);
    const quotes = db.getQuotes(businessId);

    const suggestions = await aiProvider.suggestFollowups(customers, orders, quotes);
    res.json({ suggestions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/summary', async (req, res) => {
  try {
    const businessId = (req as any).businessId;
    const { customerId } = req.body;
    const customer = db.getCustomer(businessId, customerId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const orders = db.getOrders(businessId).filter((o) => o.customerId === customerId);
    const summary = await aiProvider.summarizeCustomer(customer, orders);
    res.json({ summary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 12. WhatsApp Configuration, Test & Webhooks (Zero-Setup Default with Cloud API option)
app.get('/api/whatsapp/config', (req, res) => {
  const businessId = (req as any).businessId;
  const business = db.getBusiness(businessId);
  const cfg = business?.whatsAppConfig;

  res.json({
    mode: cfg?.mode || 'click_to_chat',
    phoneNumberId: cfg?.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    wabaId: cfg?.wabaId || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
    hasToken: Boolean(cfg?.accessToken || process.env.WHATSAPP_API_TOKEN),
    webhookVerifyToken: cfg?.webhookVerifyToken || 'bizflow_webhook_secret_token',
    defaultCountryCode: cfg?.defaultCountryCode || '+1',
    autoFormatPhone: cfg?.autoFormatPhone ?? true,
    autoLogMessages: cfg?.autoLogMessages ?? true,
    lastTestedAt: cfg?.lastTestedAt,
    testStatus: cfg?.testStatus || 'not_tested',
    testError: cfg?.testError,
    webhookUrl: '/api/webhooks/whatsapp',
  });
});

app.post('/api/whatsapp/config', (req, res) => {
  const businessId = (req as any).businessId;
  const business = db.getBusiness(businessId);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const {
    mode = 'click_to_chat',
    phoneNumberId,
    wabaId,
    accessToken,
    webhookVerifyToken,
    defaultCountryCode,
    autoFormatPhone,
    autoLogMessages,
  } = req.body;

  const existingConfig = business.whatsAppConfig || { mode: 'click_to_chat' };
  const updatedConfig = {
    ...existingConfig,
    mode: mode === 'cloud_api' ? 'cloud_api' : 'click_to_chat',
    phoneNumberId: phoneNumberId !== undefined ? phoneNumberId : existingConfig.phoneNumberId,
    wabaId: wabaId !== undefined ? wabaId : existingConfig.wabaId,
    accessToken: accessToken !== undefined && accessToken !== '' ? accessToken : existingConfig.accessToken,
    webhookVerifyToken: webhookVerifyToken !== undefined ? webhookVerifyToken : existingConfig.webhookVerifyToken,
    defaultCountryCode: defaultCountryCode || existingConfig.defaultCountryCode || '+1',
    autoFormatPhone: autoFormatPhone !== undefined ? autoFormatPhone : existingConfig.autoFormatPhone ?? true,
    autoLogMessages: autoLogMessages !== undefined ? autoLogMessages : existingConfig.autoLogMessages ?? true,
  };

  const updatedBiz = db.updateBusiness(businessId, {
    whatsAppConfig: updatedConfig as any,
  });

  res.json(updatedBiz);
});

app.post('/api/whatsapp/test', async (req, res) => {
  const businessId = (req as any).businessId;
  const business = db.getBusiness(businessId);
  const { phoneNumberId, accessToken } = req.body;

  const effectivePhoneId = phoneNumberId || business?.whatsAppConfig?.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const effectiveToken = accessToken || business?.whatsAppConfig?.accessToken || process.env.WHATSAPP_API_TOKEN;

  if (!effectivePhoneId || !effectiveToken) {
    return res.status(400).json({
      success: false,
      message: 'Both Phone Number ID and System Access Token are required to test WhatsApp Cloud API.',
    });
  }

  const tester = new WhatsAppBusinessProvider(effectiveToken, effectivePhoneId);
  const result = await tester.testConnection();

  if (business) {
    const updatedCfg = {
      ...(business.whatsAppConfig || { mode: 'click_to_chat' }),
      lastTestedAt: new Date().toISOString(),
      testStatus: (result.success ? 'success' : 'failed') as 'success' | 'failed',
      testError: result.success ? undefined : result.message,
    };
    db.updateBusiness(businessId, { whatsAppConfig: updatedCfg as any });
  }

  res.json(result);
});

// WhatsApp Webhook Endpoints (For Meta App subscription verification and message ingestion)
app.get('/api/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const business = db.getBusinesses()[0];
  const expectedToken = business?.whatsAppConfig?.webhookVerifyToken || 'bizflow_webhook_secret_token';

  if (mode === 'subscribe' && token === expectedToken) {
    console.log('WhatsApp Webhook verified successfully.');
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: 'Verification token mismatch' });
  }
});

app.post('/api/webhooks/whatsapp', (req, res) => {
  const body = req.body;
  // Handle inbound message payloads safely
  try {
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (message && message.from && message.text?.body) {
      const fromPhone = `+${message.from}`;
      const text = message.text.body;

      // Find matching customer or create lead
      const business = db.getBusinesses()[0];
      if (business) {
        const customers = db.getCustomers(business.id);
        let cust = customers.find((c) => c.phone.replace(/[^\d]/g, '') === message.from);
        if (!cust) {
          cust = db.createCustomer({
            id: `cust-${Date.now()}`,
            businessId: business.id,
            firstName: value?.contacts?.[0]?.profile?.name || 'WhatsApp Customer',
            lastName: '',
            phone: fromPhone,
            tags: ['Inbound WhatsApp'],
            source: 'WhatsApp',
            status: 'Lead',
            totalSpent: 0,
            orderCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
        db.recordMessage(business.id, cust.id, text, 'inbound', 'text');
      }
    }
  } catch (err) {
    console.warn('Webhook processing error:', err);
  }

  res.status(200).json({ status: 'EVENT_RECEIVED' });
});

// 13. Reports
app.get('/api/reports', (req, res) => {
  const businessId = (req as any).businessId;
  const customers = db.getCustomers(businessId);
  const orders = db.getOrders(businessId);
  const payments = db.getPayments(businessId);

  const totalRevenue = payments
    .filter((p) => p.status === 'Paid')
    .reduce((sum, p) => sum + p.amount, 0);

  const totalSales = orders.reduce((sum, o) => sum + (o.total || 0), 0);
  const outstandingPayments = Math.max(0, totalSales - totalRevenue);

  const completedOrders = orders.filter((o) => o.status === 'Completed').length;
  const repeatCustomers = customers.filter((c) => c.orderCount > 1).length;
  const newCustomers = customers.filter((c) => c.orderCount <= 1).length;

  res.json({
    totalRevenue,
    totalSales,
    outstandingPayments,
    ordersCount: orders.length,
    completedOrders,
    customersCount: customers.length,
    repeatCustomers,
    newCustomers,
  });
});

// 13. Global Search
app.get('/api/search', (req, res) => {
  const businessId = (req as any).businessId;
  const q = (req.query.q as string || '').toLowerCase().trim();

  if (!q) {
    return res.json({ customers: [], orders: [], quotes: [], invoices: [] });
  }

  const customers = db.getCustomers(businessId).filter(
    (c) =>
      `${c.firstName} ${c.lastName}`.toLowerCase().includes(q) ||
      c.phone.includes(q) ||
      (c.email && c.email.toLowerCase().includes(q)) ||
      (c.company && c.company.toLowerCase().includes(q))
  );

  const orders = db.getOrders(businessId).filter(
    (o) =>
      o.orderNumber.toLowerCase().includes(q) ||
      o.title.toLowerCase().includes(q) ||
      (o.description && o.description.toLowerCase().includes(q))
  );

  const quotes = db.getQuotes(businessId).filter(
    (quote) =>
      quote.quoteNumber.toLowerCase().includes(q) ||
      quote.title.toLowerCase().includes(q)
  );

  const invoices = db.getInvoices(businessId).filter(
    (inv) =>
      inv.invoiceNumber.toLowerCase().includes(q) ||
      (inv.notes && inv.notes.toLowerCase().includes(q))
  );

  res.json({ customers, orders, quotes, invoices });
});

// 14. Reset to seed
app.post('/api/seed/reset', (req, res) => {
  const data = db.resetToSeed();
  res.json({ success: true, message: 'Database reset to demo seed data' });
});

// Vite Middleware Integration
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BizFlow server listening on http://0.0.0.0:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  startServer();
}

export default app;
