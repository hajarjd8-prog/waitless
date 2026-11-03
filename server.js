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

// مسار استدعاء المريض التالي
app.post('/api/clinics/:id/call-next', async (req, res) => {
  const clinicId = req.params.id;
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
      return res.status(404).json({ success: false, message: 'لا يوجد مرضى في الانتظار حالياً' });
    }

    io.to(clinicId).emit('queue_updated', { action: 'CALL_NEXT', ticket: updatedTicket.rows[0] });
    return res.status(200).json({ success: true, ticket: updatedTicket.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('خطأ في استدعاء المريض:', error.message);
    return res.status(500).json({ success: false, error: 'حدث خطأ أثناء استدعاء المريض' });
  } finally {
    client.release();
  }
});

// عرض صفحة لوحة التحكم عبر الخادم
app.get('/dashboard', (req, res) => {
    res.sendFile(__dirname + '/dashboard.html');
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`الخادم يعمل بنجاح على المنفذ ${PORT}`);
});