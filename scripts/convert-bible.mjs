import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const idSql = fs.readFileSync('E:/my/mlztai/bibleid.sql', 'utf8');
const bibleSql = fs.readFileSync('E:/my/mlztai/bible.sql', 'utf8');
const outDir = path.join(root, 'src', 'data');
fs.mkdirSync(outDir, { recursive: true });

function parseInserts(sql, table) {
  const re = new RegExp(`INSERT INTO \`${table}\` VALUES \\((.+?)\\);`, 'g');
  const rows = [];
  let m;
  while ((m = re.exec(sql))) rows.push(m[1]);
  return rows;
}

function splitSqlValues(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (s[i] === ' ' || s[i] === ',')) i++;
    if (i >= s.length) break;
    if (s[i] === "'") {
      let j = i + 1;
      let val = '';
      while (j < s.length) {
        if (s[j] === '\\' && j + 1 < s.length) {
          val += s[j + 1];
          j += 2;
          continue;
        }
        if (s[j] === "'") {
          if (s[j + 1] === "'") {
            val += "'";
            j += 2;
            continue;
          }
          j++;
          break;
        }
        val += s[j++];
      }
      out.push(val);
      i = j;
    } else {
      let j = i;
      while (j < s.length && s[j] !== ',') j++;
      const raw = s.slice(i, j).trim();
      out.push(raw === 'NULL' ? null : (/^-?\d+$/.test(raw) ? Number(raw) : raw));
      i = j;
    }
  }
  return out;
}

const books = parseInserts(idSql, 'bibleid').map((line) => {
  const [sn, kindsn, chapternumber, neworold, pinyin, shortname, fullname] = splitSqlValues(line);
  return {
    sn: +sn,
    kind: +kindsn || 0,
    chapters: +chapternumber || 0,
    nt: +neworold === 1,
    py: String(pinyin || ''),
    short: String(shortname || ''),
    name: String(fullname || ''),
  };
});

const v = {};
let verseCount = 0;
for (const line of parseInserts(bibleSql, 'bible')) {
  const vals = splitSqlValues(line);
  const sn = +vals[1];
  const ch = +vals[2];
  const vs = +vals[3];
  const text = String(vals[4] ?? '');
  if (!v[sn]) v[sn] = {};
  if (!v[sn][ch]) v[sn][ch] = {};
  v[sn][ch][vs] = text;
  verseCount++;
}

const outPath = path.join(outDir, 'bible-cuv.json');
fs.writeFileSync(outPath, JSON.stringify({ ver: 'cuv', books, v }), 'utf8');
console.log({
  books: books.length,
  verses: verseCount,
  bytes: fs.statSync(outPath).size,
  sample: v[43]?.[3]?.[16],
});
