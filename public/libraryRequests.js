// libraryRequests.js — client-side renderer for /library-requests.
//
// The page used to server-render every movie/series card (and every series
// season + episode) into one giant HTML document, backed by N+1 queries
// (4+ queries per item). With 20k+ items that was unusable.
//
// Now the EJS is a light shell and this file renders tabs client-side from
// `/library-requests/data?type=movie|series` (batched, non-N+1). Tabs load only
// when first opened; series episode panels render lazily from in-memory data on
// season click (no hidden giant DOM, no extra fetch). Actions patch the active
// tab in place by re-fetching its (small, filtered) JSON and re-rendering —
// never `location.reload()`, so search/scroll/open-season state survives.
(function () {
  "use strict"

  var I18N = window.LR_I18N || {}
  var PERMS = window.LR_PERMS || {}
  var LANG_BY_ID = window.LR_LANG_BY_ID || {}
  var SHOW_POSTERS = !!window.LR_SHOW_POSTERS

  // type → { loaded, groups, genres }
  var state = { movie: newState(), series: newState(), unmatched: newState() }
  var activeTab = "movie"
  var searchTimer = null

  function newState() {
    return { loaded: false, loading: false, groups: [], genres: [] }
  }
  function S(type) { return state[type] }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  }
  function escAttr(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  }
  function whisperLabel(status) {
    return (I18N.whisperStatus && I18N.whisperStatus[status]) || status || ""
  }
  function langById(id) { return LANG_BY_ID[id] }

  function fileNameOf(it) { return it.fileName || "" }

  // ── Tab switching ────────────────────────────────────────────────────────
  window.lrSwitchTab = function lrSwitchTab(tab) {
    if (tab !== "movie" && tab !== "series" && tab !== "unmatched") return
    activeTab = tab
    var tabs = ["movie", "series", "unmatched"]
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i]
      document.getElementById("lr-tab-" + t).style.display = t === tab ? "" : "none"
      document.getElementById("lr-tab-btn-" + t).classList.toggle("active", t === tab)
    }
    if (history.replaceState) {
      var u = new URL(window.location.href)
      u.searchParams.set("tab", tab)
      history.replaceState(null, "", u.toString())
    }
    if (!S(tab).loaded) loadTab(tab)
  }

  // ── Data loading ─────────────────────────────────────────────────────────
  function loadTab(type) {
    var st = S(type)
    if (st.loading) return
    st.loading = true
    var root = document.querySelector('[data-lr-root="' + type + '"]')
    if (root) root.innerHTML = loadingHtml()
    fetch("/library-requests/data?type=" + type)
      .then(function (r) { if (redirectIfUnauthorized(r)) return null; return r.json() })
      .then(function (data) {
        st.loading = false
        if (!data) return
        st.groups = data.groups || []
        st.genres = data.allGenres || []
        st.loaded = true
        renderTab(type)
        updateTabCount(type)
      })
      .catch(function () {
        st.loading = false
        if (root) root.innerHTML = '<div class="card"><p class="empty-state">Failed to load.</p></div>'
      })
  }

  function refreshActiveTab() {
    var st = S(activeTab)
    if (!st.loaded) return
    // Preserve UI state across the re-render.
    var openSeasons = captureOpenSeasons(activeTab)
    var scrollTop = window.scrollY
    st.loading = true
    fetch("/library-requests/data?type=" + activeTab)
      .then(function (r) { if (redirectIfUnauthorized(r)) return null; return r.json() })
      .then(function (data) {
        st.loading = false
        if (!data) return
        st.groups = data.groups || []
        st.genres = data.allGenres || []
        renderTab(activeTab)
        updateTabCount(activeTab)
        restoreOpenSeasons(activeTab, openSeasons)
        applyFilters()
        window.scrollTo(0, scrollTop)
      })
      .catch(function () { st.loading = false })
  }

  function updateTabCount(type) {
    var el = document.querySelector('.lr-tab-count[data-tab="' + type + '"]')
    if (!el) return
    var n = S(type).groups.length
    el.textContent = String(n)
    el.style.display = n > 0 ? "" : "none"
  }

  // Preload every tab's badge number on first page load so the counts are
  // visible before the user visits each tab. Each tab's full data still loads
  // lazily on first open; this only fills the small count badges from a single
  // /counts request. Once a tab is opened, its own loadTab keeps the badge in
  // sync (and supersedes the preloaded value).
  function preloadTabCounts() {
    fetch("/library-requests/counts")
      .then(function (r) { if (redirectIfUnauthorized(r)) return null; return r.json() })
      .then(function (data) {
        if (!data) return
        var types = ["movie", "series", "unmatched"]
        for (var i = 0; i < types.length; i++) {
          var t = types[i]
          // Don't clobber a count a tab already rendered with its own data.
          if (S(t).loaded) { updateTabCount(t); continue }
          var el = document.querySelector('.lr-tab-count[data-tab="' + t + '"]')
          if (!el) continue
          var n = data[t] || 0
          el.textContent = String(n)
          el.style.display = n > 0 ? "" : "none"
        }
      })
      .catch(function () { /* badges fall back to lazy load on tab open */ })
  }

  function loadingHtml() {
    return '<div class="card"><p class="empty-state">' + escHtml(I18N.loading || "Loading…") + "</p></div>"
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  function renderTab(type) {
    var st = S(type)
    var root = document.querySelector('[data-lr-root="' + type + '"]')
    if (!root) return
    populateGenres(type)
    if (st.groups.length === 0) {
      root.innerHTML = '<div class="card"><p class="empty-state">' +
        escHtml(type === "movie" ? I18N.noMovies : type === "series" ? I18N.noSeries : I18N.noUnmatched) + "</p></div>"
      return
    }
    var frag = document.createDocumentFragment()
    var tmp = document.createElement("div")
    // Unmatched items render as flat movie-style cards (one card per file).
    for (var i = 0; i < st.groups.length; i++) {
      tmp.innerHTML = type === "series" ? seriesCardHtml(st.groups[i]) : movieCardHtml(st.groups[i])
      while (tmp.firstChild) frag.appendChild(tmp.firstChild)
    }
    root.innerHTML = ""
    root.appendChild(frag)
    initLazyImages(root)
  }

  function populateGenres(type) {
    var sel = document.getElementById("lr-genre-filter")
    if (!sel) return
    var current = sel.value
    var opts = '<option value="">' + escHtml(I18N.allGenres) + "</option>"
    var genres = S(type).genres
    for (var i = 0; i < genres.length; i++) opts += '<option value="' + escAttr(genres[i]) + '">' + escHtml(genres[i]) + "</option>"
    sel.innerHTML = opts
    if (current) sel.value = current
  }

  function posterHtml(group, iconClass) {
    if (SHOW_POSTERS && group.posterPath) {
      return '<img class="lr-lazy" data-src="/media-photos/' + escAttr(group.posterPath) +
        '" alt="' + escAttr(group.title) + '" loading="lazy" decoding="async">'
    }
    return '<div class="lr-card-placeholder"><i class="fa-solid ' + iconClass + '"></i></div>'
  }

  function metaHtml(group) {
    var html = ""
    if (group.year) html += '<span>(' + escHtml(group.year) + ") · </span>"
    html += '<span class="lr-card-genres">' + escHtml(group.genres || "") + "</span>"
    return html
  }

  function missingLangsHtml(item) {
    var html = '<div class="lr-missing-langs">'
    for (var i = 0; i < item.missingTargetLangIds.length; i++) {
      var langId = item.missingTargetLangIds[i]
      var lang = langById(langId)
      if (!lang) continue
      html += '<button type="button" class="btn btn-secondary lr-add-missing-lang-btn"' +
        ' data-item-id="' + escAttr(item.itemId) + '"' +
        ' data-lang-id="' + escAttr(langId) + '"' +
        ' title="Add ' + escAttr(lang.name) + ' to existing subtitle">' +
        (lang.flagCode ? '<span class="fi fi-' + escAttr(lang.flagCode) + '"></span> ' : "") +
        escHtml(lang.iso639) + "</button>"
    }
    html += "</div>"
    return html
  }

  function whisperBadgeHtml(item) {
    var cls = item.whisperStatus === "transcription_failed" ? "badge badge-error" : "badge badge-processing"
    return '<span class="' + cls + '">' + escHtml(whisperLabel(item.whisperStatus)) + "</span>"
  }

  // Movie card — mirrors the original movieGroups EJS block exactly.
  function movieCardHtml(group) {
    var items = group.items || []
    var searchText = ((group.title || "") + " " + items.map(fileNameOf).join(" ")).toLowerCase()
    var trans = items.filter(function (i) { return !i.subtitleId && !i.whisperStatus })
    var srt = trans.filter(function (i) { return i.hasSrt })
    var whisper = trans.filter(function (i) { return i.isVideo })[0]
    var missing = items.filter(function (i) { return i.subtitleId && i.missingTargetLangIds.length > 0 })
    var badges = items.filter(function (i) { return !i.subtitleId && i.whisperStatus })

    var html = '<div class="lr-card"' +
      ' data-group-key="' + escAttr(group.key) + '"' +
      ' data-search="' + escAttr(searchText) + '"' +
      ' data-genre="' + escAttr((group.genres || "").toLowerCase()) + '">'
    html += '<div class="lr-card-poster">' + posterHtml(group, "fa-film") + "</div>"
    html += '<div class="lr-card-body">'
    html += "<div>"
    html += '<div class="lr-card-title" title="' + escAttr(group.title) + '">' + escHtml(group.title) + "</div>"
    // Unmatched items are read-only — show the file's full path under the title
    // so the user can locate it on disk and fix/rename it themselves.
    if (group.type === "unmatched" && group.filePath) {
      html += '<div class="lr-card-path text-dim" title="' + escAttr(group.filePath) + '">' +
        escHtml(group.filePath) + "</div>"
    }
    html += '<div class="lr-card-meta">' + metaHtml(group) + "</div>"
    html += "</div>"

    for (var i = 0; i < missing.length; i++) html += missingLangsHtml(missing[i])
    for (var j = 0; j < badges.length; j++) html += whisperBadgeHtml(badges[j])

    if (trans.length > 0) {
      html += '<div class="lr-card-actions-col">'
      if (whisper && PERMS.canCreateSubtitlesWithWhisper) {
        html += '<button type="button" class="btn btn-secondary lr-create-subtitle-btn"' +
          ' data-item-id="' + escAttr(whisper.itemId) + '">' + escHtml(I18N.createSubtitle) + "</button>"
      }
      if (srt.length > 0) {
        var dataItems = srt.map(function (i) { return { id: i.itemId, name: i.fileName, isVideo: i.isVideo } })
        html += '<button type="button" class="btn btn-primary lr-translate-group-btn"' +
          ' data-items="' + escAttr(JSON.stringify(dataItems)) + '">' + escHtml(I18N.translate) + "</button>"
      }
      html += "</div>"
    }
    html += "</div></div>"
    return html
  }

  // Series card — only the season overview is rendered up front. Episode
  // panels are built lazily from in-memory items when a season is opened.
  function seriesCardHtml(group) {
    var items = group.items || []
    var searchText = ((group.title || "") + " " + items.map(fileNameOf).join(" ")).toLowerCase()
    var seasons = seasonMap(items)
    var skeys = seasonKeys(seasons)

    var html = '<div class="lr-card"' +
      ' data-group-key="' + escAttr(group.key) + '"' +
      ' data-search="' + escAttr(searchText) + '"' +
      ' data-genre="' + escAttr((group.genres || "").toLowerCase()) + '">'
    html += '<div class="lr-card-poster">' + posterHtml(group, "fa-tv") + "</div>"
    html += '<div class="lr-card-body">'
    html += '<div class="lr-card-title" title="' + escAttr(group.title) + '">' + escHtml(group.title) + "</div>"
    html += '<div class="lr-card-meta">' + metaHtml(group) + "</div>"
    html += '<div class="lr-season-list">'
    html += '<div class="lr-seasons-overview">'
    for (var i = 0; i < skeys.length; i++) {
      var sk = skeys[i]
      var eps = seasons[sk]
      var label = sk === "__" ? I18N.unknownSeason : I18N.season + parseInt(sk, 10)
      html += '<div class="lr-season-row" data-season-key="' + escAttr(sk) + '">'
      html += '<span class="lr-season-arrow">&#9658;</span>'
      html += '<span class="lr-season-label">' + escHtml(label) + "</span>"
      html += '<span class="badge badge-neutral lrx-badge-sm">' + eps.length + " " + escHtml(I18N.episodeCount) + (eps.length !== 1 ? "s" : "") + "</span>"
      html += '<button type="button" class="btn btn-primary lr-translate-season-btn lrx-season-translate-btn"' +
        ' data-library-path-id="' + escAttr((items[0] && items[0].libraryPathId) || 0) + '"' +
        ' data-season="' + escAttr(sk) + '"' +
        ' onclick="event.stopPropagation(); lrTranslateSeason(this)">' + escHtml(I18N.translateSeason) + "</button>"
      html += "</div>"
    }
    html += "</div>" // overview
    // Episode panels are inserted on demand by openSeason().
    html += "</div>" // season-list
    html += "</div></div>"
    return html
  }

  function seasonMap(items) {
    var sm = {}
    for (var i = 0; i < items.length; i++) {
      var it = items[i]
      var sk = (it.season !== null && it.season !== undefined) ? String(it.season) : "__"
      if (!sm[sk]) sm[sk] = []
      sm[sk].push(it)
    }
    return sm
  }
  function seasonKeys(sm) {
    return Object.keys(sm).sort(function (a, b) {
      if (a === "__") return 1
      if (b === "__") return -1
      return parseInt(a, 10) - parseInt(b, 10)
    })
  }

  function episodeRowHtml(it) {
    var html = '<div class="lr-card-item lr-episode-row"' +
      ' data-item-id="' + escAttr(it.itemId) + '"' +
      ' data-is-video="' + (it.isVideo ? "1" : "0") + '"' +
      ' data-filename="' + escAttr(it.fileName) + '">'
    if (it.season !== null && it.episode !== null) {
      html += '<span class="badge badge-neutral lr-episode-badge">S' +
        String(it.season).padStart(2, "0") + "E" + String(it.episode).padStart(2, "0") + "</span>"
    } else {
      html += '<span class="badge badge-neutral lr-episode-badge">' + escHtml(it.fileName) + "</span>"
    }
    if (it.subtitleId && it.missingTargetLangIds.length > 0) {
      html += missingLangsHtml(it)
    } else if (!it.subtitleId) {
      html += '<span class="lr-episode-sources"></span>'
      html += '<span class="lr-whisper-row lr-card-actions">'
      if (it.whisperStatus) {
        html += whisperBadgeHtml(it)
      } else {
        if (it.hasSrt) {
          html += '<button type="button" class="btn btn-primary lr-translate-btn"' +
            ' data-item-id="' + escAttr(it.itemId) + '">' + escHtml(I18N.translate) + "</button>"
        }
        if (it.isVideo && PERMS.canCreateSubtitlesWithWhisper) {
          html += '<button type="button" class="btn btn-secondary lr-create-subtitle-btn"' +
            ' data-item-id="' + escAttr(it.itemId) + '">' + escHtml(I18N.createSubtitle) + "</button>"
        }
      }
      html += "</span>"
    }
    html += "</div>"
    return html
  }

  // Build + insert a season panel from in-memory group items, then probe each
  // episode for available subtitle tracks (so episodes with none drop their
  // Translate button, matching the original behavior).
  function openSeason(row) {
    var list = row.closest(".lr-season-list")
    if (!list) return
    var sk = row.dataset.seasonKey
    var card = list.closest(".lr-card")
    var group = findGroup(card && card.dataset.groupKey)
    if (!group) return

    list.querySelector(".lr-seasons-overview").style.display = "none"
    list.querySelectorAll(".lr-season-panel").forEach(function (p) { p.style.display = "none" })

    var existing = list.querySelector('.lr-season-panel[data-season-key="' + sk + '"]')
    if (!existing) {
      var sm = seasonMap(group.items)
      var eps = sm[sk] || []
      var label = sk === "__" ? "Unknown Season" : "Season " + parseInt(sk, 10)
      var panel = document.createElement("div")
      panel.className = "lr-season-panel"
      panel.dataset.seasonKey = sk
      panel.style.display = "none"
      var html = '<div class="lr-season-back" data-season-key="' + escAttr(sk) + '">'
      html += '<span class="lr-season-arrow lrx-arrow-accent">&#9660;</span>'
      html += '<span class="lr-season-label">' + escHtml(label) + "</span>"
      html += '<span class="badge badge-neutral lrx-badge-sm">' + eps.length + " " + escHtml(I18N.episodeCount) + (eps.length !== 1 ? "s" : "") + "</span>"
      html += "</div>"
      html += '<div class="lr-season-items">'
      for (var i = 0; i < eps.length; i++) html += episodeRowHtml(eps[i])
      html += "</div>"
      panel.innerHTML = html
      list.appendChild(panel)
      existing = panel
    }
    existing.style.display = ""
    lrLoadEpisodeSources(existing)
  }

  function closeSeason(list) {
    list.querySelectorAll(".lr-season-panel").forEach(function (p) { p.style.display = "none" })
    var ov = list.querySelector(".lr-seasons-overview")
    if (ov) ov.style.display = ""
  }

  function findGroup(groupKey) {
    var groups = S(activeTab).groups
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].key === groupKey) return groups[i]
    }
    return null
  }

  // ── Lazy image loading (IntersectionObserver) ────────────────────────────
  var lazyObserver = null
  function initLazyImages(root) {
    var imgs = root.querySelectorAll("img.lr-lazy")
    if (!imgs.length) return
    if (!("IntersectionObserver" in window)) {
      imgs.forEach(function (img) { if (img.dataset.src) img.src = img.dataset.src })
      return
    }
    if (!lazyObserver) {
      lazyObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            var img = entry.target
            if (img.dataset.src) { img.src = img.dataset.src; img.removeAttribute("data-src") }
            lazyObserver.unobserve(img)
          }
        })
      }, { rootMargin: "200px" })
    }
    imgs.forEach(function (img) { lazyObserver.observe(img) })
  }
  window.lrInitLazyLoad = initLazyImages

  // ── Filters ──────────────────────────────────────────────────────────────
  function applyFilters() {
    var q = (document.getElementById("lr-search").value || "").trim().toLowerCase()
    var genreEl = document.getElementById("lr-genre-filter")
    var genre = genreEl ? genreEl.value.toLowerCase() : ""
    var container = document.getElementById("lr-tab-" + activeTab)
    if (!container) return
    container.querySelectorAll(".lr-card").forEach(function (el) {
      var text = el.getAttribute("data-search") || ""
      var elGenre = el.getAttribute("data-genre") || ""
      var matchQ = !q || text.indexOf(q) !== -1
      var matchGenre = !genre || elGenre.indexOf(genre) !== -1
      el.style.display = (matchQ && matchGenre) ? "" : "none"
    })
  }

  // ── Toast ────────────────────────────────────────────────────────────────
  function showToast(message, type) {
    var t = document.createElement("div")
    t.className = "toast toast-" + (type || "success")
    t.innerHTML = '<span class="toast-msg"></span><button type="button" class="toast-close" aria-label="Close">✕</button>'
    t.querySelector(".toast-msg").textContent = message
    document.body.appendChild(t)
    t.querySelector(".toast-close").addEventListener("click", function () { t.remove() })
    setTimeout(function () { if (t.parentNode) t.remove() }, 4000)
  }

  // ── Translate / create actions ───────────────────────────────────────────
  function translateItem(itemId, sourceChoice) {
    var url = "/library-paths/item/" + itemId + "/translate"
    var body = ""
    if (sourceChoice) {
      body = "sourceType=" + encodeURIComponent(sourceChoice.type || "") +
        "&sourcePath=" + encodeURIComponent(sourceChoice.path || "") +
        "&sourceLanguage=" + encodeURIComponent(sourceChoice.language || "") +
        "&sourceCodec=" + encodeURIComponent(sourceChoice.codec || "")
    }
    return fetch(url + "?json=1", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body,
    }).then(function (r) { if (redirectIfUnauthorized(r)) return null; return r.json() })
  }

  function lrGuessLangFromName(name) {
    if (!name) return ""
    var base = String(name).replace(/\.(srt|ass|ssa|vtt|sub)$/i, "")
    var m = base.match(/\.([a-z]{2,3})$/i)
    return m ? m[1].toLowerCase() : ""
  }

  function fetchSources(itemId) {
    return fetch("/library-requests/item/" + itemId + "/subtitle-sources")
      .then(function (r) { return r.json() })
      .then(function (data) { return (data && data.success && data.sources) ? data.sources : [] })
      .catch(function () { return [] })
  }

  // Per-episode subtitle tracks for a season panel (lazy, once per panel).
  function lrLoadEpisodeSources(panel) {
    var rows = Array.prototype.slice.call(panel.querySelectorAll(".lr-episode-row"))
    return Promise.all(rows.map(function (row) {
      if (row._lrSourcesLoaded) return Promise.resolve()
      var translateBtn = row.querySelector(".lr-translate-btn")
      if (!translateBtn) { row._lrSourcesLoaded = true; return Promise.resolve() }
      var itemId = row.dataset.itemId
      return fetchSources(itemId).then(function (sources) {
        sources.forEach(function (s) { s.language = s.language || lrGuessLangFromName(s.filename || s.label || row.dataset.filename || "") })
        row._lrSources = sources
        row._lrSourcesLoaded = true
        if (sources.length === 0) { var b = row.querySelector(".lr-translate-btn"); if (b) b.remove() }
      })
    }))
  }

  function lrEpBadge(row) {
    var b = row.querySelector(".lr-episode-badge")
    return b ? (b.textContent || "").trim() : (row.dataset.filename || "")
  }

  // Translate a whole season via a per-episode track picker dialog.
  var seasonEps = []
  window.lrTranslateSeason = function lrTranslateSeason(seasonBtn) {
    var sk = seasonBtn.dataset.season
    var list = seasonBtn.closest(".lr-season-list")
    var panel = list && list.querySelector('.lr-season-panel[data-season-key="' + sk + '"]')
    if (!panel) {
      // Panel not open yet — open it first so the rows exist.
      var row = list && list.querySelector('.lr-season-row[data-season-key="' + sk + '"]')
      if (row) openSeason(row)
      panel = list && list.querySelector('.lr-season-panel[data-season-key="' + sk + '"]')
    }
    if (!panel) return
    var rows = Array.prototype.slice.call(panel.querySelectorAll(".lr-episode-row"))
      .filter(function (r) { return !r.querySelector(".lr-add-missing-lang-btn") && (r.querySelector(".lr-translate-btn") || r.querySelector(".lr-create-subtitle-btn")) })
    document.getElementById("season-translate-list").innerHTML = '<p class="text-dim">' + escHtml(I18N.loading || "Loading…") + "</p>"
    openModal("season-translate-modal")
    Promise.all(rows.map(function (row) {
      var itemId = row.dataset.itemId
      var build = function (srcs) {
        srcs.forEach(function (s) { s.language = s.language || lrGuessLangFromName(s.filename || s.label || row.dataset.filename || "") })
        return { itemId: itemId, fileName: row.dataset.filename || "", badge: lrEpBadge(row), sources: srcs }
      }
      if (row._lrSourcesLoaded) return Promise.resolve(build(row._lrSources || []))
      return fetchSources(itemId).then(build)
    })).then(renderSeasonTranslateList)
  }

  function renderSeasonTranslateList(eps) {
    seasonEps = eps
    var container = document.getElementById("season-translate-list")
    container.innerHTML = ""
    if (eps.length === 0) { container.innerHTML = '<p class="text-dim">No episodes to translate.</p>'; return }
    eps.forEach(function (ep) {
      var rowEl = document.createElement("div")
      rowEl.className = "season-tr-row"
      var label = document.createElement("span")
      label.className = "badge badge-neutral season-tr-ep"
      label.textContent = ep.badge || ep.fileName
      rowEl.appendChild(label)
      if (ep.sources.length === 0) {
        var note = document.createElement("span")
        note.className = "text-dim season-tr-note"
        note.textContent = I18N.noTracksWhisper
        rowEl.appendChild(note)
        ep._sel = null
      } else {
        var sel = document.createElement("select")
        sel.className = "season-tr-select"
        ep.sources.forEach(function (s, i) {
          var opt = document.createElement("option")
          opt.value = String(i)
          opt.textContent = (s.type === "embedded" ? "Embedded" : "External") + " · " + ((s.language || "").toUpperCase() || "unknown") + (s.codec ? (" · " + s.codec) : "")
          sel.appendChild(opt)
        })
        rowEl.appendChild(sel)
        ep._sel = sel
      }
      container.appendChild(rowEl)
    })
  }

  function setupSeasonConfirm() {
    var confirmBtn = document.getElementById("season-translate-confirm")
    if (!confirmBtn) return
    confirmBtn.addEventListener("click", function () {
      var jobs = seasonEps.filter(function (ep) { return ep.sources.length > 0 && ep._sel })
      if (jobs.length === 0) { showToast("No subtitle tracks to translate", "error"); return }
      confirmBtn.disabled = true
      var queued = 0, failed = 0
      var chain = Promise.resolve()
      jobs.forEach(function (ep) {
        chain = chain.then(function () {
          var s = ep.sources[parseInt(ep._sel.value, 10)] || ep.sources[0]
          var choice = { type: s.type, path: s.path, language: s.language || "", codec: s.codec }
          return translateItem(ep.itemId, choice)
            .then(function (resp) { if (resp && resp.success) queued++; else failed++ })
            .catch(function () { failed++ })
        })
      })
      chain.then(function () {
        confirmBtn.disabled = false
        closeModal("season-translate-modal")
        showToast("Queued " + queued + " episode(s)" + (failed ? ", " + failed + " failed" : ""), (failed && !queued) ? "error" : "success")
        if (queued) refreshActiveTab()
      })
    })
  }

  function handleTranslateClick(btn) {
    var itemId = btn.dataset.itemId
    var guessedLang = lrGuessLangFromName(btn.dataset.filename || "")
    var defaultChoice = guessedLang ? { language: guessedLang } : null
    var epRow = btn.closest(".lr-episode-row")
    if (epRow && epRow._lrSourcesLoaded) {
      var loaded = epRow._lrSources || []
      if (loaded.length === 0) { translateItem(itemId, defaultChoice).then(function (r) { onTranslateResponse(btn, r) }); return }
      if (loaded.length === 1) {
        var one = loaded[0]; if (!one.language && guessedLang) one.language = guessedLang
        translateItem(itemId, one).then(function (r) { onTranslateResponse(btn, r) }); return
      }
      openSourceDialog(itemId, loaded, btn, guessedLang); return
    }
    fetchSources(itemId).then(function (sources) {
      if (sources.length === 0) { translateItem(itemId, defaultChoice).then(function (r) { onTranslateResponse(btn, r) }); return }
      if (sources.length === 1) {
        var only = sources[0]
        if (!only.language && guessedLang) only.language = guessedLang
        translateItem(itemId, only).then(function (r) { onTranslateResponse(btn, r) }); return
      }
      openSourceDialog(itemId, sources, btn, guessedLang)
    })
  }

  function openSourceDialog(itemId, sources, btn, guessedLang) {
    var list = document.getElementById("subtitle-source-list")
    list.innerHTML = ""
    sources.forEach(function (s) {
      var srcLang = s.language || lrGuessLangFromName(s.filename || s.label) || guessedLang || ""
      var row = document.createElement("button")
      row.type = "button"
      row.className = "btn btn-secondary lr-source-pick"
      var typeLabel = s.type === "embedded" ? "Embedded" : "External"
      var langLabel = srcLang ? srcLang.toUpperCase() : "unknown"
      var codecLine = s.codec ? " · " + s.codec : ""
      var detail = s.filename || (s.label && s.label !== s.filename ? s.label : "")
      row.innerHTML = "<strong>" + escHtml(typeLabel + " · " + langLabel + codecLine) + "</strong>" +
        (detail ? '<span class="text-dim lr-source-detail">' + escHtml(detail) + "</span>" : "")
      row.addEventListener("click", function () {
        closeModal("subtitle-source-modal")
        var choice = { type: s.type, path: s.path, language: srcLang, codec: s.codec }
        translateItem(itemId, choice).then(function (resp) { onTranslateResponse(btn, resp) })
      })
      list.appendChild(row)
    })
    openModal("subtitle-source-modal")
  }

  // Movie "Translate": aggregate sources across the movie's files/tracks.
  function lrTranslateMovie(btn) {
    var items
    try { items = JSON.parse(btn.dataset.items || "[]") } catch (e) { items = [] }
    if (items.length === 0) return
    btn.disabled = true
    Promise.all(items.map(function (it) {
      return fetchSources(it.id).then(function (srcs) {
        if (srcs.length === 0) return [{ itemId: it.id, fileName: it.name, source: null, lang: lrGuessLangFromName(it.name) }]
        return srcs.map(function (s) {
          return { itemId: it.id, fileName: it.name, source: s, lang: s.language || lrGuessLangFromName(s.filename || s.label || it.name) }
        })
      })
    })).then(function (lists) {
      btn.disabled = false
      var opts = Array.prototype.concat.apply([], lists)
      if (opts.length === 0) return
      if (opts.length === 1) { lrDoMovieTranslate(opts[0], btn); return }
      lrShowMovieSourcePopup(opts, btn, items.length > 1)
    }).catch(function () { btn.disabled = false; showToast("Request failed", "error") })
  }

  function lrDoMovieTranslate(opt, btn) {
    var choice = opt.source
      ? { type: opt.source.type, path: opt.source.path, language: opt.source.language || opt.lang || "", codec: opt.source.codec }
      : (opt.lang ? { language: opt.lang } : null)
    translateItem(opt.itemId, choice).then(function (resp) {
      if (!resp) return
      showToast(resp.msg || (resp.success ? "Queued" : "Failed"), resp.success ? "success" : "error")
      if (resp.success) refreshActiveTab()
    })
  }

  function lrShowMovieSourcePopup(opts, btn, showFile) {
    var list = document.getElementById("subtitle-source-list")
    list.innerHTML = ""
    opts.forEach(function (opt) {
      var s = opt.source
      var row = document.createElement("button")
      row.type = "button"
      row.className = "btn btn-secondary lr-source-pick"
      var typeLabel = s ? (s.type === "embedded" ? "Embedded" : "External") : "Subtitle file"
      var langLabel = (opt.lang || "").toUpperCase() || "unknown"
      var codecLine = s && s.codec ? " · " + s.codec : ""
      var detail = showFile ? opt.fileName : ((s && s.filename) || "")
      row.innerHTML = "<strong>" + escHtml(typeLabel + " · " + langLabel + codecLine) + "</strong>" +
        (detail ? '<span class="text-dim lr-source-detail">' + escHtml(detail) + "</span>" : "")
      row.addEventListener("click", function () {
        closeModal("subtitle-source-modal")
        lrDoMovieTranslate(opt, btn)
      })
      list.appendChild(row)
    })
    openModal("subtitle-source-modal")
  }

  function onTranslateResponse(btn, data) {
    if (!data) return
    if (data.success) {
      showToast(data.msg || "Queued", "success")
      refreshActiveTab()
    } else {
      showToast(data.msg || "Failed", "error")
    }
  }

  // ── Delegated event handlers ─────────────────────────────────────────────
  document.addEventListener("click", function (e) {
    // Season open / close
    var row = e.target.closest(".lr-season-row")
    if (row) { openSeason(row); return }
    var back = e.target.closest(".lr-season-back")
    if (back) { var list = back.closest(".lr-season-list"); if (list) closeSeason(list); return }

    var groupBtn = e.target.closest(".lr-translate-group-btn")
    if (groupBtn) { lrTranslateMovie(groupBtn); return }

    var tBtn = e.target.closest(".lr-translate-btn")
    if (tBtn) { handleTranslateClick(tBtn); return }

    var createBtn = e.target.closest(".lr-create-subtitle-btn")
    if (createBtn) {
      var itemId = createBtn.dataset.itemId
      createBtn.disabled = true
      createBtn.textContent = I18N.creatingSubtitle
      fetch("/library-requests/item/" + itemId + "/create-whisper-subtitle", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      })
        .then(function (r) { if (redirectIfUnauthorized(r)) return null; return r.json() })
        .then(function (data) {
          if (!data) return
          showToast(data.msg || (data.success ? "Created" : "Failed"), data.success ? "success" : "error")
          if (data.success) {
            var wr = createBtn.closest(".lr-whisper-row")
            if (wr) wr.innerHTML = '<span class="badge badge-processing">' + escHtml(whisperLabel("queued_for_transcription")) + "</span>"
            refreshActiveTab()
          } else {
            createBtn.disabled = false
            createBtn.textContent = I18N.createSubtitle
          }
        })
        .catch(function () {
          createBtn.disabled = false
          createBtn.textContent = I18N.createSubtitle
          showToast("Request failed", "error")
        })
      return
    }

    var missingBtn = e.target.closest(".lr-add-missing-lang-btn")
    if (missingBtn) {
      var mItemId = missingBtn.dataset.itemId
      var langId = missingBtn.dataset.langId
      fetch("/library-requests/item/" + mItemId + "/add-missing-lang?json=1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "targetLangIds=" + encodeURIComponent(langId),
      })
        .then(function (r) { if (redirectIfUnauthorized(r)) return null; return r.json() })
        .then(function (data) {
          if (!data) return
          if (data.success) { missingBtn.style.display = "none"; showToast(data.msg || "Added", "success"); refreshActiveTab() }
          else showToast(data.msg || "Failed", "error")
        })
        .catch(function () { showToast("Request failed", "error") })
      return
    }

    // Close server-rendered toast
    if (e.target.closest("[data-toast-close]")) {
      var t = e.target.closest(".toast")
      if (t) t.remove()
    }
  })

  // ── Preserve/restore open season panels across refresh ───────────────────
  function captureOpenSeasons(type) {
    var open = []
    var root = document.querySelector('[data-lr-root="' + type + '"]')
    if (!root) return open
    root.querySelectorAll(".lr-season-panel").forEach(function (panel) {
      if (panel.style.display !== "none") {
        var card = panel.closest(".lr-card")
        var gk = card && card.dataset.groupKey
        if (gk) open.push(gk + "|" + panel.dataset.seasonKey)
      }
    })
    return open
  }
  function restoreOpenSeasons(type, open) {
    if (!open || open.length === 0) return
    var root = document.querySelector('[data-lr-root="' + type + '"]')
    if (!root) return
    open.forEach(function (key) {
      var idx = key.indexOf("|")
      var gk = key.slice(0, idx)
      var sk = key.slice(idx + 1)
      var card = root.querySelector('.lr-card[data-group-key="' + gk + '"]')
      if (!card) return
      var r = card.querySelector('.lr-season-row[data-season-key="' + sk + '"]')
      if (r) openSeason(r)
    })
  }

  // ── Wire up filters + boot ───────────────────────────────────────────────
  function bindFilters() {
    var searchEl = document.getElementById("lr-search")
    if (searchEl) {
      searchEl.addEventListener("input", function () {
        clearTimeout(searchTimer)
        searchTimer = setTimeout(applyFilters, 300)
      })
    }
    var genreEl = document.getElementById("lr-genre-filter")
    if (genreEl) genreEl.addEventListener("change", applyFilters)
  }

  function boot() {
    bindFilters()
    setupSeasonConfirm()
    var initial = "movie"
    if (history.replaceState) {
      var u = new URL(window.location.href)
      var t = u.searchParams.get("tab")
      if (t === "series" || t === "movie" || t === "unmatched") initial = t
    }
    lrSwitchTab(initial)
    preloadTabCounts()
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot)
  } else {
    boot()
  }
})()