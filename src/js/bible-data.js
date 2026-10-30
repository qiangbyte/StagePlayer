// 和合本圣经数据：惰性加载 + 书卷定位 / 经文检索

let dataPromise = null;
let data = null;

/** 常见别名 → 书卷 sn */
const ALIAS = {
  创世记: 1, 创: 1, 出埃及记: 2, 出: 2, 利未记: 3, 利: 3, 民数记: 4, 民: 4,
  申命记: 5, 申: 5, 约书亚记: 6, 书: 6, 约书亚: 6, 士师记: 7, 士: 7,
  路得记: 8, 得: 8, 撒母耳记上: 9, 撒上: 9, 撒母耳记下: 10, 撒下: 10,
  列王纪上: 11, 王上: 11, 列王纪下: 12, 王下: 12,
  历代志上: 13, 代上: 13, 历代志下: 14, 代下: 14,
  以斯拉记: 15, 拉: 15, 尼希米记: 16, 尼: 16, 以斯帖记: 17, 斯: 17,
  约伯记: 18, 伯: 18, 诗篇: 19, 诗: 19, 箴言: 20, 箴: 20,
  传道书: 21, 传: 21, 雅歌: 22, 歌: 22,
  以赛亚书: 23, 赛: 23, 以赛亚: 23, 耶利米书: 24, 耶: 24, 耶利米: 24,
  耶利米哀歌: 25, 哀: 25, 以西结书: 26, 结: 26, 以西结: 26,
  但以理书: 27, 但: 27, 但以理: 27,
  何西阿书: 28, 何: 28, 约珥书: 29, 珥: 29, 阿摩司书: 30, 摩: 30,
  俄巴底亚书: 31, 俄: 31, 约拿书: 32, 拿: 32, 弥迦书: 33, 弥: 33,
  那鸿书: 34, 鸿: 34, 哈巴谷书: 35, 哈: 35, 西番雅书: 36, 番: 36,
  哈该书: 37, 该: 37, 撒迦利亚书: 38, 亚: 38, 玛拉基书: 39, 玛: 39,
  马太福音: 40, 太: 40, 马太: 40, 马可福音: 41, 可: 41, 马可: 41,
  路加福音: 42, 路: 42, 路加: 42, 约翰福音: 43, 约: 43, 约翰: 43,
  使徒行传: 44, 徒: 44, 罗马书: 45, 罗: 45, 罗马: 45,
  哥林多前书: 46, 林前: 46, 哥林多后书: 47, 林后: 47,
  加拉太书: 48, 加: 48, 以弗所书: 49, 弗: 49, 以弗所: 49,
  腓立比书: 50, 腓: 50, 腓立比: 50, 歌罗西书: 51, 西: 51, 歌罗西: 51,
  帖撒罗尼迦前书: 52, 帖前: 52, 帖撒罗尼迦后书: 53, 帖后: 53,
  提摩太前书: 54, 提前: 54, 提摩太后书: 55, 提后: 55,
  提多书: 56, 多: 56, 腓利门书: 57, 门: 57,
  希伯来书: 58, 来: 58, 希伯来: 58, 雅各书: 59, 雅: 59, 雅各: 59,
  彼得前书: 60, 彼前: 60, 彼得后书: 61, 彼后: 61,
  约翰壹书: 62, 约壹: 62, 约翰一书: 62, 约一: 62,
  约翰贰书: 63, 约贰: 63, 约翰二书: 63, 约二: 63,
  约翰叁书: 64, 约叁: 64, 约翰三书: 64, 约三: 64,
  犹大书: 65, 犹: 65, 启示录: 66, 启: 66, 启示: 66,
};

