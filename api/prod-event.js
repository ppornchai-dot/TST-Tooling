// ตัวรับแจ้งเตือนจากระบบผลิต (webhook) — ถอด/ใส่ใบเลื่อย หรือ Roll SQ
//
// ทำไมต้องมีไฟล์นี้:
//   ระบบผลิตห้ามแอปเราดึงข้อมูลถี่ๆ เพื่อรอดูการเปลี่ยน — จึงให้ระบบผลิตเป็นฝ่าย "ส่งมาบอก" เองทันทีที่หน้างานกดบันทึก
//   ไฟล์นี้รับรายการนั้นแล้วบันทึกลงตาราง prod_events ใน Supabase ของเรา
//   แอป (index.html) ฟังตารางนี้แบบ realtime อยู่ → ทุกเครื่องที่เปิดแอปเด้งป็อปอัพทันที
//
// รูปแบบที่ระบบผลิตส่งมา (ตกลงกันไว้ 19 พ.ย. 69):
//   POST  Content-Type: application/json   x-webhook-secret: <รหัสลับ>
//   { kind: 'saw'|'sq', machine_id, code_out (null ได้), code_in, recorded_at (ISO UTC), color (null ได้), ref_id }
//   ส่งครั้งเดียวต่อการบันทึก ไม่ส่งซ้ำ รอคำตอบนานสุด 5 วินาที — ต้องตอบ 2xx เมื่อรับสำเร็จ
//
// ความลับทั้งหมดอยู่ใน Environment Variable ของ Vercel เท่านั้น — repo นี้เป็นสาธารณะ ห้ามเขียนลงไฟล์
//   PROD_WEBHOOK_SECRET        รหัสลับที่ให้ระบบผลิตส่งมาใน header x-webhook-secret
//   SUPABASE_SERVICE_ROLE_KEY  คีย์ service_role ของ Supabase (ใช้เขียนตาราง prod_events — หน้าเว็บเขียนเองไม่ได้)
//
// ตารางใน Supabase (รันครั้งเดียวที่ SQL Editor):
//   create table if not exists public.prod_events (
//     id bigint generated always as identity primary key,
//     kind text not null check (kind in ('saw','sq')),
//     machine_id text not null,
//     code_out text,
//     code_in text,
//     color text,
//     recorded_at timestamptz not null,
//     ref_id bigint,
//     received_at timestamptz not null default now()
//   );
//   create unique index if not exists prod_events_kind_ref on public.prod_events (kind, ref_id);
//   alter table public.prod_events enable row level security;
//   create policy "prod_events read" on public.prod_events for select to anon using (true);
//   alter publication supabase_realtime add table public.prod_events;
//   (ไม่มี policy ให้ anon เขียน — เขียนได้เฉพาะไฟล์นี้ที่ถือคีย์ service_role)

import crypto from 'node:crypto';

const SUPABASE_URL = 'https://erckimkfvyvwcomsodey.supabase.co';

// เทียบรหัสลับแบบใช้เวลาคงที่ — กันเดารหัสทีละตัวจากเวลาที่ตอบกลับ
function secretOk(given, expected) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

const str = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const secret = process.env.PROD_WEBHOOK_SECRET;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || !serviceKey) return res.status(500).json({ error: 'server_not_configured' });
  if (!secretOk(req.headers['x-webhook-secret'], secret)) return res.status(401).json({ error: 'unauthorized' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  if (!b || typeof b !== 'object') return res.status(400).json({ error: 'bad_json' });

  const kind = b.kind;
  const machineId = str(b.machine_id, 20);
  const codeIn = str(b.code_in, 40);
  const codeOut = str(b.code_out, 40);
  const color = str(b.color, 40);
  const t = Date.parse(b.recorded_at || '');
  const refId = b.ref_id === null || b.ref_id === undefined || b.ref_id === '' ? null : Number(b.ref_id);
  if (kind !== 'saw' && kind !== 'sq') return res.status(400).json({ error: 'bad_kind' });
  if (!machineId) return res.status(400).json({ error: 'bad_machine_id' });
  if (!codeIn && !codeOut) return res.status(400).json({ error: 'bad_code' });
  if (isNaN(t)) return res.status(400).json({ error: 'bad_recorded_at' });
  if (refId !== null && !Number.isSafeInteger(refId)) return res.status(400).json({ error: 'bad_ref_id' });

  const row = {
    kind, machine_id: machineId, code_out: codeOut, code_in: codeIn, color,
    recorded_at: new Date(t).toISOString(), ref_id: refId,
  };
  try {
    // ref_id ซ้ำ (ชนิดเดียวกัน) = รับไปแล้ว — ข้ามเงียบๆ แต่ยังตอบสำเร็จ
    const r = await fetch(SUPABASE_URL + '/rest/v1/prod_events?on_conflict=kind,ref_id', {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(4000),   // ระบบผลิตรอนานสุด 5 วินาที
    });
    if (!r.ok) return res.status(502).json({ error: 'store_failed' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    // ไม่ส่งรายละเอียดข้อผิดพลาดกลับไป กันข้อมูลฝั่ง server รั่ว
    return res.status(502).json({ error: 'store_failed' });
  }
}
