// All website-derived data (titles, URLs, console text, step messages) is untrusted:
// render it with textContent / setAttribute only, never innerHTML.
const root = document.querySelector('#main');
// Each route renders into its own container, so a slow page that finishes late cannot leak into the next one.
let main = root;
const notice = document.querySelector('#notice');
const el = (tag, text, parent, cls) => {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (cls) node.className = cls;
  if (parent) parent.append(node);
  return node;
};
// Icons: inline SVG paths drawn for this dashboard (24px grid, 1.75 stroke), built with createElementNS.
const ICONS = {
  overview: 'M3 3h7v9H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 16h7v5H3z',
  sessions: 'M8 6h13 M8 12h13 M8 18h13 M3.5 6h.01 M3.5 12h.01 M3.5 18h.01',
  settings: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
  clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M12 7v5l3 2',
  image: 'M3 5h18v14H3z M3 16l5-5 4 4 3-3 6 6 M15.5 8.5h.01',
  video: 'M3 6h12v12H3z M15 10l6-3v10l-6-3z',
  alert: 'M12 3 2 20h20z M12 9v5 M12 17h.01',
  workflow: 'M4 3h5v5H4z M15 16h5v5h-5z M6.5 8v3a2 2 0 0 0 2 2h7a2 2 0 0 1 2 2v1',
  trace: 'M14 3H6v18h12V7z M14 3v4h4 M9 13h6 M9 17h6',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 21h16',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  prev: 'M15 18l-6-6 6-6',
  next: 'M9 18l6-6-6-6',
  close: 'M6 6l12 12 M18 6 6 18',
  moon: 'M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8 M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  globe:
    'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M3 12h18 M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9 M12 3c-2.5 2.5-3.5 5.5-3.5 9s1 6.5 3.5 9',
  tag: 'M3 3h8l10 10-8 8L3 11z M7.5 7.5h.01',
  tools: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
  proxy: 'M4 7h16 M16 3l4 4-4 4 M20 17H4 M8 13l-4 4 4 4',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4',
  check: 'M5 12l5 5 9-10',
  navigate: 'M5 12h14 M13 6l6 6-6 6',
  action: 'M5 4l6.5 16 2.2-6.8L20.5 11z',
  start: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M10 8.5v7l5.5-3.5z',
  stop: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M9 9h6v6H9z',
  dialog: 'M4 5h16v11H9l-5 4z',
  network: 'M5 9a10 10 0 0 1 14 0 M8 12.5a5.5 5.5 0 0 1 8 0 M12 16h.01 M3 3l18 18',
};
const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(name, parent, prepend = true) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    width: '16',
    height: '16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.75',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    class: 'icon',
  }))
    svg.setAttribute(k, v);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  if (parent) {
    if (prepend) parent.prepend(svg);
    else parent.append(svg);
  }
  return svg;
}
const eventIcon = (type) =>
  type === 'session.created'
    ? 'start'
    : type === 'session.closed'
      ? 'stop'
      : type === 'network.failed'
        ? 'network'
        : type.includes('error') || type.includes('failed')
          ? 'alert'
          : type.startsWith('navigation')
            ? 'navigate'
            : type.startsWith('action')
              ? 'action'
              : type.startsWith('screenshot')
                ? 'image'
                : type.startsWith('video')
                  ? 'video'
                  : type.startsWith('trace')
                    ? 'trace'
                    : type.startsWith('workflow')
                      ? 'workflow'
                      : type.startsWith('dialog')
                        ? 'dialog'
                        : 'clock';
const button = (text, parent, action, cls) => {
  const b = el('button', text, parent, cls);
  b.type = 'button';
  b.addEventListener('click', () => Promise.resolve().then(action).catch(showError));
  return b;
};
const say = (text, isError = false) => {
  notice.classList.toggle('is-error', isError);
  notice.textContent = text;
};
const showError = (e) => say(e.message, true);
async function api(url, options = {}) {
  const response = await fetch('/api/' + url, options);
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.issues ? data.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n') : data.error,
    );
  return data;
}
const pretty = (value) => JSON.stringify(value, null, 2);
const fileUrl = (file) =>
  typeof file?.url === 'string' && file.url.startsWith('/files/') && !file.url.includes('\\')
    ? file.url
    : null;
const fileName = (p) =>
  String(p ?? '')
    .split('/')
    .pop();