export async function ensureBible() {
  if (data) return data;
  if (!dataPromise) {
    dataPromise = fetch(new URL('../data/bible-cuv.json', import.meta.url))
      .then((r) => {
        if (!r.ok) throw new Error('无法加载圣经数据');
        return r.json();
      })
      .then((d) => {
        data = d;
        // 用数据里的简称/全称补全别名
        for (const b of d.books || []) {
          if (b.short) ALIAS[b.short] = b.sn;
          if (b.name) ALIAS[b.name] = b.sn;
          if (b.py) ALIAS[String(b.py).toUpperCase()] = b.sn;
        }
        return d;
      })
      .catch((err) => {
        dataPromise = null;
        throw err;
      });
  }
  return dataPromise;
}

export function getBooks() {
  return data?.books || [];
}

export function getBook(sn) {
  return (data?.books || []).find((b) => b.sn === +sn) || null;
}

export function chapterCount(sn) {
  const book = getBook(sn);
  if (!book) return 0;
  const chMap = data?.v?.[sn];
  if (!chMap) return book.chapters || 0;
  return Math.max(book.chapters || 0, ...Object.keys(chMap).map(Number));
}

export function verseCount(sn, ch) {
  const map = data?.v?.[sn]?.[ch];
  if (!map) return 0;
  return Math.max(0, ...Object.keys(map).map(Number));
}

export function getVerse(sn, ch, vs) {
  return data?.v?.[sn]?.[ch]?.[vs] || '';
}

export function getVerses(sn, ch, from, to) {
  const start = Math.min(+from, +to);
  const end = Math.max(+from, +to);
  const list = [];
  for (let n = start; n <= end; n++) {
    const text = getVerse(sn, ch, n);
    if (text) list.push({ n, text });
  }
  return list;
}

export function resolveBookName(name) {
  const key = String(name || '').trim().replace(/\s+/g, '');
  if (!key) return null;
  if (ALIAS[key] != null) return getBook(ALIAS[key]);
  const upper = key.toUpperCase();
  if (ALIAS[upper] != null) return getBook(ALIAS[upper]);
  // 模糊：全称包含
  const hit = (data?.books || []).find((b) => b.name === key || b.short === key
    || b.name.includes(key) || key.includes(b.name));
  return hit || null;
}

/**
 * 解析经文引用：约3:16 / 约翰福音 3:16-18 / 诗23:1
 * @returns {{ book, chapter, from, to } | null}
 */
export function parseReference(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  // 书名 + 章:节[-节]
  const m = raw.match(/^(.+?)\s*(\d+)\s*[:：]\s*(\d+)(?:\s*[-–—~～]\s*(\d+))?$/);
  if (!m) return null;
  const book = resolveBookName(m[1]);
  if (!book) return null;
  const chapter = +m[2];
  const from = +m[3];
  const to = m[4] != null ? +m[4] : from;
  if (!chapter || !from) return null;
  return { book, chapter, from, to };
}

/** 关键字搜索（限量，避免卡顿） */
export function searchKeyword(q, limit = 40) {
  const needle = String(q || '').trim();
  if (!needle || !data?.v) return [];
  const hits = [];
  for (const book of data.books) {
    const chMap = data.v[book.sn];
    if (!chMap) continue;
    for (const ch of Object.keys(chMap)) {
      const vsMap = chMap[ch];
      for (const vs of Object.keys(vsMap)) {
        const text = vsMap[vs];
        if (text && text.includes(needle)) {
          hits.push({
            sn: book.sn,
            bookName: book.name,
            short: book.short,
            chapter: +ch,
            verse: +vs,
            text,
          });
          if (hits.length >= limit) return hits;
        }
      }
    }
  }
  return hits;
}

export function formatRef(book, chapter, from, to = from) {
  const name = book?.short || book?.name || '';
  if (from === to) return `${name}${chapter}:${from}`;
  return `${name}${chapter}:${from}-${to}`;
}

export function formatRefFull(book, chapter, from, to = from) {
  const name = book?.name || book?.short || '';
  if (from === to) return `${name} ${chapter}:${from}`;
  return `${name} ${chapter}:${from}-${to}`;
}
