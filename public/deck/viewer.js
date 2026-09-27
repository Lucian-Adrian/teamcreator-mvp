const $ = (selector) => document.querySelector(selector);
const image = $('#slide');
const picker = $('#slide-picker');
const error = $('#load-error');
let slides = [];
let index = 0;
let section = 'pitch';
let idleTimer;
let touchStart;
const last = () => section === 'pitch' ? 14 : 26;
const first = () => section === 'pitch' ? 0 : 15;

function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  if (document.body.classList.contains('presenting') && !picker.open) {
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 2000);
  }
}
function syncPresentation() {
  const active = Boolean(document.fullscreenElement) || document.body.dataset.fallback === 'true';
  document.body.classList.toggle('presenting', active);
  $('#fullscreen').setAttribute('aria-pressed', String(active));
  $('#fullscreen').textContent = active ? 'Exit fullscreen' : 'Fullscreen';
  $('#leave-fullscreen').hidden = !active;
  if (!active) document.body.classList.remove('idle');
  wake();
}
async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.body.dataset.fallback === 'true') delete document.body.dataset.fallback;
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else document.body.dataset.fallback = 'true';
  } catch {
    document.body.dataset.fallback = document.body.dataset.fallback === 'true' ? 'false' : 'true';
  }
  syncPresentation();
}
function show(next, updateHash = true) {
  if (!slides.length) return;
  index = Math.max(0, Math.min(slides.length - 1, next));
  section = index < 15 ? 'pitch' : 'qa';
  const slide = slides[index];
  error.hidden = true;
  image.src = slide.src;
  image.alt = `Slide ${index + 1}. ${slide.alt || slide.title}`;
  $('#counter').textContent = `${section === 'pitch' ? index + 1 : index - 14} / ${section === 'pitch' ? 15 : 12}`;
  $('#slide-title').textContent = slide.title;
  $('#pitch').setAttribute('aria-pressed', String(section === 'pitch'));
  $('#qa').setAttribute('aria-pressed', String(section === 'qa'));
  $('#previous').disabled = index === first();
  $('#next').disabled = index === last();
  $('#enter-qa').hidden = index !== 14;
  document.title = `${slide.title} | TeamCreator`;
  for (const button of picker.querySelectorAll('[data-index]')) button.setAttribute('aria-current', String(Number(button.dataset.index) === index));
  if (updateHash) history.replaceState(null, '', `#slide-${index + 1}`);
  for (const neighbor of [index + 1, index - 1]) if (slides[neighbor]) { const preload = new Image(); preload.src = slides[neighbor].src; }
  if (!document.body.classList.contains('presenting')) wake();
}
function fromHash() {
  const match = location.hash.match(/^#slide-(\d+)$/);
  show(match ? Number(match[1]) - 1 : 0, false);
}
function move(direction) {
  const target = index + direction;
  if (target >= first() && target <= last()) show(target);
}
function choose() { picker.showModal(); wake(); }
function closePicker() { picker.close(); $('#choose').focus(); wake(); }
function buildPicker() {
  for (const [i, slide] of slides.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.index = i;
    const number = document.createElement('span');
    number.className = 'number'; number.textContent = String(i + 1).padStart(2, '0');
    const label = document.createElement('span'); label.textContent = slide.title;
    if (slide.question) { const q = document.createElement('span'); q.className = 'question'; q.textContent = slide.question; label.append(q); }
    button.append(number, label);
    button.addEventListener('click', () => { show(i); closePicker(); });
    $(i < 15 ? '#pitch-list' : '#qa-list').append(button);
  }
}
$('#previous').addEventListener('click', () => move(-1));
$('#next').addEventListener('click', () => move(1));
$('#pitch').addEventListener('click', () => show(0));
$('#qa').addEventListener('click', () => show(15));
$('#enter-qa').addEventListener('click', () => show(15));
$('#choose').addEventListener('click', choose);
$('#close-picker').addEventListener('click', closePicker);
picker.addEventListener('close', wake);
$('#fullscreen').addEventListener('click', fullscreen);
$('#leave-fullscreen').addEventListener('click', fullscreen);
$('#retry').addEventListener('click', () => { error.hidden = true; image.src = `${slides[index].src}?retry=${Date.now()}`; });
image.addEventListener('error', () => { error.hidden = false; });
document.addEventListener('fullscreenchange', syncPresentation);
window.addEventListener('hashchange', fromHash);
document.addEventListener('pointermove', wake, { passive: true });
document.addEventListener('pointerdown', wake, { passive: true });
document.addEventListener('keydown', (event) => {
  if (picker.open || event.altKey || event.ctrlKey || event.metaKey) return;
  const focusedControl = event.target.closest('button, a, input, select, textarea');
  if (event.key === ' ' && focusedControl) return;
  const key = event.key.toLowerCase();
  if (['arrowright', 'arrowdown', 'pagedown', ' '].includes(key)) { event.preventDefault(); move(1); }
  else if (['arrowleft', 'arrowup', 'pageup'].includes(key)) { event.preventDefault(); move(-1); }
  else if (key === 'home') { event.preventDefault(); show(first()); }
  else if (key === 'end') { event.preventDefault(); show(last()); }
  else if (key === 'f') { event.preventDefault(); fullscreen(); }
  else if (key === 's') { event.preventDefault(); choose(); }
  else if (key === 'escape' && document.body.dataset.fallback === 'true') { delete document.body.dataset.fallback; syncPresentation(); }
});
$('.stage').addEventListener('touchstart', (event) => { touchStart = { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY }; }, { passive: true });
$('.stage').addEventListener('touchend', (event) => {
  if (!touchStart) return;
  const dx = event.changedTouches[0].clientX - touchStart.x;
  const dy = event.changedTouches[0].clientY - touchStart.y;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) move(dx < 0 ? 1 : -1);
  touchStart = undefined;
}, { passive: true });

fetch('/deck/slides.json', { cache: 'no-cache' }).then((response) => {
  if (!response.ok) throw new Error('Manifest unavailable');
  return response.json();
}).then((manifest) => {
  slides = manifest.slides;
  buildPicker();
  fromHash();
  // Load the remaining images in the background before they are needed on stage.
  const queue = slides.filter((_, i) => i !== index).map((slide) => slide.src);
  const preload = async () => { while (queue.length) { const item = new Image(); item.src = queue.shift(); try { await item.decode(); } catch { /* On-screen navigation can retry. */ } } };
  setTimeout(() => { preload(); preload(); }, 500);
}).catch(() => { $('#counter').textContent = 'Slides unavailable'; $('#slide-title').textContent = 'Reload this page to try again'; });