function linkFile(file, parent, title) {
  const url = fileUrl(file);
  if (!url) return;
  const a = el('a', title ?? fileName(file.path), parent);
  a.setAttribute('href', url);
  return a;
}
const dateTime = (ts) =>
  ts
    ? new Date(ts).toLocaleString('vi', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Chưa có hoạt động';
const clock = (ts) =>
  new Date(ts).toLocaleTimeString('vi', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const isBad = (type) => /failed|error/.test(type);
const statusPill = (status, parent) => {
  const text = { passed: 'Đạt', failed: 'Lỗi', running: 'Đang chạy', cancelled: 'Đã hủy' }[status] ?? status;
  const cls = status === 'passed' ? 'ok' : status === 'failed' ? 'bad' : 'warn';
  return el('span', text, parent, `pill ${cls}`);
};
function pageHead(title, lead, crumb) {
  const head = el('header', undefined, main, 'page-head');
  if (crumb) {
    const c = el('p', undefined, head, 'crumb');
    el('a', crumb.label, c).href = crumb.href;
  }
  el('h2', title, head);
  if (lead) el('p', lead, head, 'lead');
  return head;
}
function region(title, parent = main, aside) {
  const r = el('section', undefined, parent, 'region');
  const head = el('div', undefined, r, 'region-head');
  el('h3', title, head);
  if (aside) el('p', aside, head, 'muted');
  return r;
}
const empty = (text, parent) => el('p', text, parent, 'empty');

const COUNTS = [
  ['actions', 'Thao tác'],
  ['errors', 'Lỗi'],
  ['screenshots', 'Ảnh'],
  ['videos', 'Video'],
  ['traces', 'Trace'],
];
function sessionTable(sessions, parent) {
  if (!sessions.length)
    return empty('Chưa có session nào. Chạy một session qua MCP rồi tải lại trang', parent);
  const wrap = el('div', undefined, parent, 'table-wrap');
  const table = el('table', undefined, wrap);
  const head = el('tr', undefined, el('thead', undefined, table));
  el('th', 'Session', head);
  el('th', 'Hoạt động cuối', head);
  for (const [, label] of COUNTS) el('th', label, head, 'n');
  const body = el('tbody', undefined, table);
  for (const s of sessions) {
    const row = el('tr', undefined, body);
    const a = el('a', `${s.project} / ${s.name}`, el('td', undefined, row), 'session-link');
    a.href = `#session/${encodeURIComponent(s.project)}/${encodeURIComponent(s.name)}`;
    el('td', dateTime(s.lastActivity), row, 'muted');
    for (const [k] of COUNTS) {
      const v = s.counts[k] ?? 0;
      el('td', String(v), row, `n ${v === 0 ? 'zero' : k === 'errors' ? 'bad' : ''}`);
    }
  }
}

async function overview() {
  pageHead(
    'Tổng quan',
    'Những gì TG Browser đã ghi lại trên máy này: sessions, workflow và cấu hình đang dùng',
  );
  const loading = el('div', undefined, main, 'loading');
  const [status, sessions, runs] = await Promise.all([api('status'), api('sessions'), api('runs')]);
  loading.remove();

  const figures = el('dl', undefined, main, 'figures');
  const figure = (label, value, detail, iconName) => {
    const f = el('div', undefined, figures, 'figure');
    const dt = el('dt', label, f);
    if (iconName) icon(iconName, dt);
    const dd = el('dd', undefined, f);
    el('span', value, dd, 'value');
    if (detail) el('span', detail, dd, 'detail');
  };
  figure('Phiên bản', status.version, status.project ? `Dự án ${status.project}` : undefined, 'tag');
  figure(
    'Trình duyệt',
    status.browsers.map((b) => b.name).join(', ') || 'Chưa tìm thấy',
    status.browsers.length ? `${status.browsers.length} trình duyệt phát hiện` : 'Cài Chrome hoặc Edge',
    'globe',
  );
  const profiles = Object.entries(status.tools);
  const largest = profiles.reduce((a, b) => (b[1] > a[1] ? b : a));
  figure(
    `Tools, profile ${largest[0]}`,
    String(largest[1]),
    profiles.map(([p, n]) => `${p} ${n}`).join(', '),
    'tools',
  );
  const proxy = status.proxy ?? {};
  figure(
    'Proxy',
    proxy.server ?? (proxy.mode === 'system' ? 'Theo hệ thống' : (proxy.mode ?? 'Không')),
    proxy.credentialsMissing?.length
      ? `Thiếu biến: ${proxy.credentialsMissing.join(', ')}`
      : proxy.authenticated
        ? 'Có xác thực'
        : 'Không xác thực',
    'proxy',
  );
  const tls = status.certificates ?? {};
  figure(
    'TLS',
    tls.verifyTls ? 'Đang xác minh' : 'Không xác minh',
    tls.caFile ? `CA: ${fileName(tls.caFile)}` : 'Dùng kho chứng chỉ của hệ điều hành',
    'shield',
  );

  const recent = region('Sessions gần đây', main, sessions.length ? `${sessions.length} session` : undefined);
  sessionTable(sessions.slice(0, 8), recent);

  const wf = region('Workflow gần đây', main, runs.length ? `${runs.length} lần chạy` : undefined);
  if (!runs.length) empty('Chưa có workflow nào chạy', wf);
  const list = el('div', undefined, wf, 'runs');
  for (const r of runs.slice(0, 10)) await runView(r, list, false);
}

async function sessionList() {
  pageHead(
    'Sessions',
    'Mỗi session giữ nhật ký, ảnh chụp, video và trace riêng, kể cả sau khi tiến trình MCP đã thoát',
  );
  const [projects, sessions] = await Promise.all([api('projects'), api('sessions')]);
  const bar = el('div', undefined, main, 'toolbar');
  const pl = el('label', 'Dự án', bar),
    select = el('select', undefined, pl);
  el('option', 'Tất cả', select).value = '';
  projects.forEach((p) => (el('option', p, select).value = p));
  const label = el('label', 'Tìm session', bar),
    search = el('input', undefined, label);
  search.type = 'search';
  search.placeholder = 'Tên session';
  const list = el('div', undefined, main, 'region');
  const render = () => {
    list.replaceChildren();
    for (const p of projects) {
      const ss = sessions.filter(
        (s) =>
          s.project === p &&
          (!select.value || s.project === select.value) &&
          s.name.toLowerCase().includes(search.value.toLowerCase()),
      );
      if (ss.length) sessionTable(ss, region(p, list, `${ss.length} session`));
    }
    if (!list.childNodes.length) empty('Không có session nào khớp bộ lọc', list);
  };
  select.onchange = render;
  search.oninput = render;
  render();
}

let images = [],
  imageIndex = 0;
const lightbox = document.querySelector('#lightbox');
// Created here so the markup never carries an <img> without a source.
const largeImage = el('img', undefined, lightbox);
largeImage.id = 'large-image';
largeImage.alt = 'Ảnh chụp session';
function showImage(i) {
  if (!images.length) return;
  imageIndex = (i + images.length) % images.length;
  largeImage.src = fileUrl(images[imageIndex]);
  document.querySelector('#lightbox-name').textContent =
    `${imageIndex + 1} / ${images.length}  ${fileName(images[imageIndex].path)}`;
  if (!lightbox.open) lightbox.showModal();
}
document.querySelector('#close-lightbox').onclick = () => lightbox.close();
document.querySelector('#previous').onclick = () => showImage(imageIndex - 1);
document.querySelector('#next').onclick = () => showImage(imageIndex + 1);
lightbox.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') showImage(imageIndex - 1);
  if (e.key === 'ArrowRight') showImage(imageIndex + 1);
});

