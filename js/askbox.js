// askbox.js — 匿名提问箱模块
// 依赖：db.js、main.js、settings.js（loadApiConfig / fetchAI）、character.js 必须先加载
//
// 功能：用户以匿名身份向已创建的角色提问，角色以人设口吻公开回复，
// 回复展示在信息流中，历史提问全部留存。
//
// 存储方案：不改动 db.js 的表结构，复用 config 表（key-value）单键存一个 JSON 数组，
// 与 settings.js 里 saveStoredFonts() 的存法一致，避免升级 Dexie 版本号导致的迁移风险。

var ASKBOX_STORE_KEY = 'askBoxItems'
var _askboxComposeCharId = null

function askEscHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, function(ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  })
}

function askFormatTime(ts) {
  if (!ts) return ''
  var d = new Date(ts)
  var now = new Date()
  var diff = now - d
  if (diff < 86400000 && d.getDate() === now.getDate()) {
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0')
  }
  if (diff < 172800000) return '昨天 ' + d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0')
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0')
}

// ===== 存取 =====
async function getAskBoxItems() {
  var row = await db.config.get(ASKBOX_STORE_KEY)
  return (row && Array.isArray(row.value)) ? row.value : []
}
async function saveAskBoxItems(items) {
  await db.config.put({ key: ASKBOX_STORE_KEY, value: items })
}

// ===== System Prompt =====
function buildAskBoxSystemPrompt(char) {
  var name = char.nick || char.name || '角色'
  var persona = char.description || ''
  return '你正在扮演角色【' + name + '】。以下是你的完整人设：\n\n' + persona + '\n\n' +
    '# 场景\n' +
    '这里是一个匿名提问箱：有陌生人（提问者的身份对你不可见）向你提了一个问题，' +
    '你的回答会被公开展示给所有关注你的人看到，就像博主在社交平台公开回复读者提问一样。\n\n' +
    '# 要求\n' +
    '1. 完全保持你的人设口吻、性格和说话习惯来回答。\n' +
    '2. 回答只需要是你的公开回复正文本身，不要加"回复："之类的前缀，不要出现旁白或动作描写的括号说明，除非这符合你一贯的说话方式。\n' +
    '3. 长度自然即可，不必刻意写长或写短——像日常公开回复一样。\n' +
    '4. 如果问题涉及你人设中并不知道的信息，可以用符合角色性格的方式婉拒或调侃过去，不要跳出角色。'
}

// ===== 入口 =====
window.showAskBoxPage = async function() {
  var chars = (await db.characters.toArray()).filter(function(c) { return c.type === 'char' })
  if (!chars.length) {
    window.openPage(buildAskBoxEmptyPage())
    return
  }
  var page = buildAskBoxFeedPage()
  window.openPage(page)
  renderAskBoxFeed(page, chars)
}

function buildAskBoxEmptyPage() {
  var page = document.createElement('div')
  page.id = 'askbox-empty-page'
  page.className = 'full-page askbox-main'
  page.innerHTML =
    '<div class="askbox-header">' +
      '<button class="askbox-back" onclick="window.closePage(\'askbox-empty-page\')"><i class="fa fa-angle-left"></i></button>' +
      '<span class="askbox-title">提问箱</span>' +
      '<span style="width:32px"></span>' +
    '</div>' +
    '<div class="askbox-empty">' +
      '<i class="fa-solid fa-inbox"></i>' +
      '<p>还没有角色可以提问<br>先在「角色档案」里创建一个角色吧</p>' +
      '<button id="askbox-goto-char">去创建角色</button>' +
    '</div>'
  page.querySelector('#askbox-goto-char').addEventListener('click', function() {
    window.closePage('askbox-empty-page')
    setTimeout(function() { window.showCharacterPage && showCharacterPage() }, 100)
  })
  return page
}

function buildAskBoxFeedPage() {
  var page = document.createElement('div')
  page.id = 'askbox-feed-page'
  page.className = 'full-page askbox-main'
  page.innerHTML =
    '<div class="askbox-header">' +
      '<button class="askbox-back" onclick="window.closePage(\'askbox-feed-page\')"><i class="fa fa-angle-left"></i></button>' +
      '<span class="askbox-title">提问箱</span>' +
      '<button class="askbox-compose-btn" id="askbox-compose-open"><i class="fa-solid fa-pen"></i></button>' +
    '</div>' +
    '<div class="askbox-feed" id="askbox-feed-list"></div>'
  return page
}

// ===== 信息流渲染 =====
async function renderAskBoxFeed(page, chars) {
  var list = page.querySelector('#askbox-feed-list')
  var items = await getAskBoxItems()
  var charMap = {}
  chars.forEach(function(c) { charMap[c.id] = c })

  if (!items.length) {
    list.innerHTML = '<div class="askbox-empty" style="padding-top:60px;">' +
      '<i class="fa-solid fa-comment-dots"></i>' +
      '<p>还没有提问<br>点右上角的笔图标匿名问点什么吧</p>' +
      '</div>'
  } else {
    list.innerHTML = items.slice().reverse().map(function(item) {
      return renderAskBoxCardHtml(item, charMap[item.charId])
    }).join('')
  }

  page.querySelector('#askbox-compose-open').onclick = function() {
    openAskBoxComposeSheet(page, chars)
  }
}

