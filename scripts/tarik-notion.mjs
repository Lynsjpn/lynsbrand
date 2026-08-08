/**
 * Tarik semua materi dari Notion → tulis ulang berkas impor-notion-*.json.
 * Dijalankan otomatis oleh GitHub Actions (lihat .github/workflows/sinkron-notion.yml),
 * jadi aplikasi cukup menekan "🔄 Sinkron dari Notion" tanpa bantuan siapa pun.
 *
 * Butuh satu rahasia repo: NOTION_TOKEN (token integrasi internal Notion).
 * Tidak memakai dependensi apa pun — hanya fetch bawaan Node 20.
 */
import { readFile, writeFile } from 'node:fs/promises';

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) {
  console.error('❌ NOTION_TOKEN belum diisi. Tambahkan di Settings → Secrets and variables → Actions.');
  process.exit(1);
}

const DATABASES = [
  { file: 'impor-notion-content-bank.json',      id: '4848cfba98ca44438d7b1d60462aed50', source: 'content-bank', nama: '📚 Content Bank' },
  { file: 'impor-notion-trivia-tambahan.json',   id: 'b30d31f33d954b82b6879256db9be53b', source: 'trivia',       nama: 'Content Bank (arsip trivia)', arsipTrivia: true },
  { file: 'impor-notion-log-mingguan.json',      id: '59a7905eccdc4d85a5d5fe06b66908b2', source: 'log-mingguan', nama: '📝 Log Materi Mingguan' },
];

/* ── Pemetaan nilai Notion → nilai yang dipakai aplikasi ─────────────────── */
const STATUS = { 'Ide':'Ide','Draft':'Draft','Siap':'Siap','Terjadwal':'Terjadwal','Tayang':'Tayang',
                 'Not started':'Ide','In progress':'Draft','Done':'Siap' };
const FORMAT = { 'Carousel':'Carousel','Single':'Single','Video / Reel':'Video / Reel','Reel':'Video / Reel' };
const PRIO   = { 'Tinggi':'Tinggi','Sedang':'Sedang','Rendah':'Rendah','High':'Tinggi','Medium':'Sedang','Low':'Rendah' };

function canonicalPilar(s) {
  const t = String(s || '');
  if (/pilar\s*1/i.test(t)) return 'Pilar 1 · Distrik & Ranking';
  if (/pilar\s*2/i.test(t)) return 'Pilar 2 · 雑学 / 豆知識';
  if (/pilar\s*3/i.test(t)) return 'Pilar 3 · Hidup & Kerja';
  return t;
}

/** Ubah satu properti Notion apa pun jadi teks biasa. */
function teks(p) {
  if (!p) return '';
  switch (p.type) {
    case 'title':      return (p.title || []).map(t => t.plain_text).join('');
    case 'rich_text':  return (p.rich_text || []).map(t => t.plain_text).join('');
    case 'select':     return p.select ? p.select.name : '';
    case 'status':     return p.status ? p.status.name : '';
    case 'multi_select': return (p.multi_select || []).map(o => o.name).join(', ');
    case 'checkbox':   return p.checkbox ? 'YA' : '';
    case 'number':     return p.number == null ? '' : String(p.number);
    case 'url':        return p.url || '';
    case 'date':       return p.date ? (p.date.start || '') : '';
    default:           return '';
  }
}
/** Ambil properti pertama yang cocok dari beberapa kemungkinan nama. */
function ambil(props, ...nama) {
  for (const n of nama) if (props[n]) return teks(props[n]);
  return '';
}
function judulDari(props) {
  for (const k of Object.keys(props)) if (props[k].type === 'title') return teks(props[k]);
  return '';
}

/* ── Ambil seluruh baris satu database (dengan paginasi) ─────────────────── */
async function tarikDatabase(dbId) {
  const hasil = [];
  let cursor;
  do {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cursor ? { page_size: 100, start_cursor: cursor } : { page_size: 100 }),
    });
    if (!r.ok) {
      const pesan = await r.text();
      throw new Error(`Notion HTTP ${r.status} untuk database ${dbId}: ${pesan.slice(0, 300)}`);
    }
    const j = await r.json();
    hasil.push(...j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return hasil;
}