async function runView(r, parent, expanded = true) {
  const details = el('details', undefined, parent, 'run');
  const summary = el('summary', undefined, details);
  el('span', r.workflow, summary, 'name');
  statusPill(r.status, summary);
  const t = el('time', dateTime(r.startedAt), summary);
  t.dateTime = r.startedAt ?? '';
  const load = async () => {
    if (details.dataset.loaded) return;
    const run = await api(`runs/${encodeURIComponent(r.project)}/${encodeURIComponent(r.runId)}`);
    details.dataset.loaded = '1';
    const body = el('div', undefined, details, 'run-body');
    const wrap = el('div', undefined, body, 'table-wrap'),
      table = el('table', undefined, wrap),
      head = el('tr', undefined, el('thead', undefined, table));
    for (const [text, cls] of [
      ['Bước'],
      ['Session'],
      ['Trạng thái'],
      ['Lần thử', 'n'],
      ['Thời gian (ms)', 'n'],
      ['Thông báo'],
    ])
      el('th', text, head, cls);
    const tbody = el('tbody', undefined, table);
    for (const s of run.steps) {
      const row = el('tr', undefined, tbody);
      el('td', s.name ?? s.id, row);
      el('td', s.session ?? '', row, 'muted');
      statusPill(s.status, el('td', undefined, row));
      el('td', String(s.attempts ?? ''), row, 'n');
      el('td', String(s.durationMs ?? ''), row, 'n');
      el('td', s.message ?? '', row);
    }
    if (fileUrl(run.failure?.screenshotFile)) {
      const img = el('img', undefined, body);
      img.src = fileUrl(run.failure.screenshotFile);
      img.alt = 'Ảnh lỗi workflow';
    }
    if (run.reports?.length) {
      const links = el('p', undefined, body, 'links');
      for (const report of run.reports)
        icon(
          'trace',
          linkFile(report, links, `Báo cáo ${report.path.endsWith('.xml') ? 'JUnit' : 'Markdown'}`),
        );
    }
  };
  details.addEventListener('toggle', () => {
    if (details.open) load().catch(showError);
  });
  if (expanded) {
    details.open = true;
    await load();
  }
}

function copyBlock(title, command, parent) {
  const card = el('article', undefined, parent, 'code-window');
  const head = el('div', undefined, card, 'title');
  el('span', title, head);
  const b = button('Sao chép', head, async () => {
    await window.navigator.clipboard.writeText(command);
    say('Đã sao chép');
  });
  icon('copy', b);
  el('pre', command, card);
  return card;
}

async function workflowList() {
  pageHead(
    'Workflows',
    'Luồng đã ghi lại để chạy lại mỗi khi code thay đổi. Chạy lại chỉ tốn một lệnh gọi của agent',
  );
  const list = await api('workflows');
  const saved = region('Workflow đã lưu', main, list.length ? `${list.length} workflow` : undefined);
  if (!list.length)
    empty('Chưa có workflow nào được lưu. Làm theo hướng dẫn bên dưới để ghi luồng đầu tiên', saved);
  else {
    const wrap = el('div', undefined, saved, 'table-wrap');
    const table = el('table', undefined, wrap);
    const head = el('tr', undefined, el('thead', undefined, table));
    for (const [t, cls] of [
      ['Workflow'],
      ['Dự án'],
      ['Số bước', 'n'],
      ['Sessions'],
      ['Lần chạy', 'n'],
      ['Lần cuối'],
    ])
      el('th', t, head, cls);
    const body = el('tbody', undefined, table);
    for (const w of list) {
      const row = el('tr', undefined, body);
      const a = el('a', w.name, el('td', undefined, row), 'session-link');
      a.href = `#workflow/${encodeURIComponent(w.project)}/${encodeURIComponent(w.id)}`;
      el('td', w.project, row, 'muted');
      el('td', String(w.steps), row, 'n');
      el('td', w.sessions.join(', '), row, 'muted');
      el('td', String(w.runs), row, `n ${w.runs ? '' : 'zero'}`);
      const last = el('td', undefined, row);
      if (w.lastRun) {
        statusPill(w.lastRun.status, last);
        el('span', ` ${dateTime(w.lastRun.startedAt)}`, last, 'muted');
      } else el('span', 'Chưa chạy', last, 'muted');
    }
  }
  const how = region('Ghi một luồng mới', main, 'Cần profile testing, tức mẫu Kiểm thử');
  const steps = el('ol', undefined, how, 'howto');
  for (const [title, detail] of [
    ['Chọn mẫu Kiểm thử trong Cài đặt', 'Lưu, rồi khởi động lại client MCP để có các tool workflow'],
    ['Bảo agent bắt đầu ghi', 'Ví dụ: "Bắt đầu ghi workflow tao-don-hang". Agent gọi workflow_record_start'],
    [
      'Thao tác luồng cần test',
      'Đăng nhập, điền form, bấm nút như bình thường. Mật khẩu được thay bằng ${secret.X}',
    ],
    ['Bảo agent dừng ghi', 'Agent gọi workflow_record_stop và workflow được lưu, hiện ngay trên trang này'],
  ]) {
    const li = el('li', undefined, steps);
    el('strong', title, li);
    el('span', detail, li, 'muted');
  }
}