function renderAskBoxCardHtml(item, char) {
  var name = char ? (char.nick || char.name) : '未知角色'
  var avatar = (char && char.avatar) || 'img/wanwan.png'
  var answerHtml
  if (item.answer) {
    answerHtml = '<div class="askbox-card-a">' + askEscHtml(item.answer) + '</div>'
  } else if (item.error) {
    answerHtml = '<div class="askbox-card-a pending">回复失败：' + askEscHtml(item.error) + '</div>'
  } else {
    answerHtml = '<div class="askbox-card-a pending"><div class="askbox-typing"><span></span><span></span><span></span></div></div>'
  }
  return '<div class="askbox-card" data-item-id="' + item.id + '">' +
    '<div class="askbox-card-to"><img src="' + askEscHtml(avatar) + '"><span>匿名提问 → <b>' + askEscHtml(name) + '</b></span></div>' +
    '<div class="askbox-card-q">' + askEscHtml(item.question) + '</div>' +
    answerHtml +
    '<div class="askbox-card-time">' + askFormatTime(item.createdAt) + '</div>' +
  '</div>'
}

// ===== 撰写弹层 =====
function openAskBoxComposeSheet(page, chars) {
  _askboxComposeCharId = chars[0] ? chars[0].id : null
  var overlay = document.createElement('div')
  overlay.className = 'askbox-compose-overlay'
  overlay.innerHTML =
    '<div class="askbox-compose-sheet">' +
      '<div class="askbox-compose-title">匿名提问</div>' +
      '<div class="askbox-char-scroller">' +
        chars.map(function(c, i) {
          var name = c.nick || c.name
          var avatar = c.avatar || 'img/wanwan.png'
          return '<div class="askbox-char-chip' + (i === 0 ? ' active' : '') + '" data-char-id="' + c.id + '">' +
            '<img src="' + askEscHtml(avatar) + '"><span>' + askEscHtml(name) + '</span></div>'
        }).join('') +
      '</div>' +
      '<textarea class="askbox-compose-textarea" id="askbox-compose-textarea" placeholder="匿名写下你想问的问题..." maxlength="500"></textarea>' +
      '<div class="askbox-compose-actions">' +
        '<button class="askbox-cancel-btn" id="askbox-cancel-btn">取消</button>' +
        '<button class="askbox-send-btn" id="askbox-send-btn">匿名发送</button>' +
      '</div>' +
    '</div>'
  page.appendChild(overlay)

  overlay.querySelectorAll('.askbox-char-chip').forEach(function(chip) {
    chip.addEventListener('click', function() {
      overlay.querySelectorAll('.askbox-char-chip').forEach(function(c) { c.classList.remove('active') })
      chip.classList.add('active')
      _askboxComposeCharId = chip.dataset.charId
    })
  })
  overlay.querySelector('#askbox-cancel-btn').addEventListener('click', function() { overlay.remove() })
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove() })

  overlay.querySelector('#askbox-send-btn').addEventListener('click', async function() {
    var textarea = overlay.querySelector('#askbox-compose-textarea')
    var question = textarea.value.trim()
    if (!question) { window.toast('先写点什么吧'); return }
    if (!_askboxComposeCharId) { window.toast('选一个角色吧'); return }
    overlay.querySelector('#askbox-send-btn').disabled = true
    overlay.remove()
    await submitAskBoxQuestion(_askboxComposeCharId, question, page, chars)
  })
}

// ===== 提交问题并请求角色回复 =====
async function submitAskBoxQuestion(charId, question, page, chars) {
  var char = chars.find(function(c) { return String(c.id) === String(charId) })
  var item = {
    id: 'ask_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    charId: charId,
    question: question,
    answer: '',
    error: '',
    createdAt: Date.now()
  }
  var items = await getAskBoxItems()
  items.push(item)
  await saveAskBoxItems(items)
  await renderAskBoxFeed(page, chars)

  try {
    var apiCfg = await loadApiConfig()
    var cfg = apiCfg.primary
    if (!cfg || !cfg.url || !cfg.key) throw new Error('请先在设置里填写 API 信息')
    var systemPrompt = buildAskBoxSystemPrompt(char || {})
    var reply = await fetchAI(cfg, [{ role: 'user', content: question }], {
      system: systemPrompt,
      apiConsoleType: '提问箱回复'
    })
    item.answer = String(reply || '').trim() || '（角色没有回复任何内容）'
  } catch (err) {
    item.error = String(err && err.message || err)
  }

  var latest = await getAskBoxItems()
  var idx = latest.findIndex(function(i) { return i.id === item.id })
  if (idx > -1) latest[idx] = item
  await saveAskBoxItems(latest)
  if (document.getElementById('askbox-feed-page')) {
    await renderAskBoxFeed(page, chars)
  }
}

// ===== 挂到桌面图标（第二页还有空位） =====
if (window.DESKTOP_PAGE2_ICONS) {
  window.DESKTOP_PAGE2_ICONS.push({
    id: 'askbox',
    fa: 'fa-solid fa-mailbox',
    label: '提问箱',
    action: function() { window.showAskBoxPage && showAskBoxPage() }
  })
}