/* ── Ubah satu halaman Notion jadi item Bank Materi ──────────────────────── */
function keItem(page, db) {
  const p = page.properties || {};
  const judul = judulDari(p);
  if (!judul.trim()) return null;                       // baris kosong di Notion — lewati

  const bagian = [];
  const perluVerifikasi = ambil(p, 'Perlu Verifikasi') === 'YA';
  const sudahDiBank     = ambil(p, 'Sudah Masuk Content Bank') === 'YA';

  if (perluVerifikasi) bagian.push('⚠️ PERLU VERIFIKASI (ditandai di Notion) — jangan tayangkan angka sebelum dicek ke sumber resmi.');
  if (sudahDiBank)     bagian.push('✅ Di Notion sudah ditandai masuk Content Bank — cek dulu, mungkin sudah ada versinya di bank ini.');

  const kenapa = ambil(p, 'Kenapa Menarik');
  if (kenapa) bagian.push('💡 KENAPA MENARIK: ' + kenapa);

  const catatan = ambil(p, 'Catatan', 'Notes');
  if (catatan) bagian.push('📝 CATATAN: ' + catatan);

  const sumberProp = ambil(p, 'Sumber');
  if (sumberProp && sumberProp !== 'Ranking / Data resmi') bagian.push('🔖 Jenis sumber (Notion): ' + sumberProp);

  const minggu = ambil(p, 'Minggu');
  if (minggu) bagian.push('🗓️ Minggu (Notion): ' + minggu);

  // Arsip trivia: pilar aslinya bukan format 3-pilar brand, jadi dipetakan ke Pilar 2
  // dan label aslinya disimpan di catatan supaya tidak hilang.
  let pilar = canonicalPilar(ambil(p, 'Pilar', 'Pillar'));
  if (db.arsipTrivia) {
    const asli = ambil(p, 'Pillar', 'Pilar');
    pilar = 'Pilar 2 · 雑学 / 豆知識';
    if (asli) bagian.push(`(arsip trivia · pilar asli: ${asli})`);
  }

  return {
    notion_id: String(page.id || '').replace(/-/g, ''),
    judul: judul.trim(),
    pilar: pilar || '',
    status: STATUS[ambil(p, 'Status')] || 'Ide',
    format: FORMAT[ambil(p, 'Format')] || 'Carousel',
    prioritas: PRIO[ambil(p, 'Prioritas', 'Priority')] || 'Sedang',
    hook: ambil(p, 'Hook / CTA', 'Hook (ID)', 'Hook'),
    catatan: bagian.join('\n\n'),
    source: db.source,
  };
}

/* ── Jalankan ────────────────────────────────────────────────────────────── */
let adaPerubahan = false;
let gagal = 0;

for (const db of DATABASES) {
  try {
    const halaman = await tarikDatabase(db.id);
    const items = halaman.map(h => keItem(h, db)).filter(Boolean)
                         .sort((a, b) => a.judul.localeCompare(b.judul, 'id'));

    // Bandingkan hanya isi materinya. Kalau sama persis, berkas TIDAK ditulis ulang
    // supaya tidak lahir commit kosong tiap jam.
    let lama = null;
    try { lama = JSON.parse(await readFile(db.file, 'utf8')); } catch { /* berkas baru */ }
    if (lama && JSON.stringify(lama.items) === JSON.stringify(items)) {
      console.log(`= ${db.file}: ${items.length} materi, tidak ada perubahan`);
      continue;
    }

    await writeFile(db.file, JSON.stringify({
      sumber_db: db.nama,
      notion_db: db.id,
      ditarik: new Date().toISOString().slice(0, 10),
      catatan_format: "Ditarik otomatis dari Notion oleh GitHub Actions. Field 'Kenapa Menarik' & 'Catatan' digabung ke catatan riset; tanda ⚠️ berasal dari properti 'Perlu Verifikasi'.",
      items,
    }, null, 2) + '\n', 'utf8');

    console.log(`✔ ${db.file}: ${items.length} materi (diperbarui)`);
    adaPerubahan = true;
  } catch (e) {
    console.error(`❌ ${db.file}: ${e.message}`);
    gagal++;
  }
}

if (gagal === DATABASES.length) {
  console.error('❌ Semua database gagal ditarik — periksa NOTION_TOKEN & apakah database sudah dibagikan ke integrasi.');
  process.exit(1);
}
console.log(adaPerubahan ? '➡️ Ada perubahan, siap di-commit.' : '➡️ Tidak ada perubahan.');
