require('dotenv').config();
const express = require('express');
const app = express();
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const pool = require('./db');
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());

// POST /api/tickets/book
app.post('/api/tickets/book', async (req, res) => {
  const { clinicId, patientName, serviceId } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lastTicketQuery = `
      SELECT sequence_num FROM tickets
      WHERE clinic_id = $1 AND DATE(created_at) = CURRENT_DATE
      ORDER BY sequence_num DESC
      FOR UPDATE;
    `;
    const lastTicketRes = await client.query(lastTicketQuery, [clinicId]);
    const nextSeq = (lastTicketRes.rows[0]?.sequence_num || 0) + 1;
    const ticketNum = `A-${nextSeq}`;

    const insertQuery = `
      INSERT INTO tickets (clinic_id, ticket_number, sequence_num, patient_name, status)
      VALUES ($1, $2, $3, $4, 'waiting') RETURNING *;
    `;
    const newTicket = await client.query(insertQuery, [clinicId, ticketNum, nextSeq, patientName]);
    await client.query('COMMIT');

    io.to(clinicId).emit('queue_updated', { action: 'NEW_TICKET', ticket: newTicket.rows[0] });
    return res.status(201).json({ success: true, ticket: newTicket.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('خطأ مفصل في قاعدة البيانات:', error.message);
    return res.status(500).json({ error: 'حدث خطأ أثناء حجز التذكرة' });
  } finally {
    client.release();
  }
});

// 1. مسار استدعاء المريض التالي (تحديث قاعدة البيانات)
app.post('/api/clinics/:clinicId/call-next', async (req, res) => {
    const clinicId = req.params.clinicId;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const updateQuery = `
            UPDATE tickets 
            SET status = 'called' 
            WHERE id = (
                SELECT id FROM tickets 
                WHERE clinic_id = $1 AND status = 'waiting' 
                ORDER BY created_at ASC 
                LIMIT 1
            ) 
            RETURNING *;
        `;
        const updatedTicket = await client.query(updateQuery, [clinicId]);
        await client.query('COMMIT');
        
        if (updatedTicket.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'لا يوجد مرقى في الانتظار حالياً' });
        }
        res.json({ success: true, ticket: updatedTicket.rows[0] });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: error.message });
    } finally {
        client.release();
    }
});

// 2. مسار جلب قائمة الانتظار الحقيقية للعيادة
app.get('/api/clinics/:clinicId/queue', async (req, res) => {
    const { clinicId } = req.params;
    try {
        const result = await pool.query(
            "SELECT * FROM tickets WHERE clinic_id = $1 AND status IN ('waiting', 'in_consultation') ORDER BY created_at ASC",
            [clinicId]
        );
        res.json({ success: true, queue: result.rows });
    } catch (error) {
        console.error("Error fetching queue:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});
// إعادة تفعيل مسار فتح لوحة التحكم كما كان سابقاً
app.get('/dashboard', (req, res) => {
    res.sendFile(__dirname + '/dashboard.html');
});
// 3. تشغيل السيرفر في النهاية
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
// مسار لجلب قائمة الانتظار الحقيقية للعيادة
app.get('/api/clinics/:clinicId/queue', async (req, res) => {
    const { clinicId } = req.params;
    try {
        const result = await pool.query(
            "SELECT * FROM tickets WHERE clinic_id = $1 AND status IN ('waiting', 'in_consultation') ORDER BY created_at ASC",
            [clinicId]
        );
        res.json({ success: true, queue: result.rows });
    } catch (error) {
        console.error("Error fetching queue:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});