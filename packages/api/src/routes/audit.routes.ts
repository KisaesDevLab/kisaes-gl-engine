import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { sql, count } from 'drizzle-orm';
import { auditLog } from '../db/schema/index.js';

export const auditRouter = Router();
auditRouter.use(authenticate);

auditRouter.get('/', async (req, res) => {
  const { entity_type, action, start_date, end_date, search, limit: limitStr, offset: offsetStr } = req.query as Record<string, string>;
  const tenantId = req.tenantId;
  const limit = parseInt(limitStr || '50');
  const offset = parseInt(offsetStr || '0');

  const conditions = [sql`tenant_id = ${tenantId}`];
  if (entity_type) conditions.push(sql`entity_type = ${entity_type}`);
  if (action) conditions.push(sql`action = ${action}`);
  if (start_date) conditions.push(sql`created_at >= ${start_date}::timestamptz`);
  if (end_date) conditions.push(sql`created_at <= ${end_date}::timestamptz + interval '1 day'`);
  if (search) {
    const pattern = '%' + search + '%';
    conditions.push(sql`(entity_type ILIKE ${pattern} OR CAST(before_data AS TEXT) ILIKE ${pattern} OR CAST(after_data AS TEXT) ILIKE ${pattern})`);
  }

  const where = sql.join(conditions, sql` AND `);

  const [dataResult, countResult] = await Promise.all([
    db.execute(sql`
      SELECT id, tenant_id, user_id, action, entity_type, entity_id, before_data, after_data, ip_address, user_agent, created_at
      FROM audit_log
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
    db.execute(sql`SELECT COUNT(*) as total FROM audit_log WHERE ${where}`),
  ]);

  res.json({
    data: dataResult.rows,
    total: parseInt((countResult.rows as any[])[0]?.total || '0'),
  });
});

// Export audit log as CSV
auditRouter.get('/export', async (req, res) => {
  const { entity_type, action, start_date, end_date } = req.query as Record<string, string>;
  const tenantId = req.tenantId;

  const conditions = [sql`tenant_id = ${tenantId}`];
  if (entity_type) conditions.push(sql`entity_type = ${entity_type}`);
  if (action) conditions.push(sql`action = ${action}`);
  if (start_date) conditions.push(sql`created_at >= ${start_date}::timestamptz`);
  if (end_date) conditions.push(sql`created_at <= ${end_date}::timestamptz + interval '1 day'`);

  const where = sql.join(conditions, sql` AND `);

  const result = await db.execute(sql`
    SELECT id, action, entity_type, entity_id, created_at
    FROM audit_log
    WHERE ${where}
    ORDER BY created_at DESC
  `);

  let csv = 'Timestamp,Action,Entity Type,Entity ID\n';
  for (const row of result.rows as any[]) {
    csv += `"${row.created_at}","${row.action}","${row.entity_type}","${row.entity_id || ''}"\n`;
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
  res.send(csv);
});
