;(function () {
  "use strict"

  var PERMS = window.LR_PERMS || {}
  var LANG_BY_ID = window.LR_LANG_BY_ID || {}
  var SHOW_POSTERS = !!window.LR_SHOW_POSTERS

  var state = { movie: newState(), series: newState(), unmatched: newState() }
  var activeTab = "movie"
  var searchTimer = null

  function newState() {
    return { loaded: false, loading: false, groups: [], genres: [] }
  }
  function S(type) {
    return state[type]
  }

  function escHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
  }
  function escAttr(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  }

  function csrfToken() {
    var input = document.querySelector('input[name="__RequestVerificationToken"]')
    return input ? input.value : ""
  }

  function whisperLabel(status) {
    var labels = {
      queued_for_transcription: "Whisper queued",
      transcribing: "Transcribing",
      transcription_failed: "Transcription failed",
      completed: "Transcribed",
    }
    return labels[status] || String(status || "").replace(/_/g, " ")
  }
  function langById(id) {
    return LANG_BY_ID[id]
  }
  function fileNameOf(it) {
    return it.fileName || ""
  }

  function showToast(message, type) {
    var existing = document.getElementById("page-toast")
    if (existing) existing.remove()
    var t = document.createElement("div")
    t.className = "toast toast-" + (type || "success")
    t.id = "page-toast"
    t.innerHTML =
      '<span class="toast-msg"></span><button type="button" class="toast-close" aria-label="Close">✕</button>'
    t.querySelector(".toast-msg").textContent = message
    var main = document.querySelector(".main-content")
    ;(main || document.body).prepend(t)
    t.querySelector(".toast-close").addEventListener("click", function () {
      t.remove()
    })
    setTimeout(function () {
      if (t.parentNode) t.remove()
    }, 4000)
  }

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
    else {
      populateGenres(tab)
      applyFilters()
    }
  }

  function loadTab(type) {
    var st = S(type)
    if (st.loading) return
    st.loading = true
    var root = document.querySelector('[data-lr-root="' + type + '"]')
    if (root) root.innerHTML = loadingHtml()
    fetch("/library-requests/data?type=" + type)
      .then(function (r) {
        if (redirectIfUnauthorized(r)) return null
        return r.json()
      })
      .then(function (data) {
        st.loading = false
        if (!data) return
        st.groups = data.groups || []
        st.genres = data.allGenres || []
        st.loaded = true
        renderTab(type)
        updateTabCount(type)
        applyFilters()
      })
      .catch(function () {
        st.loading = false
        if (root) root.innerHTML = '<div class="card"><p class="empty-state">Failed to load.</p></div>'
      })
  }

  function refreshActiveTab() {
    var st = S(activeTab)
    if (!st.loaded) return
    var openSeasons = captureOpenSeasons(activeTab)
    var scrollTop = window.scrollY
    st.loading = true
    fetch("/library-requests/data?type=" + activeTab)
      .then(function (r) {
        if (redirectIfUnauthorized(r)) return null
        return r.json()
      })
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
      .catch(function () {
        st.loading = false
      })
  }

  function updateTabCount(type) {
    var el = document.querySelector('.lr-tab-count[data-tab="' + type + '"]')
    if (!el) return
    var n = S(type).groups.length
    el.textContent = String(n)
    el.style.display = n > 0 ? "" : "none"
  }

  function updateActiveTabBadgeFromVisible() {
    var container = document.getElementById("lr-tab-" + activeTab)
    if (!container) return
    var n = 0
    container.querySelectorAll(".lr-card").forEach(function (el) {
      if (el.style.display !== "none") n++
    })
    var el = document.querySelector('.lr-tab-count[data-tab="' + activeTab + '"]')
    if (el) {
      el.textContent = String(n)
      el.style.display = n > 0 ? "" : "none"
    }
  }

  function preloadTabCounts() {
    fetch("/library-requests/counts")
      .then(function (r) {
        if (redirectIfUnauthorized(r)) return null
        return r.json()
      })
      .then(function (data) {
        if (!data) return
        var types = ["movie", "series", "unmatched"]
        for (var i = 0; i < types.length; i++) {
          var t = types[i]
          if (S(t).loaded) {
            updateTabCount(t)
            continue
          }
          var el = document.querySelector('.lr-tab-count[data-tab="' + t + '"]')
          if (!el) continue
          var n = data[t] || 0
          el.textContent = String(n)
          el.style.display = n > 0 ? "" : "none"
        }
      })
      .catch(function () {
      })
  }

  function loadingHtml() {
    return '<div class="card"><p class="empty-state">Loading…</p></div>'
  }

  function renderTab(type) {
    var st = S(type)
    var root = document.querySelector('[data-lr-root="' + type + '"]')
    if (!root) return
    populateGenres(type)
    if (st.groups.length === 0) {
      var empty =
        type === "movie"
          ? "No movie requests."
          : type === "series"
            ? "No series requests."
            : "No unmatched items."
      root.innerHTML = '<div class="card"><p class="empty-state">' + escHtml(empty) + "</p></div>"
      return
    }
    var frag = document.createDocumentFragment()
    var tmp = document.createElement("div")
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
    var opts = '<option value="">All genres</option>'
    var genres = S(type).genres
    for (var i = 0; i < genres.length; i++)
      opts += '<option value="' + escAttr(genres[i]) + '">' + escHtml(genres[i]) + "</option>"
    sel.innerHTML = opts
    if (current) sel.value = current
  }

  function posterHtml(group, iconClass) {
    if (SHOW_POSTERS && group.posterPath) {
      return (
        '<img class="lr-lazy" data-src="/media-photos/' +
        escAttr(group.posterPath) +
        '" alt="' +
        escAttr(group.title) +
        '" loading="lazy" decoding="async">'
      )
    }
    return '<div class="lr-card-placeholder"><i class="fa-solid ' + iconClass + '"></i></div>'
  }

  function metaHtml(group) {
    var html = ""
    if (group.year) html += "<span>(" + escHtml(group.year) + ") · </span>"
    html += '<span class="lr-card-genres">' + escHtml(group.genres || "") + "</span>"
    return html
  }

  function translatedLangBadgesHtml(langIds) {
    if (!langIds || !langIds.length) return ""
    var html = ""
    for (var i = 0; i < langIds.length; i++) {
      var lang = langById(langIds[i])
      if (!lang) continue
      html +=
        '<span class="badge badge-success lrx-badge-sm"' +
        ' title="' +
        escAttr(lang.name) +
        '">' +
        (lang.flagCode ? '<span class="fi fi-' + escAttr(lang.flagCode) + '"></span> ' : "") +
        escHtml(lang.iso639) +
        "</span>"
    }
    return html
  }

  function translatedLangsUnion(items) {
    var seen = {}
    var out = []
    ;(items || []).forEach(function (it) {
      ;(it.translatedTargetLangIds || []).forEach(function (id) {
        if (!seen[id]) {
          seen[id] = true
          out.push(id)
        }
      })
    })
    return out
  }

  function whisperBadgeHtml(item) {
    var cls = item.whisperStatus === "transcription_failed" ? "badge badge-error" : "badge badge-processing"
    return '<span class="' + cls + '">' + escHtml(whisperLabel(item.whisperStatus)) + "</span>"
  }

  function movieCardHtml(group) {
    var items = group.items || []
    var extras = group.extras || []
    var searchText = (
      (group.title || "") +
      " " +
      items.map(fileNameOf).join(" ") +
      " " +
      extras
        .map(function (e) {
          return e.title || ""
        })
        .join(" ")
    ).toLowerCase()
    var trans = items.filter(function (i) {
      return !i.subtitleId && !i.whisperStatus
    })
    var srt = trans.filter(function (i) {
      return i.hasSrt
    })
    var missing = items.filter(function (i) {
      return i.subtitleId && i.missingTargetLangIds.length > 0
    })
    var badges = items.filter(function (i) {
      return !i.subtitleId && i.whisperStatus
    })

    var html =
      '<div class="lr-card"' +
      ' data-group-key="' +
      escAttr(group.key) +
      '"' +
      ' data-search="' +
      escAttr(searchText) +
      '"' +
      ' data-genre="' +
      escAttr((group.genres || "").toLowerCase()) +
      '">'
    html += '<div class="lr-card-poster">' + posterHtml(group, "fa-film") + "</div>"
    html += '<div class="lr-card-body">'
    html += "<div>"
    html += '<div class="lr-card-title" title="' + escAttr(group.title) + '">' + escHtml(group.title) + "</div>"
    if (group.type === "unmatched" && group.filePath) {
      html +=
        '<div class="lr-card-path text-dim" title="' +
        escAttr(group.filePath) +
        '">' +
        escHtml(group.filePath) +
        "</div>"
    }
    html += '<div class="lr-card-meta">' + metaHtml(group) + "</div>"
    html += "</div>"

    for (var m = 0; m < missing.length; m++) html += missingLangsHtml(missing[m])
    for (var j = 0; j < badges.length; j++) html += whisperBadgeHtml(badges[j])

    var translatedLangs = translatedLangsUnion(items)
    var whisper = trans.filter(function (i) {
      return i.isVideo
    })[0] || null
    var canWhisper = !!PERMS.canCreateSubtitlesWithWhisper && !!whisper
    if (translatedLangs.length > 0 || group.fullyTranslated || srt.length > 0 || canWhisper) {
      html += '<div class="lr-card-actions-col">'
      html += '<div class="lr-lang-badges lr-movie-translated">'
      if (group.fullyTranslated) {
        html +=
          '<span class="badge badge-success"><i class="fa-solid fa-check"></i> Fully translated</span>'
      }
      html += translatedLangBadgesHtml(translatedLangs)
      html += "</div>"
      if (canWhisper) {
        html +=
          '<button type="button" class="btn btn-secondary lr-create-subtitle-btn"' +
          ' data-item-id="' +
          escAttr(String(whisper.itemId)) +
          '">Create Subtitles</button>'
        if (extras.length > 0) {
          var targets = [{ id: whisper.itemId, name: group.title, whisperStatus: "" }].concat(
            extras.map(function (e) {
              return { id: e.itemId, name: e.title || e.fileName, whisperStatus: e.whisperStatus || "" }
            }),
          )
          html +=
            '<button type="button" class="btn btn-secondary lr-extras-pick"' +
            ' data-items="' +
            escAttr(JSON.stringify(targets)) +
            '">Extras…</button>'
        }
      }
      if (srt.length > 0) {
        var dataItems = srt.map(function (i) {
          return { id: i.itemId, name: i.fileName, isVideo: i.isVideo }
        })
        html +=
          '<button type="button" class="btn btn-primary lr-translate-group-btn"' +
          ' data-items="' +
          escAttr(JSON.stringify(dataItems)) +
          '">Translate</button>'
      }
      html += "</div>"
    }

    if (extras.length > 0) {
      html += '<div class="lr-extras">'
      html += '<div class="lr-extras-label">Extras</div>'
      extras.forEach(function (e) {
        html +=
          '<div class="lr-card-item lr-extra-row"' +
          ' data-item-id="' +
          escAttr(String(e.itemId)) +
          '"' +
          ' data-filename="' +
          escAttr(e.fileName) +
          '">'
        html +=
          '<span class="lr-extra-title">Extra · ' +
          escHtml(e.title || e.fileName) +
          "</span>"
        html += '<span class="lr-whisper-row lr-card-actions">'
        if (e.whisperStatus) html += whisperBadgeHtml(e)
        if (e.hasEmbedded) {
          html +=
            '<button type="button" class="btn btn-primary lr-translate-btn"' +
            ' data-item-id="' +
            escAttr(String(e.itemId)) +
            '"' +
            ' data-filename="' +
            escAttr(e.fileName) +
            '">Translate</button>'
        }
        html += "</span>"
        html += "</div>"
      })
      html += "</div>"
    }

    html += "</div></div>"
    return html
  }

  function seriesCardHtml(group) {
    var items = group.items || []
    var searchText = ((group.title || "") + " " + items.map(fileNameOf).join(" ")).toLowerCase()
    var seasons = seasonMap(items)
    var skeys = seasonKeys(seasons)

    var html =
      '<div class="lr-card"' +
      ' data-group-key="' +
      escAttr(group.key) +
      '"' +
      ' data-search="' +
      escAttr(searchText) +
      '"' +
      ' data-genre="' +
      escAttr((group.genres || "").toLowerCase()) +
      '">'
    html += '<div class="lr-card-poster">' + posterHtml(group, "fa-tv") + "</div>"
    html += '<div class="lr-card-body">'
    html += '<div class="lr-card-title" title="' + escAttr(group.title) + '">' + escHtml(group.title) + "</div>"
    html += '<div class="lr-card-meta">' + metaHtml(group) + "</div>"
    html += '<div class="lr-season-list">'
    html += '<div class="lr-seasons-overview">'
    if (group.fullyTranslated) {
      html +=
        '<div class="lr-lang-badges lr-series-translated">' +
        '<span class="badge badge-success"><i class="fa-solid fa-check"></i> Fully translated</span></div>'
    }
    for (var i = 0; i < skeys.length; i++) {
      var sk = skeys[i]
      var eps = seasons[sk]
      var label = sk === "__" ? "Unknown season" : "Season " + parseInt(sk, 10)
      html += '<div class="lr-season-row" data-season-key="' + escAttr(sk) + '">'
      html += '<span class="lr-season-arrow">&#9658;</span>'
      html += '<span class="lr-season-label">' + escHtml(label) + "</span>"
      html +=
        '<span class="badge badge-neutral lrx-badge-sm">' +
        eps.length +
        " episode" +
        (eps.length !== 1 ? "s" : "") +
        "</span>"
      html +=
        '<button type="button" class="btn btn-primary lr-translate-season-btn lrx-season-translate-btn"' +
        ' data-library-path-id="' +
        escAttr((items[0] && items[0].libraryPathId) || 0) +
        '"' +
        ' data-season="' +
        escAttr(sk) +
        '"' +
        ' onclick="event.stopPropagation(); lrTranslateSeason(this)">Translate season</button>'
      html += "</div>"
    }
    html += "</div>"
    html += "</div>"
    html += "</div></div>"
    return html
  }

  function seasonMap(items) {
    var sm = {}
    for (var i = 0; i < items.length; i++) {
      var it = items[i]
      var sk = it.season !== null && it.season !== undefined ? String(it.season) : "__"
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
    var html =
      '<div class="lr-card-item lr-episode-row"' +
      ' data-item-id="' +
      escAttr(it.itemId) +
      '"' +
      ' data-is-video="' +
      (it.isVideo ? "1" : "0") +
      '"' +
      ' data-filename="' +
      escAttr(it.fileName) +
      '" style="gap:0;">'
    if (it.season !== null && it.episode !== null) {
      html +=
        '<span class="badge badge-neutral lr-episode-badge">S' +
        String(it.season).padStart(2, "0") +
        "E" +
        String(it.episode).padStart(2, "0") +
        "</span>"
    } else {
      html += '<span class="badge badge-neutral lr-episode-badge">' + escHtml(it.fileName) + "</span>"
    }
    if (it.subtitleDeleted) {
      html += '<span class="badge badge-warning lr-deleted-badge">Deleted — re-add</span>'
    }
    if (it.subtitleId && it.missingTargetLangIds.length > 0) {
      html += missingLangsHtml(it)
    }
    html += '<span class="lr-episode-sources"></span>'
    if (it.translatedTargetLangIds && it.translatedTargetLangIds.length > 0) {
      html += '<div class="lr-lang-badges lr-episode-lang-badges">'
      html += translatedLangBadgesHtml(it.translatedTargetLangIds)
      html += "</div>"
    }
    html += '<span class="lr-whisper-row lr-card-actions">'
    if (it.whisperStatus) {
      html += whisperBadgeHtml(it)
    } else if (it.hasSrt) {
      html +=
        '<button type="button" class="btn btn-primary lr-translate-btn"' +
        ' data-item-id="' +
        escAttr(it.itemId) +
        '" data-filename="' +
        escAttr(it.fileName) +
        '">Translate</button>'
    }
    html += "</span>"
    html += "</div>"
    return html
  }

  function openSeason(row) {
    var list = row.closest(".lr-season-list")
    if (!list) return
    var sk = row.dataset.seasonKey
    var card = list.closest(".lr-card")
    var group = findGroup(card && card.dataset.groupKey)
    if (!group) return

    list.querySelector(".lr-seasons-overview").style.display = "none"
    list.querySelectorAll(".lr-season-panel").forEach(function (p) {
      p.style.display = "none"
    })

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
      html +=
        '<span class="badge badge-neutral lrx-badge-sm">' +
        eps.length +
        " episode" +
        (eps.length !== 1 ? "s" : "") +
        "</span>"
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
    list.querySelectorAll(".lr-season-panel").forEach(function (p) {
      p.style.display = "none"
    })
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

  var lazyObserver = null
  function initLazyImages(root) {
    var imgs = root.querySelectorAll("img.lr-lazy")
    if (!imgs.length) return
    if (!("IntersectionObserver" in window)) {
      imgs.forEach(function (img) {
        if (img.dataset.src) img.src = img.dataset.src
      })
      return
    }
    if (!lazyObserver) {
      lazyObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              var img = entry.target
              if (img.dataset.src) {
                img.src = img.dataset.src
                img.removeAttribute("data-src")
              }
              lazyObserver.unobserve(img)
            }
          })
        },
        { rootMargin: "200px" },
      )
    }
    imgs.forEach(function (img) {
      lazyObserver.observe(img)
    })
  }
  window.lrInitLazyLoad = initLazyImages

  function applyFilters() {
    var searchEl = document.getElementById("lr-search")
    var q = ((searchEl && searchEl.value) || "").trim().toLowerCase()
    var genreEl = document.getElementById("lr-genre-filter")
    var genre = genreEl ? genreEl.value.toLowerCase() : ""
    var container = document.getElementById("lr-tab-" + activeTab)
    if (!container) return
    container.querySelectorAll(".lr-card").forEach(function (el) {
      var text = el.getAttribute("data-search") || ""
      var elGenre = el.getAttribute("data-genre") || ""
      var matchQ = !q || text.indexOf(q) !== -1
      var matchGenre = !genre || elGenre.indexOf(genre) !== -1
      el.style.display = matchQ && matchGenre ? "" : "none"
    })
    updateActiveTabBadgeFromVisible()
  }

  var _lrMatchTimer = null
  document.addEventListener("input", function (e) {
    var input = e.target
    if (input.id !== "lr-match-search") return
    var itemId = input.dataset.itemId
    var q = input.value.trim()
    clearTimeout(_lrMatchTimer)
    var resultsEl = document.getElementById("lr-match-results")
    if (!q) {
      if (resultsEl) resultsEl.innerHTML = ""
      return
    }
    _lrMatchTimer = setTimeout(function () {
      if (resultsEl)
        resultsEl.innerHTML = '<div class="text-dim" style="font-size:.8rem;padding:.25rem 0">Searching…</div>'
      fetch("/library-paths/item/" + itemId + "/search-tmdb?q=" + encodeURIComponent(q))
        .then(function (r) {
          return r.json()
        })
        .then(function (data) {
          if (!resultsEl) return
          if (!data || !data.items || data.items.length === 0) {
            resultsEl.innerHTML = '<div class="text-dim" style="font-size:.8rem;padding:.25rem 0">No results.</div>'
            return
          }
          resultsEl.innerHTML = ""
          var grid = document.createElement("div")
          grid.className = "lp-candidate-grid"
          data.items.slice(0, 8).forEach(function (ti) {
            var year = ti.releaseDate && ti.releaseDate.length >= 4 ? ti.releaseDate.substring(0, 4) : "year unknown"
            var btn = document.createElement("button")
            btn.type = "button"
            btn.className = "btn btn-secondary lr-select-tmdb-btn"
            btn.dataset.itemId = itemId
            btn.dataset.tmdbItem = JSON.stringify(ti)
            btn.style.cssText =
              "display:flex;flex-direction:row;align-items:center;gap:.75rem;padding:.6rem .75rem;height:auto;width:100%;text-align:left"
            var ph =
              SHOW_POSTERS && ti.posterUrl
                ? '<img src="' +
                  escHtml(ti.posterUrl) +
                  '" alt="Poster" style="width:54px;height:81px;object-fit:cover;border-radius:4px;flex-shrink:0" onerror="this.style.display=\'none\'">'
                : '<div style="width:54px;height:81px;background:var(--surface-2);border-radius:4px;display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="fa-solid fa-film" style="font-size:1.4rem;color:var(--text-dim)"></i></div>'
            btn.innerHTML =
              ph +
              '<span style="font-size:.88rem;line-height:1.35;word-break:break-word;min-width:0"><strong>' +
              escHtml(ti.name || "Unknown") +
              '</strong><br><span class="text-dim" style="font-size:.8rem">(' +
              escHtml(year) +
              ")</span>" +
              (ti.genres
                ? '<br><span class="text-dim" style="font-size:.75rem">' + escHtml(ti.genres) + "</span>"
                : "") +
              "</span>"
            grid.appendChild(btn)
          })
          resultsEl.appendChild(grid)
        })
        .catch(function () {
          if (resultsEl)
            resultsEl.innerHTML = '<div class="text-dim" style="font-size:.8rem;padding:.25rem 0">Search failed.</div>'
        })
    }, 300)
  })


  function missingLangsHtml(item) {
    var html = '<div class="lr-missing-langs">'
    for (var i = 0; i < item.missingTargetLangIds.length; i++) {
      var langId = item.missingTargetLangIds[i]
      var lang = langById(langId)
      if (!lang) continue
      html +=
        '<button type="button" class="btn btn-secondary lr-add-missing-lang-btn"' +
        ' data-item-id="' +
        escAttr(item.itemId) +
        '"' +
        ' data-lang-id="' +
        escAttr(langId) +
        '"' +
        ' title="Add ' +
        escAttr(lang.name) +
        ' to existing subtitle">' +
        (lang.flagCode ? '<span class="fi fi-' + escAttr(lang.flagCode) + '"></span> ' : "") +
        escHtml(lang.iso639) +
        "</button>"
    }
    html += "</div>"
    return html
  }

  function isTargetLangIso(iso) {
    if (!iso) return false
    var wanted = String(iso).toLowerCase()
    var ids = window.LR_USER_TARGET_LANG_IDS || []
    for (var i = 0; i < ids.length; i++) {
      var lang = langById(ids[i])
      if (lang && lang.iso639 && lang.iso639.toLowerCase() === wanted) return true
    }
    return false
  }

  function fetchSources(itemId) {
    return fetch("/library-requests/item/" + itemId + "/subtitle-sources")
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        return data && data.success && data.sources ? data.sources : []
      })
      .catch(function () {
        return []
      })
  }

  function lrGuessLangFromName(name) {
    if (!name) return ""
    var base = String(name).replace(/\.(srt|ass|ssa|vtt|sub)$/i, "")
    var m = base.match(/\.([a-z]{2,3})$/i)
    return m ? m[1].toLowerCase() : ""
  }

  function translateItem(itemId, sourceChoice) {
    if (sourceChoice && sourceChoice.language && isTargetLangIso(sourceChoice.language)) {
      return Promise.resolve({ success: false, msg: "Source language is one of your target languages", skipped: true })
    }
    var body =
      "__RequestVerificationToken=" + encodeURIComponent(csrfToken())
    if (sourceChoice) {
      body +=
        "&sourceType=" +
        encodeURIComponent(sourceChoice.type || "") +
        "&sourcePath=" +
        encodeURIComponent(sourceChoice.path || "") +
        "&sourceLanguage=" +
        encodeURIComponent(sourceChoice.language || "") +
        "&sourceCodec=" +
        encodeURIComponent(sourceChoice.codec || "") +
        "&sourceTrackId=" +
        encodeURIComponent(sourceChoice.trackId != null ? sourceChoice.trackId : "")
      if (sourceChoice.imageBased) body += "&imageBased=1"
      if (sourceChoice.ocrLang) body += "&ocrLang=" + encodeURIComponent(sourceChoice.ocrLang)
      if (sourceChoice.fps) body += "&fps=" + encodeURIComponent(sourceChoice.fps)
    }
    return fetch("/library-paths/item/" + itemId + "/translate?json=1", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body,
    })
      .then(function (r) {
        if (redirectIfUnauthorized(r)) return null
        return r.json()
      })
  }

  function postCreateWhisper(itemId, btn) {
    if (btn) btn.disabled = true
    return fetch("/library-requests/item/" + itemId + "/create-whisper-subtitle", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "__RequestVerificationToken=" + encodeURIComponent(csrfToken()),
    })
      .then(function (r) {
        if (redirectIfUnauthorized(r)) return null
        return r.json()
      })
      .then(function (data) {
        if (!data) return data
        showToast(data.msg || (data.success ? "Queued" : "Failed"), data.success ? "success" : "error")
        if (data.success) refreshActiveTab()
        return data
      })
      .catch(function () {
        showToast("Request failed", "error")
        return null
      })
      .finally(function () {
        if (btn) btn.disabled = false
      })
  }

  function openExtrasPicker(btn) {
    var targets
    try {
      targets = JSON.parse(btn.dataset.items || "[]")
    } catch (e) {
      targets = []
    }
    var list = document.getElementById("lr-extras-targets")
    if (!list) return
    list.innerHTML = ""
    targets.forEach(function (t) {
      var row = document.createElement("div")
      row.className = "lr-source-pick"
      var html = '<div class="lr-source-row-top"><strong>' + escHtml(t.name || "Item " + t.id) + "</strong></div>"
      if (t.whisperStatus) {
        html +=
          '<span class="' +
          (t.whisperStatus === "transcription_failed" ? "badge badge-error" : "badge badge-processing") +
          '">' +
          escHtml(whisperLabel(t.whisperStatus)) +
          "</span>"
        row.classList.add("lr-source-disabled")
      } else {
        html +=
          '<button type="button" class="btn btn-primary lr-extras-create-btn" data-item-id="' +
          escAttr(String(t.id)) +
          '">Create Subtitles</button>'
      }
      row.innerHTML = html
      list.appendChild(row)
    })
    openModal("lr-extras-picker")
  }

  function lrLoadEpisodeSources(panel) {
    var rows = Array.prototype.slice.call(panel.querySelectorAll(".lr-episode-row"))
    return Promise.all(
      rows.map(function (row) {
        if (row._lrSourcesLoaded) return Promise.resolve()
        var translateBtn = row.querySelector(".lr-translate-btn")
        if (!translateBtn) {
          row._lrSourcesLoaded = true
          return Promise.resolve()
        }
        var itemId = row.dataset.itemId
        return fetchSources(itemId).then(function (sources) {
          sources.forEach(function (s) {
            s.language = s.language || lrGuessLangFromName(s.filename || s.label || row.dataset.filename || "")
          })
          row._lrSources = sources
          row._lrSourcesLoaded = true
          if (sources.length === 0) {
            var b = row.querySelector(".lr-translate-btn")
            if (b) b.remove()
          }
        })
      }),
    )
  }

  function lrEpBadge(row) {
    var b = row.querySelector(".lr-episode-badge")
    return b ? (b.textContent || "").trim() : row.dataset.filename || ""
  }

  function handleTranslateClick(btn) {
    var itemId = btn.dataset.itemId
    var guessedLang = lrGuessLangFromName(btn.dataset.filename || "")
    var defaultChoice = guessedLang ? { language: guessedLang } : null
    var epRow = btn.closest(".lr-episode-row")
    if (epRow && epRow._lrSourcesLoaded) {
      var loaded = epRow._lrSources || []
      if (loaded.length === 0) {
        translateItem(itemId, defaultChoice).then(function (r) {
          onTranslateResponse(btn, r)
        })
        return
      }
      if (loaded.length === 1) {
        var one = loaded[0]
        if (!one.language && guessedLang) one.language = guessedLang
        translateItem(itemId, one).then(function (r) {
          onTranslateResponse(btn, r)
        })
        return
      }
      openSourceDialog(itemId, loaded, btn, guessedLang)
      return
    }
    fetchSources(itemId).then(function (sources) {
      if (sources.length === 0) {
        translateItem(itemId, defaultChoice).then(function (r) {
          onTranslateResponse(btn, r)
        })
        return
      }
      if (sources.length === 1) {
        var only = sources[0]
        if (!only.language && guessedLang) only.language = guessedLang
        translateItem(itemId, only).then(function (r) {
          onTranslateResponse(btn, r)
        })
        return
      }
      openSourceDialog(itemId, sources, btn, guessedLang)
    })
  }

  function setSourceUseButtonLoading(btn) {
    if (!btn || btn._lrLoading) return
    btn._lrLoading = true
    btn._lrOriginalHtml = btn.innerHTML
    btn.disabled = true
    btn.innerHTML = '<span class="lr-btn-spinner" aria-hidden="true"></span> Translating…'
    var list = document.getElementById("subtitle-source-list")
    if (list) {
      Array.prototype.forEach.call(list.querySelectorAll(".lr-source-use, .lr-source-pick"), function (b) {
        if (b !== btn) b.disabled = true
      })
    }
  }

  function restoreSourceUseButton(btn) {
    if (!btn) return
    if (btn._lrOriginalHtml != null) btn.innerHTML = btn._lrOriginalHtml
    btn._lrLoading = false
    delete btn._lrOriginalHtml
    btn.disabled = false
    var list = document.getElementById("subtitle-source-list")
    if (list) {
      Array.prototype.forEach.call(list.querySelectorAll(".lr-source-use, .lr-source-pick"), function (b) {
        b.disabled = false
      })
    }
  }

  function lrSourceRowHighlight(s) {
    var t = ((s && s.title) || "").toLowerCase()
    if (/dialogue|dialog/.test(t)) return "lr-source-dialogue"
    if (/sign|song/.test(t)) return "lr-source-signs"
    return ""
  }

  function lrChoiceFromRow(row) {
    var entry = row._lrEntry
    var srcLang = row._lrSrcLang
    var s = entry.source
    var choice
    if (s) {
      choice = {
        type: s.type,
        path: s.path,
        language: srcLang,
        codec: s.codec,
        trackId: s.trackId != null ? s.trackId : null,
        ocrLang: s.requiresOcr ? s.ocrLang || "eng" : null,
        imageBased: !!s.imageBased,
      }
    } else {
      choice = srcLang ? { language: srcLang } : null
    }
    var fpsInput = row.querySelector(".lr-fps-input")
    if (fpsInput && fpsInput.value) {
      choice = choice || {}
      choice.fps = parseFloat(fpsInput.value)
    }
    return choice
  }

  function lrRenderSourcePicker(entries, btn, guessedLang) {
    var list = document.getElementById("subtitle-source-list")
    list.innerHTML = ""

    entries.forEach(function (entry) {
      var s = entry.source
      var srcLang = entry.lang || (s && (s.language || lrGuessLangFromName(s.filename || s.label))) || guessedLang || ""
      var row = document.createElement("div")
      row.className = "lr-source-pick"
      var hl = lrSourceRowHighlight(s)
      if (hl) row.classList.add(hl)
      row._lrEntry = entry
      row._lrSrcLang = srcLang

      var typeLabel = s ? (s.type === "embedded" ? "Embedded" : "External") : "Subtitle file"
      var langLabel = srcLang ? srcLang.toUpperCase() : "unknown"
      var titlePart = s && s.title ? " · " + escHtml(s.title) : s && s.codec ? " · " + escHtml(s.codec) : ""
      var header = "<strong>" + escHtml(typeLabel + " · " + langLabel) + titlePart + "</strong>"
      if (s && s.imageBased) {
        header +=
          ' <span style="margin-right: 0.5rem; margin-left: 0.5rem;" class="badge badge-warning">Image-based</span>'
      }
      if (s && s.imageBased && s.pictureCount != null) {
        header +=
          ' <span class="badge badge-neutral lr-picture-count">' + escHtml(String(s.pictureCount) + " pictures") + "</span>"
      }

      var detail = ""
      if (entry.fileName) detail = entry.fileName
      else if (s && s.title && s.codec) detail = s.codec
      else if (s && s.filename) detail = s.filename
      else if (s && s.label) detail = s.label

      var html = '<div class="lr-source-row-top">'
      html += header + "</div>"
      if (detail) html += '<span class="text-dim lr-source-detail">' + escHtml(detail) + "</span>"

      if (s && s.unsupported) {
        html += '<span class="text-dim lr-source-note">Unsupported subtitle format</span>'
        row.innerHTML = html
        row.classList.add("lr-source-disabled")
        list.appendChild(row)
        return
      }

      if (s && s.subKind === "text" && s.codec === ".sub") {
        html +=
          '<label class="lr-source-control"><span>FPS</span>' +
          '<input type="number" step="0.001" min="1" max="120" class="lr-fps-input" placeholder="auto"></label>'
      }

      html += '<button type="button" class="btn btn-primary lr-source-use">Translate</button>'

      var skipSource = isTargetLangIso(srcLang)
      if (skipSource) {
        html += '<span class="text-dim lr-source-note">Already a target language</span>'
      }
      row.innerHTML = html

      var useBtn = row.querySelector(".lr-source-use")
      if (skipSource) {
        useBtn.disabled = true
        useBtn.classList.add("lr-source-disabled-btn")
      } else {
        useBtn.addEventListener("click", function () {
          var choice = lrChoiceFromRow(row)
          setSourceUseButtonLoading(useBtn)
          translateItem(entry.itemId, choice)
            .then(function (resp) {
              closeModal("subtitle-source-modal")
              onTranslateResponse(btn, resp)
            })
            .catch(function () {
              restoreSourceUseButton(useBtn)
              showToast("Request failed", "error")
            })
        })
      }

      list.appendChild(row)
    })

    openModal("subtitle-source-modal")
  }

  function openSourceDialog(itemId, sources, btn, guessedLang) {
    var entries = sources.map(function (s) {
      return { itemId: itemId, source: s }
    })
    lrRenderSourcePicker(entries, btn, guessedLang)
  }

  function lrTranslateMovie(btn) {
    var items
    try {
      items = JSON.parse(btn.dataset.items || "[]")
    } catch (e) {
      items = []
    }
    if (items.length === 0) return
    btn.disabled = true
    Promise.all(
      items.map(function (it) {
        return fetchSources(it.id).then(function (srcs) {
          if (srcs.length === 0)
            return [{ itemId: it.id, fileName: it.name, source: null, lang: lrGuessLangFromName(it.name) }]
          return srcs.map(function (s) {
            return {
              itemId: it.id,
              fileName: it.name,
              source: s,
              lang: s.language || lrGuessLangFromName(s.filename || s.label || it.name),
            }
          })
        })
      }),
    )
      .then(function (lists) {
        btn.disabled = false
        var opts = Array.prototype.concat.apply([], lists)
        if (opts.length === 0) return
        if (opts.length === 1) {
          lrDoMovieTranslate(opts[0], btn)
          return
        }
        lrShowMovieSourcePopup(opts, btn, items.length > 1)
      })
      .catch(function () {
        btn.disabled = false
        showToast("Request failed", "error")
      })
  }

  function lrDoMovieTranslate(opt, btn) {
    var choice = opt.source
      ? {
          type: opt.source.type,
          path: opt.source.path,
          language: opt.source.language || opt.lang || "",
          codec: opt.source.codec,
          trackId: opt.source.trackId != null ? opt.source.trackId : null,
          ocrLang: opt.source.requiresOcr ? opt.source.ocrLang || "eng" : null,
          imageBased: !!opt.source.imageBased,
        }
      : opt.lang
        ? { language: opt.lang }
        : null
    return translateItem(opt.itemId, choice).then(function (resp) {
      if (!resp) return
      showToast(resp.msg || (resp.success ? "Queued" : "Failed"), resp.success ? "success" : "error")
      if (resp.success) refreshActiveTab()
    })
  }

  function lrShowMovieSourcePopup(opts, btn, showFile) {
    var entries = opts.map(function (opt) {
      return {
        itemId: opt.itemId,
        source: opt.source,
        fileName: showFile ? opt.fileName : null,
        lang: opt.lang,
      }
    })
    lrRenderSourcePicker(entries, btn, null)
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

  var seasonEps = []
  window.lrTranslateSeason = function lrTranslateSeason(seasonBtn) {
    var sk = seasonBtn.dataset.season
    var list = seasonBtn.closest(".lr-season-list")
    var panel = list && list.querySelector('.lr-season-panel[data-season-key="' + sk + '"]')
    if (!panel) {
      var row = list && list.querySelector('.lr-season-row[data-season-key="' + sk + '"]')
      if (row) openSeason(row)
      panel = list && list.querySelector('.lr-season-panel[data-season-key="' + sk + '"]')
    }
    if (!panel) return
    var rows = Array.prototype.slice
      .call(panel.querySelectorAll(".lr-episode-row"))
      .filter(function (r) {
        return !r.querySelector(".lr-add-missing-lang-btn") && r.querySelector(".lr-translate-btn")
      })
    document.getElementById("season-translate-list").innerHTML = '<p class="text-dim">Loading…</p>'
    openModal("season-translate-modal")
    Promise.all(
      rows.map(function (row) {
        var itemId = row.dataset.itemId
        var build = function (srcs) {
          srcs.forEach(function (s) {
            s.language = s.language || lrGuessLangFromName(s.filename || s.label || row.dataset.filename || "")
          })
          return { itemId: itemId, fileName: row.dataset.filename || "", badge: lrEpBadge(row), sources: srcs }
        }
        if (row._lrSourcesLoaded) return Promise.resolve(build(row._lrSources || []))
        return fetchSources(itemId).then(build)
      }),
    ).then(renderSeasonTranslateList)
  }

  function renderSeasonTranslateList(eps) {
    seasonEps = eps
    var container = document.getElementById("season-translate-list")
    container.innerHTML = ""
    if (eps.length === 0) {
      container.innerHTML = '<p class="text-dim">No episodes to translate.</p>'
      return
    }
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
        note.textContent = "No subtitle tracks — Whisper can create one"
        rowEl.appendChild(note)
        ep._sel = null
      } else {
        var sel = document.createElement("select")
        sel.className = "season-tr-select"
        ep.sources.forEach(function (s, i) {
          var opt = document.createElement("option")
          opt.value = String(i)
          var titlePart = s.title ? " · " + s.title : s.codec ? " · " + s.codec : ""
          var label =
            (s.type === "embedded" ? "Embedded" : "External") +
            " · " +
            ((s.language || "").toUpperCase() || "unknown") +
            titlePart
          if (s.unsupported) label += " · Image-based (unsupported)"
          else if (s.requiresOcr) label += " · Image-based (OCR)"
          opt.textContent = label
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
      var jobs = seasonEps.filter(function (ep) {
        return ep.sources.length > 0 && ep._sel
      })
      if (jobs.length === 0) {
        showToast("No subtitle tracks to translate", "error")
        return
      }
      confirmBtn.disabled = true
      var queued = 0,
        failed = 0
      var chain = Promise.resolve()
      jobs.forEach(function (ep) {
        chain = chain.then(function () {
          var s = ep.sources[parseInt(ep._sel.value, 10)] || ep.sources[0]
          var choice = {
            type: s.type,
            path: s.path,
            language: s.language || "",
            codec: s.codec,
            trackId: s.trackId != null ? s.trackId : null,
            imageBased: !!s.imageBased,
          }
          if (s.requiresOcr && s.ocrLang) choice.ocrLang = s.ocrLang
          return translateItem(ep.itemId, choice)
            .then(function (resp) {
              if (resp && resp.success) queued++
              else failed++
            })
            .catch(function () {
              failed++
            })
        })
      })
      chain.then(function () {
        confirmBtn.disabled = false
        closeModal("season-translate-modal")
        showToast(
          "Queued " + queued + " episode(s)" + (failed ? ", " + failed + " failed" : ""),
          failed && !queued ? "error" : "success",
        )
        if (queued) refreshActiveTab()
      })
    })
  }

  document.addEventListener("click", function (e) {
    var row = e.target.closest(".lr-season-row")
    if (row) {
      openSeason(row)
      return
    }
    var back = e.target.closest(".lr-season-back")
    if (back) {
      var list = back.closest(".lr-season-list")
      if (list) closeSeason(list)
      return
    }

    var groupBtn = e.target.closest(".lr-translate-group-btn")
    if (groupBtn) {
      lrTranslateMovie(groupBtn)
      return
    }

    var createBtn = e.target.closest(".lr-create-subtitle-btn")
    if (createBtn) {
      postCreateWhisper(createBtn.dataset.itemId, createBtn)
      return
    }
    var extrasPickBtn = e.target.closest(".lr-extras-pick")
    if (extrasPickBtn) {
      openExtrasPicker(extrasPickBtn)
      return
    }
    var extrasCreateBtn = e.target.closest(".lr-extras-create-btn")
    if (extrasCreateBtn) {
      postCreateWhisper(extrasCreateBtn.dataset.itemId, extrasCreateBtn).then(function (data) {
        if (data && data.success) closeModal("lr-extras-picker")
      })
      return
    }

    var tBtn = e.target.closest(".lr-translate-btn")
    if (tBtn) {
      handleTranslateClick(tBtn)
      return
    }

    var missingBtn = e.target.closest(".lr-add-missing-lang-btn")
    if (missingBtn) {
      var mlangItemId = missingBtn.dataset.itemId
      var mlangId = missingBtn.dataset.langId
      fetch("/library-requests/item/" + mlangItemId + "/add-missing-lang?json=1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:
          "targetLangIds=" +
          encodeURIComponent(mlangId) +
          "&__RequestVerificationToken=" +
          encodeURIComponent(csrfToken()),
      })
        .then(function (r) {
          if (redirectIfUnauthorized(r)) return null
          return r.json()
        })
        .then(function (data) {
          if (!data) return
          if (data.success) {
            missingBtn.style.display = "none"
            showToast(data.msg || "Added", "success")
            refreshActiveTab()
          } else showToast(data.msg || "Failed", "error")
        })
        .catch(function () {
          showToast("Request failed", "error")
        })
      return
    }

    var matchBtn = e.target.closest(".lr-change-match-btn")
    if (matchBtn) {
      var mItemId = matchBtn.dataset.itemId
      document.getElementById("lr-match-name").textContent = matchBtn.dataset.itemName || ""
      var mSearch = document.getElementById("lr-match-search")
      mSearch.dataset.itemId = mItemId
      mSearch.value = ""
      document.getElementById("lr-match-results").innerHTML = ""
      openModal("lr-match-modal")
      setTimeout(function () {
        mSearch.focus()
      }, 50)
      return
    }

    var tmdbBtn = e.target.closest(".lr-select-tmdb-btn")
    if (tmdbBtn) {
      var ti = JSON.parse(tmdbBtn.dataset.tmdbItem || "{}")
      var tItemId = tmdbBtn.dataset.itemId
      var tyear = ti.releaseDate ? ti.releaseDate.substring(0, 4) : ""
      var tBody = [
        "title=" + encodeURIComponent(ti.name || ""),
        "originalTitle=" + encodeURIComponent(ti.originalTitle || ""),
        "year=" + encodeURIComponent(tyear),
        "isAnime=" + encodeURIComponent(ti.isAnime ? "1" : "0"),
        "genres=" + encodeURIComponent(ti.genres || ""),
        "theMovieDbId=" + encodeURIComponent(String(ti.id || "")),
        "posterUrl=" + encodeURIComponent(ti.posterUrl || ""),
        "__RequestVerificationToken=" + encodeURIComponent(csrfToken()),
      ].join("&")
      fetch("/library-paths/item/" + tItemId + "/select-tmdb-result?json=1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tBody,
      })
        .then(function (r) {
          if (redirectIfUnauthorized(r)) return null
          return r.json()
        })
        .then(function (data) {
          if (!data) return
          showToast(data.msg || (data.success ? "Matched" : "Failed"), data.success ? "success" : "error")
          if (data.success) {
            closeModal("lr-match-modal")
            refreshActiveTab()
          }
        })
        .catch(function () {
          showToast("Request failed", "error")
        })
      return
    }

    if (e.target.closest("[data-toast-close]")) {
      var t = e.target.closest(".toast")
      if (t) t.remove()
    }
  })

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
    connectRequestsHub()
  }

  function applyPushedCounts(counts) {
    if (!counts) return
    var types = ["movie", "series", "unmatched"]
    for (var i = 0; i < types.length; i++) {
      var t = types[i]
      if (S(t).loaded) continue
      var el = document.querySelector('.lr-tab-count[data-tab="' + t + '"]')
      if (!el) continue
      var n = counts[t] || 0
      el.textContent = String(n)
      el.style.display = n > 0 ? "" : "none"
    }
  }

  function connectRequestsHub() {
    if (typeof signalR === "undefined") return
    try {
      var conn = new signalR.HubConnectionBuilder()
        .withUrl("/hubs/library")
        .withAutomaticReconnect()
        .build()
      conn.on("libraryRequestsChanged", applyPushedCounts)
      conn.onreconnected(function () {
        preloadTabCounts()
      })
      conn.start().catch(function () {})
    } catch (e) {
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot)
  } else {
    boot()
  }
})()