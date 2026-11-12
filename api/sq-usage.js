// ตัวกลางฝั่ง server — ดึงข้อมูลอายุ SQ / ใบเลื่อย จากระบบผลิต
//
// ทำไมต้องมีไฟล์นี้:
//   ระบบผลิตกำหนดว่า API ชุดนี้ต้องส่ง header x-api-key และ "ห้ามเรียกตรงจากหน้าเว็บ"
//   เพราะคีย์จะหลุดไปอยู่ในเบราว์เซอร์ และ endpoint ของเขาก็ไม่ได้เปิด CORS ไว้ด้วย
//   TST Tooling เป็นหน้า HTML ล้วนบน GitHub Pages (repo สาธารณะ) ไม่มีฝั่ง server
//   ไฟล์นี้จึงทำหน้าที่เป็นตัวกลาง: เก็บคีย์ไว้ฝั่ง server แล้วเปิดให้เฉพาะหน้าเว็บของเราเรียก
//
// คีย์อยู่ใน Environment Variable ชื่อ PROD_API_KEY เท่านั้น
// ห้ามเขียนคีย์ลงในไฟล์นี้เด็ดขาด — repo นี้เป็นสาธารณะ ใครก็อ่านได้

const UPSTREAM = 'https://tstproduction.vercel.app/api/ext/sq-usage';

// เปิดให้เฉพาะหน้าเว็บของเรา — ที่อื่นเรียกไม่ได้ จะได้ไม่กลายเป็นช่องให้คนอื่นยืมคีย์เราไปใช้
const ALLOW_ORIGINS = [
  'https://ppornchai-dot.github.io',
];

const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

export default async function handler(req, res) {
  const origin = String(req.headers.origin || '');
  if (ALLOW_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  // ปฏิเสธที่ฝั่ง server ด้วย ไม่พึ่ง CORS อย่างเดียว — CORS กันได้แค่เบราว์เซอร์
  // ถ้าไม่เช็กตรงนี้ ใครยิงด้วย curl ก็อ่านข้อมูลผ่านตัวกลางเราได้โดยไม่ต้องมีคีย์
  // (Origin ปลอมได้ก็จริง แต่กันการใช้งานแบบสุ่มเจอ URL แล้วยิงเล่นได้)
  if (!ALLOW_ORIGINS.includes(origin)) return res.status(403).json({ error: 'forbidden_origin' });

  const key = process.env.PROD_API_KEY;
  if (!key) return res.status(500).json({ error: 'missing_server_key' });

  const { kind, from, to, machine_id: machineId } = req.query || {};
  if (kind !== 'sq' && kind !== 'saw') return res.status(400).json({ error: 'bad_kind' });
  if (!isDate(from) || !isDate(to)) return res.status(400).json({ error: 'bad_date' });
  if (String(from) > String(to)) return res.status(400).json({ error: 'bad_range' });

  const qs = new URLSearchParams({ kind: String(kind), from: String(from), to: String(to) });
  if (machineId) qs.set('machine_id', String(machineId));

  try {
    const r = await fetch(UPSTREAM + '?' + qs.toString(), { headers: { 'x-api-key': key } });
    const body = await r.text();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // แคชไว้ที่ขอบ 5 นาที — ฝ่ายผลิตขอว่าอย่าดึงถี่ หลายเครื่องเปิดพร้อมกันจะได้ยิงขึ้นต้นทางครั้งเดียว
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(r.status).send(body);
  } catch (e) {
    // ไม่ส่งรายละเอียดข้อผิดพลาดกลับไปหน้าเว็บ กันข้อมูลฝั่ง server รั่ว
    return res.status(502).json({ error: 'upstream_failed' });
  }
}