async function workflowDetail(project, id) {
  const wf = await api(`workflows/${encodeURIComponent(project)}/${encodeURIComponent(id)}`);
  pageHead(wf.name, undefined, { label: `Workflows / ${project}`, href: '#workflows' });
  const stats = el('dl', undefined, main, 'stats');
  const passed = wf.runs.filter((r) => r.status === 'passed').length;
  for (const [label, value, bad] of [
    ['Bước', wf.steps.length],
    ['Sessions', wf.sessions.length],
    ['Lần chạy', wf.runs.length],
    ['Đạt', passed],
    ['Lỗi', wf.runs.filter((r) => r.status === 'failed').length, true],
  ]) {
    const st = el('div', undefined, stats, `stat ${bad && value ? 'bad' : ''}`);
    el('dt', label, st);
    el('dd', String(value), st);
  }

  const stepsRegion = region('Các bước', main, 'Giá trị nhập không hiển thị ở đây');
  const wrap = el('div', undefined, stepsRegion, 'table-wrap');
  const table = el('table', undefined, wrap);
  const head = el('tr', undefined, el('thead', undefined, table));
  for (const [t, cls] of [['#', 'n'], ['Bước'], ['Session'], ['Hành động'], ['Đối tượng']])
    el('th', t, head, cls);
  const body = el('tbody', undefined, table);
  wf.steps.forEach((st, i) => {
    const row = el('tr', undefined, body);
    el('td', String(i + 1), row, 'n');
    el('td', String(st.id ?? ''), row);
    el('td', String(st.session ?? ''), row, 'muted');
    el('td', String(st.action ?? ''), row, 'mono');
    el('td', st.target || '', row, 'mono muted');
  });

  const rerun = region('Chạy lại', main);
  const grid = el('div', undefined, rerun, 'commands');
  copyBlock('Nhờ agent chạy lại', `Chạy lại workflow "${wf.name}" và báo kết quả`, grid);
  copyBlock('Tool MCP', `workflow_execute { "name": ${JSON.stringify(wf.name)} }`, grid);
  copyBlock(
    'Xuất thành test Playwright cho CI',
    `test_generate { "name": ${JSON.stringify(wf.name)}, "path": "tests/e2e/${id}.spec.ts" }`,
    grid,
  );

  const history = region('Lịch sử chạy', main, wf.runs.length ? `${wf.runs.length} lần gần nhất` : undefined);
  if (!wf.runs.length) empty('Workflow này chưa chạy lần nào', history);
  const list = el('div', undefined, history, 'runs');
  for (const r of wf.runs) await runView(r, list, false);
}

