// The screenshot list, in output order (01-…, 02-…). Selectors use ids and classes only, so they keep working in
// every UI language.
//   title     README caption (titleZh: zh-TW README)         marks    highlight rings: { sel (string or array → union),
//   route     hash route without "#/"                            caption, place?: above | below | inside-start |
//   query     text before the hash ("?lang=zh-TW")              inside-end | edge-start | edge-end, pad?, dx?,
//                                                               ring?: false = caption anchor only }
//   ready     selector to wait for                     prep     async (page) => … before capture
//   server    false → /api/* answers 404 (static mode)  graph    wait for the layout to settle
//   fullPage  capture the whole page                    width / height / mobile / theme / locale
const MOBILE = { width: 390, height: 844, mobile: true };
/** Scroll `sel` to the top of the viewport, below the sticky top bar. */
const scrollTo = (sel) => (page) => page.locator(sel).evaluate((el) => {
  const bar = document.querySelector('.topbar')?.offsetHeight || 0;
  window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - bar - 12);
});

export const SHOTS = [
  {
    name: 'home', route: 'home', ready: '#h-mine',
    title: 'Home — what needs you, at a glance', titleZh: '首頁：一眼看出哪些事在等你',
    marks: [
      { sel: ['#h-mine', '#h-review'] },
      { sel: '#h-review', ring: false, caption: 'Your queue: assigned to you and waiting for your review', place: 'edge-end' },
    ],
  },
  {
    name: 'list', route: 'list?q=latency&sv=內部&k=Observability', ready: 'table.docs',
    title: 'Search and filter — full text, query language, keyword chips', titleZh: '搜尋與篩選：全文檢索、查詢語法、關鍵字標籤',
    marks: [
      { sel: '.search', caption: 'Full-text search with a small query language' },
      { sel: ['.filters', '.chips.active'], caption: 'Filters and keyword chips stack with the query', place: 'inside-end' },
    ],
  },
  {
    name: 'doc', route: 'doc/9', ready: '#pv .gdv', height: 1500,
    prep: (page) => page.locator('#notes-list li').first().waitFor(),
    title: 'Document page — the content first, metadata and workflow beside it', titleZh: '文件頁：內容優先，中繼資料與工作流程放在旁邊',
    marks: [
      { sel: '#d-edit', caption: 'Workflow: status, assignee, reviewer', place: 'below', dx: -60 },
      { sel: '#pv .gdv', caption: 'Credentials stay masked as vault fields', pad: 5, place: 'above', dx: 60 },
    ],
  },
  {
    name: 'vault-reveal', route: 'doc/25', ready: 'iframe.preview',
    prep: async (page) => {
      await page.frameLocator('iframe.preview').locator('.gdv button').first().click();
      await page.locator('.gdv-dlg [data-a=show]').click();
      await page.locator('.gdv-dlg output').filter({ hasNotText: '••••' }).waitFor();
    },
    title: 'Vault reveal — role-checked, decrypted by the server, audited', titleZh: 'Vault 顯示：檢查權限、由伺服器解密、每次存取都留紀錄',
    marks: [{ sel: '.gdv-dlg form', caption: 'Reveal is server-side and every access is audited', pad: 8 }],
  },
  {
    name: 'project-vault', route: 'project/platform?sec=vault', ready: '#pv-list table',
    prep: scrollTo('#p-vault'),
    title: 'Project vault — managers add, replace and reveal secrets per project', titleZh: '專案 Vault：管理者可新增、替換、顯示各專案的密鑰',
    marks: [{ sel: '#p-vault', caption: 'Each project has its own vault namespace', place: 'inside-end' }],
  },
  {
    name: 'summary', route: 'summary', ready: '#sec1',
    title: 'Summary — matrices by category, status and sensitivity', titleZh: '摘要：依分類、狀態、機敏性的統計矩陣',
    marks: [{ sel: '#sec1', caption: 'Every cell links to the matching documents', place: 'edge-end' }],
  },
  {
    name: 'timeline', route: 'timeline', ready: '.tl-item',
    title: 'Timeline — newest first, colored by workflow status', titleZh: '時間軸：由新到舊，依工作流程狀態著色',
    marks: [{ sel: ['.tl-month', '.tl-item:nth-of-type(5)'], caption: 'Grouped by month' }],
  },
  {
    name: 'graph', route: 'graph', ready: '.gx-stage canvas', graph: true,
    title: 'Knowledge graph — documents, projects and shared keywords', titleZh: '關聯圖：文件、專案與共同關鍵字',
    marks: [{ sel: '.gx-legend', caption: 'Colored by project; edges for keywords, related and superseded docs' }],
  },
  {
    name: 'admin-users', route: 'admin', ready: 'table.users',
    title: 'Admin: users — per-project roles, invitations, last seen', titleZh: '管理：使用者（各專案角色、邀請、最近登入）',
    marks: [{ sel: '#a-users', caption: 'Roles per project: viewer, editor, manager, owner', place: 'edge-end' }],
  },
  {
    name: 'admin-projects', route: 'admin', ready: '#a-projects', fullPage: true,
    title: 'Admin: projects — visibility and a link to each project vault', titleZh: '管理：專案（公開設定與各專案 Vault 入口）',
    marks: [{ sel: '#a-projects table', caption: 'Public projects are readable by every signed-in user', place: 'below' }],
  },
  {
    name: 'profile-menu', route: 'home', ready: '#h-mine',
    prep: async (page) => { await page.locator('#me-btn').click(); await page.locator('#me-menu:not([hidden])').waitFor(); },
    title: 'Profile menu — display name, language and theme', titleZh: '個人選單：顯示名稱、語言、佈景主題',
    marks: [{ sel: '#me-menu', caption: 'Display name, language and theme per user', pad: 4, place: 'below' }],
  },
  {
    name: 'home-dark', route: 'home', ready: '#h-mine', theme: 'dark',
    title: 'Dark theme', titleZh: '深色主題',
    marks: [
      { sel: ['#h-mine', '#h-review'] },
      { sel: '#h-review', ring: false, caption: 'Follows the system, or pinned per user', place: 'edge-end' },
    ],
  },
  {
    name: 'mobile-home', route: 'home', ready: '#h-mine', ...MOBILE,
    title: 'Mobile — home page', titleZh: '手機版：首頁',
    marks: [{ sel: '#h-mine' }, { sel: '#h-review', ring: false, caption: 'Compact cards on small screens', place: 'edge-end' }],
  },
  {
    name: 'mobile-doc', route: 'doc/9', ready: '#pv .gdv', ...MOBILE,
    title: 'Mobile — document page, content first', titleZh: '手機版：文件頁，內容優先',
    marks: [{ sel: '#d-pv .pv-bar' }, { sel: '#pv', ring: false, caption: 'Content first, details fold below', place: 'edge-end', pad: -14 }],
  },
  {
    name: 'home-zh-TW', route: 'home', query: '?lang=zh-TW', locale: 'zh-TW', ready: '#h-mine',
    title: 'Traditional Chinese (zh-TW)', titleZh: '繁體中文介面（zh-TW）',
    marks: [{ sel: '#tabs', caption: 'Traditional Chinese (zh-TW) locale', pad: 4 }],
  },
];
