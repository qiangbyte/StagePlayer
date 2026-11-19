import { esc, lsGet, lsSet } from './util.js';

const KEY = 'sp.stage.notes';
const DEFAULT_COLOR = '#ffe08a';
const $ = (id) => document.getElementById(id);

let notes = loadNotes();

function validColor(value) {
  return /^#[\da-f]{6}$/i.test(value || '') ? value : DEFAULT_COLOR;
}

function loadNotes() {
  const saved = lsGet(KEY, []);
  if (!Array.isArray(saved)) return [];
  return saved.filter((note) => note && typeof note === 'object').map((note, index) => ({
    id: String(note.id || `note-${index}`),
    text: String(note.text || ''),
    color: validColor(note.color),
  }));
}

function save() {
  lsSet(KEY, notes);
}

function render() {
  const list = $('stage-note-list');
  if (!list) return;
  if (!notes.length) {
    list.innerHTML = '<div class="stage-notes-empty">点击“＋ 添加一行”记录上台时间、流程或提醒</div>';
    return;
  }
  list.innerHTML = notes.map((note) => `
    <div class="stage-note-row" data-note-id="${esc(note.id)}" style="--note-color:${validColor(note.color)}">
      <input class="stage-note-text" type="text" maxlength="120" value="${esc(note.text)}" placeholder="例如：19:30 演员上台" aria-label="演出备忘内容">
      <input class="stage-note-color" type="color" value="${validColor(note.color)}" title="设置这行文字颜色" aria-label="设置文字颜色">
      <button class="stage-note-delete" type="button" title="删除这行" aria-label="删除这行">×</button>
    </div>`).join('');
}

function addNote(afterId = null) {
  const note = { id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text: '', color: DEFAULT_COLOR };
  const index = notes.findIndex((item) => item.id === afterId);
  notes.splice(index < 0 ? notes.length : index + 1, 0, note);
  save();
  render();
  const input = [...($('stage-note-list')?.querySelectorAll('.stage-note-row') || [])]
    .find((row) => row.dataset.noteId === note.id)?.querySelector('.stage-note-text');
  input?.focus();
}

export function initStageNotes() {
  const root = $('stage-notes');
  const list = $('stage-note-list');
  if (!root || !list) return;
  render();

  $('stage-note-add')?.addEventListener('click', () => addNote());
  list.addEventListener('input', (event) => {
    const row = event.target.closest('.stage-note-row');
    const note = notes.find((item) => item.id === row?.dataset.noteId);
    if (!note) return;
    if (event.target.matches('.stage-note-text')) {
      note.text = event.target.value;
    } else if (event.target.matches('.stage-note-color')) {
      note.color = validColor(event.target.value);
      row.style.setProperty('--note-color', note.color);
      row.querySelector('.stage-note-text')?.style.setProperty('color', note.color);
    } else {
      return;
    }
    save();
  });
  list.addEventListener('click', (event) => {
    const button = event.target.closest('.stage-note-delete');
    if (!button) return;
    const row = button.closest('.stage-note-row');
    notes = notes.filter((item) => item.id !== row?.dataset.noteId);
    save();
    render();
  });
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.target.matches('.stage-note-text')) return;
    event.preventDefault();
    addNote(event.target.closest('.stage-note-row')?.dataset.noteId);
  });
}