async function sessionDetail(project, name) {
  const base = `sessions/${encodeURIComponent(project)}/${encodeURIComponent(name)}`;
  const [s, events, runs] = await Promise.all([
    api(base),
    api(base + '/events'),
    api('runs?project=' + encodeURIComponent(project)),
  ]);
  const head = pageHead(name, undefined, { label: `Sessions / ${project}`, href: '#sessions' });
  el('p', `Hoạt động cuối ${dateTime(s.lastActivity)}`, head, 'lead');
  const stats = el('dl', undefined, main, 'stats');
  for (const [k, label] of COUNTS) {
    const st = el('div', undefined, stats, `stat ${k === 'errors' && s.counts[k] ? 'bad' : ''}`);
    el('dt', label, st);
    el('dd', String(s.counts[k] ?? 0), st);
  }

  const shell = el('div', undefined, main, 'region');
  const tabs = el('div', undefined, shell);
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Chi tiết session');
  const content = el('section', undefined, shell);
  content.id = 'session-panel';
  content.setAttribute('role', 'tabpanel');
  const render = async (label) => {
    content.replaceChildren();
    for (const b of tabs.children) {
      const active = b.textContent === label;
      b.setAttribute('aria-selected', String(active));
      b.tabIndex = active ? 0 : -1;
    }
    content.setAttribute('aria-label', label);
    if (label === 'Dòng thời gian') {
      const bar = el('div', undefined, content, 'toolbar');
      const l = el('label', 'Loại sự kiện', bar),
        select = el('select', undefined, l);
      el('option', 'Tất cả', select).value = '';
      [...new Set(events.map((e) => e.type))].forEach((t) => (el('option', t, select).value = t));
      const list = el('ol', undefined, content, 'timeline');
      const draw = () => {
        list.replaceChildren();
        for (const e of events.filter((e) => !select.value || e.type === select.value)) {
          const li = el('li', undefined, list, isBad(e.type) ? 'is-bad' : '');
          const t = el('time', clock(e.ts), li);
          t.dateTime = e.ts;
          t.title = new Date(e.ts).toLocaleString('vi');
          icon(eventIcon(e.type), el('span', e.type, li, 'type'));
          const what = el('div', undefined, li, 'what');
          const text = e.message ?? e.text ?? e.action ?? e.workflow ?? e.name ?? '';
          if (text) el('span', text, what);
          if (e.url) el('span', e.url, what, 'url');
          if (e.path && !e.url) el('span', fileName(e.path), what, 'url');
        }
        if (!list.childNodes.length) {
          list.remove();
          empty('Chưa có sự kiện nào cho bộ lọc này', content);
        } else if (!list.isConnected) content.append(list);
      };
      select.onchange = () => {
        content.querySelector('.empty')?.remove();
        draw();
      };
      draw();
      el('p', 'Hiển thị tối đa 1.000 sự kiện gần nhất trong nhật ký đang lưu', content, 'muted');
    } else if (label === 'Ảnh chụp') {
      images = s.screenshots;
      if (!images.length) return void empty('Session này chưa có ảnh chụp', content);
      const grid = el('div', undefined, content, 'gallery');
      images.forEach((f, i) => {
        const b = button(undefined, grid, () => showImage(i));
        b.setAttribute('aria-label', `Mở ảnh ${i + 1}: ${fileName(f.path)}`);
        const frame = el('span', undefined, b, 'frame');
        if (fileUrl(f)) {
          const img = el('img', undefined, frame);
          img.src = fileUrl(f);
          img.alt = '';
          img.loading = 'lazy';
        }
        el('span', fileName(f.path), b, 'name');
      });
    } else if (label === 'Video') {
      if (!s.videos.length)
        return void empty(
          'Chưa có video. Bật recording.video trong Cài đặt để ghi hình session mới',
          content,
        );
      const grid = el('div', undefined, content, 'videos');
      for (const f of s.videos) {
        if (!fileUrl(f)) continue;
        const box = el('div', undefined, grid, 'video');
        const video = el('video', undefined, box);
        video.controls = true;
        video.preload = 'metadata';
        video.src = fileUrl(f);
        const vl = linkFile(f, box, `Tải ${fileName(f.path)}`);
        if (vl) icon('download', vl);
      }
    } else if (label === 'Trace') {
      if (!s.traces.length)
        return void empty('Chưa có trace. Dùng browser_trace_start và browser_trace_stop để ghi', content);
      for (const f of s.traces) {
        const card = el('article', undefined, content, 'code-window');
        const title = el('div', undefined, card, 'title');
        const dl = linkFile(f, title, `Tải ${fileName(f.path)}`);
        if (dl) icon('download', dl);
        const command = f.command;
        button('Sao chép lệnh', title, async () => {
          await window.navigator.clipboard.writeText(command);
          say('Đã sao chép lệnh mở trace');
        });
        icon('copy', title.lastElementChild);
        el('pre', command, card);
      }
    } else if (label === 'Lỗi') {
      const grouped = new Map();
      for (const e of events.filter((e) => ['console.error', 'network.failed'].includes(e.type))) {
        const key = pretty([e.type, e.text, e.method, e.url, e.status, e.failureCode]);
        const group = grouped.get(key) ?? { event: e, count: 0 };
        group.count += e.count ?? 1;
        grouped.set(key, group);
      }
      if (!grouped.size) return void empty('Không có lỗi console hay lỗi mạng nào được ghi lại', content);
      const list = el('div', undefined, content, 'errors');
      for (const { event: e, count } of grouped.values()) {
        const row = el('article', undefined, list, 'error-row');
        el('span', `×${count}`, row, 'count');
        const what = el('div', undefined, row, 'what');
        el(
          'span',
          e.text ??
            [e.method, e.url, e.status, e.failureCode].filter((x) => x !== null && x !== undefined).join(' '),
          what,
          'msg',
        );
        icon(eventIcon(e.type), el('span', e.type, what, 'type'));
      }
    } else {
      const list = el('div', undefined, content, 'runs');
      for (const r of runs) {
        const run = await api(`runs/${encodeURIComponent(project)}/${encodeURIComponent(r.runId)}`);
        if (run.steps.some((step) => step.session === name)) await runView(r, list);
      }
      if (!list.childNodes.length) {
        list.remove();
        empty('Chưa có workflow nào chạy trên session này', content);
      }
    }
    if (!content.childNodes.length) empty('Chưa có dữ liệu', content);
  };
  const TAB_ICONS = {
    'Dòng thời gian': 'clock',
    'Ảnh chụp': 'image',
    Video: 'video',
    Lỗi: 'alert',
    Workflow: 'workflow',
    Trace: 'trace',
  };
  for (const label of Object.keys(TAB_ICONS)) {
    const b = button(label, tabs, () => render(label));
    icon(TAB_ICONS[label], b);
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', content.id);
    b.onkeydown = (e) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        const bs = [...tabs.children],
          i = bs.indexOf(b);
        const next =
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? bs.length - 1
              : (i + (e.key === 'ArrowRight' ? 1 : -1) + bs.length) % bs.length;
        bs[next].focus();
        bs[next].click();
      }
    };
  }
  await render('Dòng thời gian');
}

const labels = {
  tools: 'Công cụ',
  profile: 'Profile',
  enabled: 'Bật',
  disabled: 'Tắt',
  browser: 'Trình duyệt',
  engine: 'Engine',
  channel: 'Channel',
  headless: 'Ẩn cửa sổ',
  indicator: 'Hiện nhãn điều khiển',
  timeout: 'Thời gian chờ (ms)',
  navigationTimeout: 'Chờ điều hướng (ms)',
  viewport: 'Kích thước cửa sổ',
  width: 'Chiều rộng',
  height: 'Chiều cao',
  security: 'Bảo mật',
  allowedDomains: 'Tên miền cho phép',
  blockedDomains: 'Tên miền chặn',
  allowLocalhost: 'Cho phép localhost',
  allowPrivateNetwork: 'Cho phép mạng riêng',
  approval: 'Phê duyệt',
  highRisk: 'Rủi ro cao',
  destructive: 'Thao tác phá hủy',
  sensitiveFields: 'Trường nhạy cảm',
  fileAccess: 'Truy cập tập tin',
  allowedRoots: 'Thư mục cho phép',
  network: 'Mạng',
  mode: 'Chế độ',
  proxy: 'Proxy',
  server: 'Máy chủ',
  bypass: 'Bỏ qua proxy',
  usernameEnv: 'Tên biến môi trường tài khoản',
  passwordEnv: 'Tên biến môi trường mật khẩu',
  tls: 'TLS',
  caFile: 'Tập tin CA',
  snapshot: 'Snapshot',
  maxChars: 'Số ký tự tối đa',
  maxDepth: 'Độ sâu tối đa',
  maxTextLength: 'Độ dài văn bản tối đa',
  includeText: 'Gồm văn bản',
  recording: 'Ghi hình',
  video: 'Video',
  size: 'Kích thước video',
  journal: 'Nhật ký',
  maxBytes: 'Dung lượng tối đa (byte)',
};

