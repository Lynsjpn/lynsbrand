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
  { file: 'impor-notion-riset-distrik.json',     id: '3a42f4b9ccd147b1a522dbdb2cd99338', source: 'riset-distrik', nama: '🏛️ Riset Layanan Pemda per Distrik', risetDistrik: true },
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
  // <br> kadang ikut terbawa dari teks Notion — ubah jadi baris baru sungguhan,
  // kalau tidak akan tampil mentah sebagai "<br>" di kartu Bank Materi.
  for (const n of nama) if (props[n]) return teks(props[n]).replace(/<br\s*\/?>/gi, '\n');
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

/* ── Isi HALAMAN Notion (blok) → naskah materi ───────────────────────────────
   Naskah lengkap (isi slide, caption, prompt Canva) ditulis di badan halaman,
   bukan di properti. Bagian ini membacanya lalu merangkainya jadi teks biasa. */
const jeda = ms => new Promise(r => setTimeout(r, ms));

function rtTeks(rt) {
  return (rt || []).map(t => t.plain_text).join('');
}
function blokKeTeks(blok, indent = '', nomor = null) {
  const t = blok.type;
  const isi = blok[t] || {};
  const teks = rtTeks(isi.rich_text);
  switch (t) {
    case 'heading_1':          return indent + '# ' + teks;
    case 'heading_2':          return indent + '## ' + teks;
    case 'heading_3':          return indent + '### ' + teks;
    case 'paragraph':          return indent + teks;
    case 'bulleted_list_item': return indent + '- ' + teks;
    case 'numbered_list_item': return indent + (nomor ? nomor + '. ' : '- ') + teks;
    case 'to_do':              return indent + (isi.checked ? '[x] ' : '[ ] ') + teks;
    case 'quote':              return indent + '> ' + teks;
    case 'callout':            return indent + (isi.icon && isi.icon.emoji ? isi.icon.emoji + ' ' : '') + teks;
    case 'toggle':             return indent + '▸ ' + teks;
    case 'code':               return indent + '```\n' + teks + '\n```';
    case 'divider':            return indent + '———';
    default:                   return teks ? indent + teks : '';
  }
}
async function ambilBlok(blokId) {
  const hasil = [];
  let cursor;
  do {
    const url = `https://api.notion.com/v1/blocks/${blokId}/children?page_size=100` + (cursor ? `&start_cursor=${cursor}` : '');
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28' } });
    if (!r.ok) return hasil;                       // halaman tanpa akses/kosong — biarkan saja
    const j = await r.json();
    hasil.push(...j.results);
    cursor = j.has_more ? j.next_cursor : null;
    if (cursor) await jeda(120);
  } while (cursor);
  return hasil;
}
async function naskahHalaman(pageId, dalam = 0) {
  const blok = await ambilBlok(pageId);
  const baris = [];
  let hitungNomor = 0;
  for (const b of blok) {
    if (b.type === 'numbered_list_item') hitungNomor++; else hitungNomor = 0;
    const t = blokKeTeks(b, '  '.repeat(dalam), hitungNomor || null);
    if (t) baris.push(t);
    // satu tingkat anak saja — cukup untuk toggle/list bersarang, tanpa boros permintaan
    if (b.has_children && dalam < 1) {
      await jeda(120);
      const anak = await naskahHalaman(b.id, dalam + 1);
      if (anak) baris.push(anak);
    }
  }
  return baris.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ── Ubah satu halaman Notion jadi item Bank Materi ──────────────────────── */
function keItem(page, db) {
  const p = page.properties || {};
  const judul = judulDari(p);
  if (!judul.trim()) return null;                       // baris kosong di Notion — lewati

  // ── Riset Layanan Pemda per Distrik: satu baris = satu distrik, isinya rangkuman
  //    panjang. Judulnya diberi awalan supaya jelas ini bahan riset, bukan ide post. ──
  if (db.risetDistrik) {
    const ringkasan = ambil(p, 'Ringkasan Dukungan');
    if (!ringkasan.trim()) return null;                 // distrik yang belum diriset — lewati
    const conf = ambil(p, 'Confidence');
    const bagianR = [];
    // Confidence apa pun yang bukan "Solid…" berarti belum tentu dari sumber resmi.
    if (conf && !/^solid/i.test(conf)) bagianR.push('⚠️ PERLU VERIFIKASI — tingkat keyakinan di Notion: ' + conf);
    else if (conf) bagianR.push('🔒 Keyakinan: ' + conf);
    const tgl = ambil(p, 'Tanggal Riset');
    const kat = ambil(p, 'Kategori');
    if (tgl || kat) bagianR.push([tgl && ('🗓️ Tanggal riset: ' + tgl), kat && ('🏷️ Kategori: ' + kat)].filter(Boolean).join(' · '));
    bagianR.push('📋 RINGKASAN DUKUNGAN\n' + ringkasan);
    const sumber = ambil(p, 'Sumber');
    if (sumber) bagianR.push('🔗 SUMBER\n' + sumber);
    if (ambil(p, 'Sudah Masuk Content Bank') === 'YA') bagianR.push('✅ Di Notion sudah ditandai masuk Content Bank.');

    return {
      notion_id: String(page.id || '').replace(/-/g, ''),
      judul: 'Riset distrik: ' + judul.trim(),
      pilar: 'Pilar 1 · Distrik & Ranking',
      status: 'Ide',
      format: 'Carousel',
      prioritas: 'Sedang',
      hook: '',
      catatan: bagianR.join('\n\n'),
      dibuat: page.created_time || '',
      diubah: page.last_edited_time || '',
      source: db.source,
    };
  }

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
    dibuat: page.created_time || '',        // dipakai untuk urutan "terbaru / terlama"
    diubah: page.last_edited_time || '',
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

    // Naskah = isi halaman Notion. Hanya ditarik ulang untuk halaman yang BERUBAH
    // (bandingkan last_edited_time), supaya tidak ratusan permintaan tiap 3 jam.
    const naskahLama = new Map();
    if (lama && Array.isArray(lama.items)) {
      lama.items.forEach(it => { if (it.notion_id) naskahLama.set(it.notion_id, it); });
    }
    let ditarikBaru = 0, dipakaiUlang = 0;
    for (const it of items) {
      const sebelumnya = naskahLama.get(it.notion_id);
      if (sebelumnya && sebelumnya.diubah === it.diubah && typeof sebelumnya.naskah === 'string') {
        it.naskah = sebelumnya.naskah; dipakaiUlang++;
        continue;
      }
      it.naskah = await naskahHalaman(it.notion_id);
      ditarikBaru++;
      await jeda(140);                         // jaga di bawah batas laju Notion
    }
    console.log(`  · naskah: ${ditarikBaru} ditarik, ${dipakaiUlang} dipakai ulang`);
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