const VALUE_LABELS = {
  off: 'Tắt',
  on: 'Luôn ghi',
  'retain-on-failure': 'Chỉ giữ khi có lỗi',
  system: 'Theo hệ thống',
  manual: 'Tự cấu hình',
  direct: 'Kết nối trực tiếp',
  allow: 'Cho phép',
  ask: 'Hỏi trước',
  deny: 'Chặn',
};
const RISK_LABELS = { read: 'Đọc', interact: 'Tương tác', high: 'Rủi ro cao' };
const SETTINGS_INDEX = [
  ['tools', 'Công cụ', 'tools'],
  ['browser', 'Trình duyệt', 'globe'],
  ['security', 'Bảo mật', 'shield'],
  ['network', 'Mạng', 'proxy'],
  ['snapshot', 'Snapshot', 'overview'],
  ['recording', 'Ghi hình', 'video'],
  ['journal', 'Nhật ký', 'clock'],
  ['advanced', 'JSON', 'trace'],
];
const PRESETS = [
  {
    profile: 'minimal',
    title: 'Cơ bản',
    use: 'Thao tác web đơn giản: mở trang, bấm, điền, chụp ảnh. Ít token nhất',
    video: 'off',
  },
  {
    profile: 'developer',
    title: 'Lập trình',
    use: 'Code và debug hằng ngày: thêm console, network, hiệu năng, tab và frame',
    video: 'off',
    recommended: true,
  },
  {
    profile: 'testing',
    title: 'Kiểm thử',
    use: 'Test feature: nhiều user, ghi và chạy lại workflow, sinh test Playwright. Giữ video khi có lỗi',
    video: 'retain-on-failure',
  },
  {
    profile: 'full',
    title: 'Toàn quyền',
    use: 'Thêm nối vào Chrome đang mở và upload file. Hai tool này luôn hỏi trước khi chạy',
    video: 'off',
  },
];
async function settings() {
  pageHead(
    'Cài đặt',
    'Chọn một cấu hình mẫu, hoặc mở phần tùy chỉnh chi tiết. Mọi giá trị được kiểm tra trước khi ghi.',
  );
  const presetRegion = region(
    'Cấu hình mẫu',
    main,
    'Chỉ đổi profile và chế độ quay video, giữ nguyên phần còn lại',
  );
  const [config, schema, status] = await Promise.all([api('config'), api('config/schema'), api('status')]);
  const notes = el('aside', undefined, main, 'notes');
  const ul = el('ul', undefined, notes);
  el('li', 'Thay đổi áp dụng cho tiến trình MCP mới: khởi động lại client sau khi lưu', ul);
  el('li', 'Thông tin xác thực chỉ ghi tên biến môi trường, không bao giờ ghi giá trị', ul);
  el('li', 'Không thể tắt xác minh TLS', ul);
  el(
    'li',
    'Nếu cấu hình client MCP có --profile thì giá trị đó thắng file cấu hình: bỏ --profile để dùng mẫu chọn ở đây',
    ul,
  );
  el('p', config.file, notes, 'file');

  let raw = window.structuredClone(config.raw);
  const layout = el('div', undefined, main, 'settings-layout');
  // A div with role=navigation: the top bar's route code only touches <nav> links.
  const index = el('div', undefined, layout, 'settings-index');
  index.setAttribute('role', 'navigation');
  index.setAttribute('aria-label', 'Mục cài đặt');
  const form = el('form', undefined, layout);
  for (const [id, text, iconName] of SETTINGS_INDEX) {
    const a = el('a', text, index);
    a.href = `#settings`;
    icon(iconName, a);
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(`set-${id}`);
      if (!target) return;
      if (id === 'advanced') target.open = true;
      else custom.open = true;
      target.scrollIntoView({ block: 'start' });
      target.querySelector('input, select, textarea, summary')?.focus({ preventScroll: true });
    });
  }
  const custom = el('details', undefined, form, 'custom');
  el('summary', 'Tùy chỉnh chi tiết', custom);
  const common = el('div', undefined, custom, 'region');
  const advanced = el('details', undefined, form, 'advanced');
  advanced.id = 'set-advanced';
  el('summary', 'JSON nâng cao', advanced);
  const rawLabel = el('label', 'Cấu hình JSON', advanced),
    editor = el('textarea', undefined, rawLabel);
  editor.id = 'raw';
  editor.spellcheck = false;
  editor.value = pretty(raw);
  let rawDirty = false;
  editor.oninput = () => {
    rawDirty = true;
  };
  const setters = [];
  const set = (keys, value) => {
    if (rawDirty) {
      raw = JSON.parse(editor.value);
      rawDirty = false;
    }
    let current = raw;
    for (const key of keys.slice(0, -1)) {
      if (!current[key] || typeof current[key] !== 'object') current[key] = {};
      current = current[key];
    }
    current[keys.at(-1)] = value;
  };
  function field(key, sch, value, parent, keys) {
    let spec = sch;
    if (spec.anyOf) spec = spec.anyOf.find((s) => s.type !== 'null') ?? spec;
    let nullable = false;
    if (Array.isArray(spec.type)) {
      nullable = spec.type.includes('null');
      spec = { ...spec, type: spec.type.find((t) => t !== 'null') };
    }
    if (spec.type === 'object') {
      const box = el('fieldset', undefined, parent);
      if (keys.length === 1) box.id = `set-${key}`;
      el('legend', labels[key] ?? key, box);
      for (const [k, s] of Object.entries(spec.properties ?? {})) field(k, s, value?.[k], box, [...keys, k]);
      return;
    }
    let input, label;
    const triState = spec.type === 'boolean' && nullable;
    if (triState) {
      label = el('label', labels[key] ?? key, parent);
      input = el('select', undefined, label);
      for (const [v, text] of [
        ['', 'Tự động'],
        ['true', 'Bật'],
        ['false', 'Tắt'],
      ])
        el('option', text, input).value = v;
      input.value = value === null || value === undefined ? '' : String(value);
    } else if (spec.type === 'boolean') {
      label = el('label', undefined, parent, 'check');
      input = el('input', undefined, label);
      input.type = 'checkbox';
      input.checked = !!value;
      el('span', labels[key] ?? key, label);
    } else {
      label = el('label', labels[key] ?? key, parent);
      if (spec.enum) {
        input = el('select', undefined, label);
        for (const v of spec.enum) {
          const text =
            key === 'profile' && status.tools?.[v] !== undefined
              ? `${v}, ${status.tools[v]} tools`
              : (VALUE_LABELS[v] ?? v);
          el('option', text, input).value = v;
        }
        input.value = value ?? spec.default ?? spec.enum[0];
      } else {
        input = el(spec.type === 'array' ? 'textarea' : 'input', undefined, label);
        if (spec.type === 'number' || spec.type === 'integer') input.type = 'number';
        input.value = Array.isArray(value) ? value.join('\n') : (value ?? '');
        if (spec.type === 'array') input.placeholder = 'Mỗi dòng một giá trị';
      }
    }
    const read = () =>
      triState
        ? input.value === ''
          ? null
          : input.value === 'true'
        : spec.type === 'boolean'
          ? input.checked
          : spec.type === 'array'
            ? input.value
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean)
            : ['number', 'integer'].includes(spec.type)
              ? Number(input.value)
              : input.value || null;
    input.onchange = () => {
      set(keys, read());
      editor.value = pretty(raw);
      rawDirty = false;
    };
    setters.push({ keys, input });
  }
  const groups = {
    tools: ['profile'],
    browser: ['engine', 'channel', 'headless', 'indicator', 'timeout', 'navigationTimeout', 'viewport'],
    security: [
      'allowedDomains',
      'blockedDomains',
      'allowLocalhost',
      'allowPrivateNetwork',
      'approval',
      'sensitiveFields',
      'fileAccess',
    ],
    network: ['mode', 'proxy', 'tls'],
    snapshot: null,
    recording: null,
    journal: null,
  };
  for (const [group, keys] of Object.entries(groups)) {
    const spec = window.structuredClone(schema.properties[group]);
    if (keys)
      spec.properties = Object.fromEntries(Object.entries(spec.properties).filter(([k]) => keys.includes(k)));
    if (group === 'network') delete spec.properties.tls.properties.verify;
    field(group, spec, config.effective[group], common, [group]);
  }
  const toolsBox = common.querySelector('fieldset');
  const toolDetails = el('details', undefined, toolsBox, 'tool-details');
  const toolSummary = el('summary', undefined, toolDetails);
  el('span', 'Bật hoặc tắt từng tool', toolSummary);
  const overrideCount = el('span', undefined, toolSummary, 'muted');
  const refreshCount = () => {
    const n = (raw.tools?.enabled ?? []).length + (raw.tools?.disabled ?? []).length;
    overrideCount.textContent = n ? `${n} tool đang tùy chỉnh` : 'Chưa tùy chỉnh, dùng đúng profile';
  };
  refreshCount();
  const picker = el('div', undefined, toolDetails, 'tool-picker');
  const profile = setters.find((s) => s.keys.join('.') === 'tools.profile').input;
  async function tools() {
    picker.replaceChildren();
    el(
      'p',
      'Bật riêng thêm tool ngoài profile, hoặc tắt tool trong profile. Tool có rủi ro cao vẫn cần phê duyệt.',
      picker,
      'muted',
    );
    const [available, selected] = await Promise.all([
      api('tools?profile=full'),
      api('tools?profile=' + encodeURIComponent(profile.value)),
    ]);
    const included = new Set(selected.map((t) => t.name));
    available.sort((a, b) => Number(included.has(b.name)) - Number(included.has(a.name)));
    const filterLabel = el('label', 'Lọc tool', picker, 'tool-filter');
    const filter = el('input', undefined, filterLabel);
    filter.type = 'search';
    filter.placeholder = 'Tên hoặc mã tool';
    const wrap = el('div', undefined, picker, 'table-wrap');
    const table = el('table', undefined, wrap);
    const head = el('tr', undefined, el('thead', undefined, table));
    el('th', 'Tool', head);
    el('th', 'Rủi ro', head);
    el('th', 'Profile', head);
    el('th', 'Bật riêng', head, 'c');
    el('th', 'Tắt', head, 'c');
    const tbody = el('tbody', undefined, table);
    for (const tool of available) {
      const row = el('tr', undefined, tbody);
      row.dataset.search = `${tool.title} ${tool.name}`.toLowerCase();
      const name = el('td', undefined, row);
      el('span', tool.title, name);
      if (tool.description) el('span', tool.description, name, 'tool-desc');
      el('span', tool.name, name, 'tool-name');
      el(
        'span',
        RISK_LABELS[tool.risk] ?? tool.risk,
        el('td', undefined, row),
        `pill ${tool.risk === 'high' ? 'bad' : tool.risk === 'interact' ? 'warn' : ''}`,
      );
      el('td', included.has(tool.name) ? 'Trong profile' : 'Ngoài profile', row, 'muted');
      for (const mode of ['enabled', 'disabled']) {
        const label = el('label', undefined, el('td', undefined, row, 'c'));
        el('span', `${mode === 'enabled' ? 'Bật riêng' : 'Tắt'} ${tool.name}`, label, 'visually-hidden');
        const input = el('input', undefined, label);
        input.type = 'checkbox';
        input.dataset.mode = mode;
        input.checked = (raw.tools?.[mode] ?? []).includes(tool.name);
        input.onchange = () => {
          if (rawDirty) {
            raw = JSON.parse(editor.value);
            rawDirty = false;
          }
          const list = new Set(raw.tools?.[mode] ?? []);
          if (input.checked) list.add(tool.name);
          else list.delete(tool.name);
          set(['tools', mode], [...list]);
          if (input.checked) {
            const opposite = mode === 'enabled' ? 'disabled' : 'enabled';
            set(
              ['tools', opposite],
              (raw.tools?.[opposite] ?? []).filter((n) => n !== tool.name),
            );
            row.querySelector(`input[data-mode="${opposite}"]`).checked = false;
          }
          editor.value = pretty(raw);
          refreshCount();
        };
      }
    }
    filter.oninput = () => {
      const q = filter.value.trim().toLowerCase();
      for (const row of tbody.rows) row.hidden = !!q && !row.dataset.search.includes(q);
    };
  }
  profile.addEventListener('change', () => {
    markPreset();
    tools().catch(showError);
  });
  await tools();

  const presetGrid = el('div', undefined, presetRegion, 'presets');
  presetGrid.setAttribute('role', 'group');
  presetGrid.setAttribute('aria-label', 'Cấu hình mẫu');
  const cards = [];
  function setField(keys, value) {
    set(keys, value);
    const s = setters.find((x) => x.keys.join('.') === keys.join('.'));
    if (!s) return;
    if (s.input.type === 'checkbox') s.input.checked = !!value;
    else s.input.value = value;
  }
  function markPreset() {
    for (const { card, preset } of cards)
      card.setAttribute('aria-pressed', String(preset.profile === profile.value));
  }
  for (const preset of PRESETS) {
    const card = button(
      undefined,
      presetGrid,
      async () => {
        setField(['tools', 'profile'], preset.profile);
        setField(['recording', 'video'], preset.video);
        setField(['journal', 'enabled'], true);
        if (preset.profile === 'full') setField(['security', 'approval', 'highRisk'], 'ask');
        editor.value = pretty(raw);
        rawDirty = false;
        markPreset();
        await tools();
        say(`Đã chọn mẫu ${preset.title}. Bấm Lưu cấu hình để ghi.`);
      },
      'preset',
    );
    const head = el('span', undefined, card, 'preset-head');
    el('span', preset.title, head, 'preset-title');
    if (preset.recommended) el('span', 'Khuyên dùng', head, 'pill ok');
    el('span', preset.use, card, 'preset-use');
    const meta = el('span', undefined, card, 'preset-meta');
    el('span', `${status.tools?.[preset.profile] ?? '?'} tools`, meta);
    if (status.toolTokens?.[preset.profile])
      el('span', `khoảng ${status.toolTokens[preset.profile].toLocaleString('vi')} token mỗi phiên`, meta);
    cards.push({ card, preset });
  }
  markPreset();
  const bar = el('div', undefined, form, 'save-bar');
  el('p', 'Lưu xong, khởi động lại client MCP để áp dụng', bar, 'muted');
  const save = el('button', 'Lưu cấu hình', bar, 'primary');
  save.type = 'submit';
  icon('check', save);
  form.onsubmit = async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      if (rawDirty) raw = JSON.parse(editor.value);
      await api('config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-TG-CSRF': '1' },
        body: JSON.stringify(raw),
      });
      say('Đã lưu. Khởi động lại client MCP để áp dụng.');
      await route();
    } catch (error) {
      showError(error);
    } finally {
      save.disabled = false;
    }
  };
}

async function route() {
  main = el('div', undefined, undefined, 'view');
  root.replaceChildren(main);
  const parts = window.location.hash.slice(1).split('/');
  const section =
    parts[0] === 'session' ? 'sessions' : parts[0] === 'workflow' ? 'workflows' : parts[0] || 'overview';
  document
    .querySelectorAll('nav a')
    .forEach((a) => a.setAttribute('aria-current', a.hash === `#${section}` ? 'page' : 'false'));
  try {
    if (parts[0] === 'settings') await settings();
    else if (parts[0] === 'sessions') await sessionList();
    else if (parts[0] === 'workflows') await workflowList();
    else if (parts[0] === 'workflow')
      await workflowDetail(decodeURIComponent(parts[1]), decodeURIComponent(parts[2]));
    else if (parts[0] === 'session')
      await sessionDetail(decodeURIComponent(parts[1]), decodeURIComponent(parts[2]));
    else await overview();
  } catch (e) {
    main.querySelector('.loading')?.remove();
    el('p', e.message, main, 'failure');
  }
}
const themeToggle = document.querySelector('#theme-toggle');
const applyTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
  themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
  themeToggle.textContent = theme === 'dark' ? 'Giao diện sáng' : 'Giao diện tối';
  icon(theme === 'dark' ? 'sun' : 'moon', themeToggle);
};
const NAV_ICONS = {
  '#overview': 'overview',
  '#sessions': 'sessions',
  '#workflows': 'workflow',
  '#settings': 'settings',
};
document.querySelectorAll('nav a').forEach((a) => icon(NAV_ICONS[a.hash], a));
icon('prev', document.querySelector('#previous'));
icon('next', document.querySelector('#next'), false);
icon('close', document.querySelector('#close-lightbox'));
applyTheme(window.localStorage.getItem('tg-theme') === 'dark' ? 'dark' : 'light');
themeToggle.onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  window.localStorage.setItem('tg-theme', next);
  applyTheme(next);
};
window.addEventListener('hashchange', route);
route();
