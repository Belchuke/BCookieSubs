;(function () {
  var PERMS = window.LP_PERMS || {}
  var SHOW_POSTERS = window.LP_SHOW_POSTERS
  var ROOT_PATH = window.LP_ROOT_PATH

  var STATE_CLASSES = { scanning: "badge-warning", error: "badge-error" }
  var STATUS_CLASSES = { completed: "badge-success", failed: "badge-error", queued: "badge-warning" }
  var ALL_BADGE_CLASSES = ["badge-success", "badge-error", "badge-warning", "badge-neutral"]

  function newTypeState() {
    return {
      paths: [],
      pathItemIds: {},
      itemStatus: {},
      knownIds: new Set(),
      groupItems: {},
      groupLp: {},
      renderedGroups: new Set(),
    }
  }
  var _loadedTabs = { movie: false, series: false, blacklist: false }
  var _state = { movie: newTypeState(), series: newTypeState() }
  var _activeTab = "movie"

  function S(type) {
    return _state[type] || (_state[type] = newTypeState())
  }
  function activeState() {
    return S(_activeTab)
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

  function csrfField() {
    return '<input type="hidden" name="__RequestVerificationToken" value="' + escAttr(csrfToken()) + '">'
  }

  function showLpToast(kind, msg) {
    var existing = document.getElementById("page-toast")
    if (existing) existing.remove()
    var div = document.createElement("div")
    div.id = "page-toast"
    div.className = "toast toast-" + kind
    div.innerHTML =
      '<span class="toast-msg">' +
      escHtml(String(msg || "")) +
      '</span><button type="button" class="toast-close" aria-label="Close" data-toast-close>✕</button>'
    var main = document.querySelector(".main-content")
    if (main) main.prepend(div)
    else document.body.prepend(div)
    setTimeout(function () {
      if (div.parentNode) div.remove()
    }, 4000)
  }

  function setBadge(el, text, colorClass) {
    ALL_BADGE_CLASSES.forEach(function (c) {
      el.classList.remove(c)
    })
    el.classList.add(colorClass)
    el.textContent = text
  }

  function pad2(n) {
    return String(n).padStart(2, "0")
  }

  function fmtMs(ms) {
    if (ms == null || typeof ms !== "number" || !isFinite(ms) || ms < 0) return null
    var totalSec = Math.round(ms / 1000)
    if (totalSec < 60) return totalSec + "s"
    var m = Math.floor(totalSec / 60)
    var rs = totalSec % 60
    if (m < 60) return rs ? m + "m " + rs + "s" : m + "m"
    var h = Math.floor(m / 60)
    var rm = m % 60
    return rm ? h + "h " + rm + "m" : h + "h"
  }

  function getAccordionState() {
    try {
      return JSON.parse(localStorage.getItem("lp-accordion-v1") || "{}")
    } catch {
      return {}
    }
  }

  function saveAccordionOpen(key, isOpen) {
    var s = getAccordionState()
    s[key] = isOpen
    localStorage.setItem("lp-accordion-v1", JSON.stringify(s))
  }

  function itemRowHtml(item, lp) {
    var si = item.subtitleInfo
    var translationDeleted = si && (si.deleted || si.jobs.length === 0)
    var activeJobs = si && !si.deleted ? si.jobs : []
    var hasRunning = activeJobs.some(function (j) {
      return j.jobStatus === "running"
    })
    var hasFailed = activeJobs.some(function (j) {
      return j.jobStatus === "failed"
    })
    var jobLabel = hasRunning ? "Translating" : hasFailed ? "Failed" : "Queued"
    var langList = activeJobs
      .map(function (j) {
        return (j.langFlag ? j.langFlag + " " : "") + (j.langIso || "").toUpperCase()
      })
      .join(", ")

    var isSeries = lp.type === "series"
    var fileName = item.path.split("/").pop()
    var statusCls = STATUS_CLASSES[item.status] || "badge-neutral"
    var statusText = String(item.status).replace(/_/g, " ")

    var se = ""
    if (isSeries && item.season != null && item.episode != null) {
      se = '<span class="lpx-se-label">S' + pad2(item.season) + "E" + pad2(item.episode) + "</span>"
    }

    var isUnmatchedItem = !item.mediaItemId || !(item.mediaItem && item.mediaItem.theMovieDbId)
    var itemCb = ""
    if (isUnmatchedItem) {
      itemCb =
        '<input type="checkbox" class="lp-item-cb" data-item-id="' +
        item.id +
        '" data-lp-type="' +
        escAttr(lp.type) +
        '" title="Select for bulk re-match">'
    }

    var badges =
      '<span class="badge ' +
      statusCls +
      ' lpx-fs-70" data-item-status="' +
      item.id +
      '">' +
      escHtml(statusText) +
      "</span>"
    if (translationDeleted) {
      badges += '<span class="badge badge-error lpx-fs-70">Translation deleted</span>'
    } else if (activeJobs.length > 0) {
      badges += '<span class="text-dim lpx-fs-75">' + escHtml(jobLabel) + " · " + escHtml(langList) + "</span>"
    }

    var actions = ""
    if (item.blacklist) {
      actions +=
        '<span class="badge badge-warning lpx-fs-70" title="' +
        escAttr(item.blacklist.reason || "") +
        '">Blacklisted</span>'
      if (PERMS.canBlackListALibraryPathItem) {
        actions +=
          '<form method="POST" action="/library-paths/item/' +
          item.id +
          '/unblacklist" class="lpx-inline">' +
          csrfField() +
          '<button type="submit" class="btn btn-sm btn-secondary">Remove from blacklist</button></form>'
      }
    } else {
      if (PERMS.canChangeMatchForLibraryPaths) {
        actions +=
          '<button type="button" class="btn btn-sm btn-secondary lp-item-match-btn" data-item-id="' +
          item.id +
          '" data-type="' +
          escAttr(lp.type) +
          '" data-item-name="' +
          escAttr(fileName) +
          '">Change match</button>'
      }
      if (translationDeleted && PERMS.canAddSubtitleToTranslateFromLibrary) {
        actions +=
          '<form method="POST" action="/library-paths/item/' +
          item.id +
          '/readd" class="lpx-inline">' +
          csrfField() +
          '<button type="submit" class="btn btn-sm btn-secondary">Re-add</button></form>'
      }
      if (!isUnmatchedItem && PERMS.canBlackListALibraryPathItem) {
        actions +=
          '<button type="button" class="btn btn-sm btn-secondary lp-blacklist-btn" data-item-id="' +
          item.id +
          '" data-item-name="' +
          escAttr(fileName) +
          '" title="Block this item from translation">Blacklist</button>'
      }
    }

    var pathLine = isUnmatchedItem
      ? '<div class="text-dim lpx-fs-72 lpx-item-path" title="' +
        escAttr(item.path) +
        '">' +
        escHtml(item.path) +
        "</div>"
      : ""

    return (
      '<div data-item-row="' +
      item.id +
      '" class="lpx-item-row"><div class="lpx-item-main"><div class="lpx-row-center">' +
      itemCb +
      se +
      '<span class="lpx-filename" title="' +
      escAttr(item.path) +
      '">' +
      escHtml(fileName) +
      '</span></div>' +
      pathLine +
      '<div class="lpx-badge-row">' +
      badges +
      '</div></div><div class="lpx-item-actions">' +
      actions +
      "</div></div>"
    )
  }

  function renderGroupRows(groupKey, type) {
    var st = S(type)
    var items = st.groupItems[groupKey] || []
    var visible = items.filter(function (i) {
      return !i.blacklist
    })
    var lp = st.groupLp[groupKey]
    var frag = document.createDocumentFragment()
    var col = document.createElement("div")
    col.className = "lpx-col"
    visible.forEach(function (item) {
      col.insertAdjacentHTML("beforeend", itemRowHtml(item, lp))
    })
    frag.appendChild(col)
    return frag
  }

  function groupHtml(lp, group, groupIdx, type) {
    var visibleItems = group.items.filter(function (i) {
      return !i.blacklist
    })
    if (visibleItems.length === 0) return ""

    var allItemIds = group.items.map(function (i) {
      return i.id
    })
    var blacklistableIds = group.items
      .filter(function (i) {
        return !i.blacklist
      })
      .map(function (i) {
        return i.id
      })
    var firstItemId = group.items.length > 0 ? group.items[0].id : null
    var groupCandidates = group.items.length > 0 && group.items[0].candidates ? group.items[0].candidates : []
    var groupKey = "g" + lp.id + "-" + (group.mediaItemId != null ? group.mediaItemId : "u" + groupIdx)
    var isSeries = lp.type === "series"
    var lpRootNorm = lp.path.endsWith("/") ? lp.path : lp.path + "/"
    var firstItemPath = group.items.length > 0 ? group.items[0].path : ""
    var relFirst = firstItemPath.startsWith(lpRootNorm)
      ? firstItemPath.slice(lpRootNorm.length)
      : firstItemPath.replace(/^\//, "")
    var relParts = relFirst.split("/")
    var groupFolderName = relParts.length > 1 ? relParts[0] + "/" : ""

    var st = S(type)
    st.groupItems[groupKey] = group.items
    st.groupLp[groupKey] = lp

    var searchText = (
      (group.mediaItem ? group.mediaItem.title + " " + (group.mediaItem.year || "") : "unmatched") +
      " " +
      visibleItems
        .map(function (i) {
          return i.path.split("/").pop()
        })
        .join(" ")
    ).toLowerCase()
    var genre = group.mediaItem && group.mediaItem.genres ? group.mediaItem.genres.toLowerCase() : ""

    var posterHtml
    if (SHOW_POSTERS && group.mediaItem && group.mediaItem.photoPath) {
      posterHtml =
        '<img data-src="/media-photos/' +
        escAttr(group.mediaItem.photoPath) +
        '" alt="Poster" class="lpx-poster-sm lp-lazy-img" loading="lazy" decoding="async">'
    } else {
      posterHtml =
        '<div class="lpx-poster-sm-ph"><i class="fa-solid fa-' +
        (isSeries ? "tv" : "film") +
        ' lpx-text-dim"></i></div>'
    }

    var isUnmatchedGroup = group.mediaItemId == null || !(group.mediaItem && group.mediaItem.theMovieDbId)

    var titleBlock
    if (!isUnmatchedGroup) {
      var year = group.mediaItem.year
        ? ' <span class="text-dim lpx-year">(' + escHtml(group.mediaItem.year) + ")</span>"
        : ""
      titleBlock =
        '<div class="lpx-group-title">' +
        escHtml(group.mediaItem.title) +
        year +
        '</div><div class="text-dim lpx-meta-sm">' +
        (groupFolderName ? '<span class="lpx-text-dim">' + escHtml(groupFolderName) + "</span> &ndash; " : "") +
        visibleItems.length +
        " file" +
        (visibleItems.length !== 1 ? "s" : "") +
        "</div>"
    } else {
      titleBlock =
        '<div class="lpx-unmatched-title">Unmatched</div><div class="text-dim lpx-meta-sm">' +
        (groupFolderName ? '<span class="lpx-text-dim">' + escHtml(groupFolderName) + "</span> &ndash; " : "") +
        visibleItems.length +
        " file" +
        (visibleItems.length !== 1 ? "s" : "") +
        " — no media match yet</div>"
    }

    var actions = ""
    if (PERMS.canChangeMatchForLibraryPaths) {
      var matchGroupName = group.mediaItem ? group.mediaItem.title : groupFolderName
      actions +=
        '<button type="button" class="btn btn-sm btn-secondary lp-group-match-btn" data-group-key="' +
        escAttr(groupKey) +
        '" data-item-ids="' +
        escAttr(JSON.stringify(allItemIds)) +
        '" data-first-item-id="' +
        (firstItemId != null ? firstItemId : "") +
        '" data-type="' +
        escAttr(lp.type) +
        '" data-candidates="' +
        escAttr(JSON.stringify(groupCandidates)) +
        '" data-group-name="' +
        escAttr(matchGroupName) +
        '">Change match</button>'
    }
    if (group.mediaItemId && PERMS.canEditLibraryPath) {
      actions +=
        '<label class="btn btn-sm btn-secondary lpx-photo-label" title="Upload custom poster"><i class="fa-solid fa-image"></i>' +
        '<input type="file" accept="image/*" class="lp-photo-input lpx-file-hidden" data-media-item-id="' +
        group.mediaItemId +
        '"></label>'
    }
    if (!isUnmatchedGroup && PERMS.canBlackListALibraryPathItem && blacklistableIds.length > 0) {
      actions +=
        '<button type="button" class="btn btn-sm btn-danger lp-blacklist-group-btn" data-item-ids="' +
        escAttr(JSON.stringify(blacklistableIds)) +
        '" data-group-name="' +
        escAttr(group.mediaItem ? group.mediaItem.title : "Unmatched group") +
        '" title="Blacklist all items in this group">Blacklist</button>'
    }

    var header =
      '<div class="lpx-group-header">' +
      (!isUnmatchedGroup
        ? '<input type="checkbox" class="lp-group-cb" data-group-key="' +
          escAttr(groupKey) +
          '" data-item-ids="' +
          escAttr(JSON.stringify(allItemIds)) +
          '" data-first-item-id="' +
          (firstItemId != null ? firstItemId : "") +
          '" data-lp-type="' +
          escAttr(lp.type) +
          '" title="Select for bulk action">'
        : "") +
      posterHtml +
      '<div class="lpx-group-info">' +
      titleBlock +
      "</div>" +
      '<div class="lpx-group-actions">' +
      actions +
      "</div>" +
      "</div>"

    var epLabel = isSeries
      ? visibleItems.length + " episode" + (visibleItems.length !== 1 ? "s" : "")
      : visibleItems.length + " translation track" + (visibleItems.length !== 1 ? "s" : "")
    var epOpen = getAccordionState()["ep-" + groupKey] === true ? " open" : ""
    var epDetails =
      '<details class="series-ep-accordion" data-ep-accordion="' +
      escAttr(groupKey) +
      '"' +
      epOpen +
      '><summary class="lpx-ep-summary"><i class="fa-solid fa-chevron-right series-ep-chevron lpx-ep-chevron"></i><span class="text-dim lpx-fs-81">' +
      epLabel +
      "</span></summary></details>"

    return (
      '<div data-lp-group data-search="' +
      escAttr(searchText) +
      '" data-genre="' +
      escAttr(genre) +
      '" class="lpx-group-box">' +
      header +
      epDetails +
      "</div>"
    )
  }

  function pathCardHtml(lp, type) {
    var folderName = lp.path.split("/").filter(Boolean).pop() || lp.path
    var totalFiles = lp.groups.reduce(function (sum, g) {
      return (
        sum +
        g.items.filter(function (i) {
          return !i.blacklist
        }).length
      )
    }, 0)

    var stateCls = lp.state === "scanning" ? "badge-warning" : lp.state === "error" ? "badge-error" : "badge-neutral"
    var enabledBadge = lp.enabled
      ? '<span class="badge badge-success">Enabled</span>'
      : '<span class="badge badge-neutral">Disabled</span>'

    var editData = JSON.stringify({
      id: lp.id,
      name: lp.name,
      path: lp.path,
      type: lp.type,
      sourceLangId: lp.sourceLangId,
      enabled: lp.enabled,
      autoTranslate: lp.autoTranslate,
      autoExtract: lp.autoExtract,
      storage: lp.storage,
      sftpHost: lp.sftpHost,
      sftpPort: lp.sftpPort,
      sftpUsername: lp.sftpUsername,
      sftpAuthMode: lp.sftpAuthMode,
      sftpHostKeyFingerprint: lp.sftpHostKeyFingerprint,
      hasSftpPassword: lp.hasSftpPassword,
      hasSftpPrivateKey: lp.hasSftpPrivateKey,
    })

    var actions =
      '<div class="lpx-actions-row"><i class="fa-solid fa-chevron-down lp-chevron lpx-chevron"></i>' +
      '<button type="button" class="btn btn-sm btn-secondary lp-edit-btn" data-lp="' +
      escAttr(editData) +
      '">Edit</button>' +
      '<form method="POST" action="/library-paths/toggle/' +
      lp.id +
      '" class="lpx-inline" onclick="event.stopPropagation()">' +
      csrfField() +
      '<button type="submit" class="btn btn-sm btn-secondary">' +
      escHtml(lp.enabled ? "Disable" : "Enable") +
      "</button></form>" +
      (PERMS.canEditLibraryPath
        ? '<form method="POST" action="/library-paths/rescan/' +
          lp.id +
          '" class="lpx-inline" onclick="event.stopPropagation()" title="Reset this library and re-run the scanner (use if a scan got stuck)">' +
          csrfField() +
          '<button type="submit" class="btn btn-sm btn-secondary">Rescan</button></form>'
        : "") +
      '<form method="POST" action="/library-paths/delete/' +
      lp.id +
      '" class="lpx-inline" onclick="event.stopPropagation()" onsubmit="return confirm(\'Delete this library path? This will also delete all tracked items.\')">' +
      csrfField() +
      '<button type="submit" class="btn btn-sm btn-danger">Delete</button></form></div>'

    var SEP = '<span class="lpx-meta-sep"> · </span>'
    var sourceMeta =
      "Source: " +
      escHtml(lp.sourceLangName || "Unknown") +
      SEP +
      "AutoTranslate: " +
      (lp.autoTranslate ? "Yes" : "No") +
      SEP +
      "AutoExtract: " +
      (lp.autoExtract ? "Yes" : "No")
    if (lp.lastRunAt) sourceMeta += SEP + "Last scan: " + escHtml(lp.lastRunAt)

    var scanModeLabel = lp.scanMode === "custom" ? "Custom schedule" : lp.scanMode === "never" ? "Never" : "Hourly"
    sourceMeta += SEP + "Scan frequency: " + escHtml(scanModeLabel)
    var scanDurParts = []
    var initDur = fmtMs(lp.initialScanDurationMs)
    var avgDur = lp.postInitialScanCount > 0 ? fmtMs(lp.postInitialScanTotalMs / lp.postInitialScanCount) : null
    var lastDur = fmtMs(lp.lastScanDurationMs)
    if (initDur) scanDurParts.push("Initial: " + initDur)
    if (avgDur) scanDurParts.push("Average: " + avgDur)
    if (lastDur) scanDurParts.push("Last: " + lastDur)
    if (scanDurParts.length) sourceMeta += SEP + scanDurParts.join(SEP)

    var cardOpen = getAccordionState()["lp-" + lp.id] === true ? " open" : ""

    var body
    if (lp.groups.length === 0) {
      body = '<p class="text-dim lpx-empty-note">No items found yet. Scanner will discover files on next run.</p>'
    } else {
      var groupHtmls = []
      var idx = 0
      lp.groups.forEach(function (group) {
        var html = groupHtml(lp, group, ++idx, type)
        if (html) groupHtmls.push(html)
      })
      body = '<div class="lpx-groups-wrap">' + groupHtmls.join("") + "</div>"
    }

    return (
      '<details class="card lp-card lpx-card-mb" data-lp-accordion="' +
      lp.id +
      '"' +
      cardOpen +
      '><summary class="card-header lpx-card-summary"><div class="lpx-flex1-min0">' +
      '<div class="lpx-title-row"><h2 class="lpx-m0">' +
      escHtml(lp.name) +
      "</h2>" +
      enabledBadge +
      '<span class="badge badge-neutral">' +
      escHtml(lp.type) +
      '</span>' +
      (lp.storage === "sftp" ? '<span class="badge badge-neutral">SFTP</span>' : "") +
      '<span class="badge ' +
      stateCls +
      '" data-lp-state="' +
      lp.id +
      '">' +
      escHtml(lp.state) +
      "</span></div>" +
      '<div class="text-dim lpx-folder-meta"><strong class="lpx-text">' +
      escHtml(folderName) +
      "</strong>" +
      '<span class="lpx-meta-sep"> · </span>' +
      totalFiles +
      " file" +
      (totalFiles !== 1 ? "s" : "") +
      '</div><div class="text-dim lpx-path-meta">' +
      escHtml(lp.path) +
      '</div><div class="text-dim lpx-source-meta">' +
      sourceMeta +
      "</div></div>" +
      actions +
      "</summary>" +
      body +
      "</details>"
    )
  }

  function blacklistTableHtml(rows) {
    if (!rows || rows.length === 0) {
      return '<p class="empty-state">No blacklisted items.</p>'
    }
    var head =
      '<thead><tr class="lpx-thead-row">' +
      '<th class="lpx-th">Filesystem path</th>' +
      '<th class="lpx-th">Library</th>' +
      '<th class="lpx-th">Match</th>' +
      '<th class="lpx-th">Blacklisted by</th>' +
      '<th class="lpx-th">When</th>' +
      '<th class="lpx-th">Reason</th>' +
      (PERMS.canBlackListALibraryPathItem ? '<th class="lpx-th">Actions</th>' : "") +
      "</tr></thead>"

    var body = ""
    rows.forEach(function (b) {
      var fileName = b.itemPath.split("/").pop()
      var se =
        b.season != null && b.episode != null
          ? '<div class="text-dim lpx-fs-75">S' + pad2(b.season) + "E" + pad2(b.episode) + "</div>"
          : ""
      var match = b.mediaTitle
        ? escHtml(b.mediaTitle) + (b.mediaYear ? ' <span class="text-dim">(' + escHtml(b.mediaYear) + ")</span>" : "")
        : '<span class="text-dim">Unmatched</span>'
      var reason = b.reason ? escHtml(b.reason) : '<span class="text-dim">—</span>'
      var act = ""
      if (PERMS.canBlackListALibraryPathItem) {
        act =
          '<td class="lpx-td-nowrap"><form method="POST" action="/library-paths/item/' +
          b.libraryPathItemId +
          '/unblacklist?from=blacklist" class="lpx-inline">' +
          csrfField() +
          '<button type="submit" class="btn btn-sm btn-secondary">Remove from blacklist</button></form></td>'
      }
      body +=
        '<tr class="lpx-tr-border">' +
        '<td class="lpx-td-path"><div class="lpx-fw600-88">' +
        escHtml(fileName) +
        "</div>" +
        se +
        '<div class="text-dim lpx-fs-72-mt">' +
        escHtml(b.itemPath) +
        '</div></td><td class="lpx-td">' +
        escHtml(b.libraryPathName || "—") +
        '</td><td class="lpx-td">' +
        match +
        '</td><td class="lpx-td">' +
        escHtml(b.blacklistedByUsername || "—") +
        '</td><td class="lpx-td-nowrap">' +
        escHtml(formatLocalTime(b.createdAt)) +
        '</td><td class="lpx-td-reason">' +
        reason +
        "</td>" +
        act +
        "</tr>"
    })

    return (
      '<div class="lpx-overflow-x"><table class="table lpx-table">' + head + "<tbody>" + body + "</tbody></table></div>"
    )
  }

  function tabRoot(type) {
    return document.querySelector("#lp-tab-" + type + " .lp-list-root")
  }

  function activeTabContainer() {
    return document.getElementById("lp-tab-" + _activeTab)
  }

  function afterRender(root, type) {
    type = type || _activeTab
    root.querySelectorAll("details[data-lp-accordion]").forEach(function (el) {
      var key = "lp-" + el.getAttribute("data-lp-accordion")
      if (getAccordionState()[key] === true) el.open = true
      el.addEventListener("toggle", function () {
        saveAccordionOpen(key, el.open)
        if (el.open && window.lpInitLazyLoad) window.lpInitLazyLoad(el)
      })
    })
    root.querySelectorAll("details[data-ep-accordion]").forEach(function (el) {
      var key = el.getAttribute("data-ep-accordion")
      var stateKey = "ep-" + key
      if (getAccordionState()[stateKey] === true) {
        el.open = true
        fillGroupBody(el, key, type)
      }
      el.addEventListener("toggle", function () {
        saveAccordionOpen(stateKey, el.open)
        if (el.open) fillGroupBody(el, key, type)
      })
    })
    root.querySelectorAll("details.lp-card > summary").forEach(function (summary) {
      summary.addEventListener("click", function (e) {
        if (e.target !== summary && e.target.closest("button, a, input, select, form")) {
          e.preventDefault()
        }
      })
    })
    if (window.lpInitLazyLoad) window.lpInitLazyLoad(root)
  }

  function fillGroupBody(detailsEl, groupKey, type) {
    type = type || _activeTab
    var st = S(type)
    if (st.renderedGroups.has(groupKey)) {
      if (window.lpInitLazyLoad) window.lpInitLazyLoad(detailsEl)
      return
    }
    var frag = renderGroupRows(groupKey, type)
    detailsEl.appendChild(frag)
    st.renderedGroups.add(groupKey)
    if (window.lpInitLazyLoad) window.lpInitLazyLoad(detailsEl)
  }

  function loadTab(type) {
    if (type === "blacklist") return loadBlacklist()
    if (_loadedTabs[type]) return Promise.resolve()
    _loadedTabs[type] = true
    return fetch("/library-paths/data?type=" + type)
      .then(function (r) {
        if (redirectIfUnauthorized(r)) return null
        return r.json()
      })
      .then(function (data) {
        if (!data) return
        renderPaths(type, data.paths || [])
      })
      .catch(function () {
        _loadedTabs[type] = false
        showLpToast("error", "Failed to load library")
      })
  }

  function renderPaths(type, paths) {
    var st = S(type)
    st.paths = paths
    var root = tabRoot(type)
    if (!root) return
    if (paths.length === 0) {
      root.innerHTML = '<div class="card"><p class="empty-state">No library paths configured yet.</p></div>'
    } else {
      var html = ""
      paths.forEach(function (lp) {
        html += pathCardHtml(lp, type)
      })
      root.innerHTML = html
    }
    st.pathItemIds = {}
    st.knownIds = new Set()
    st.groupItems = {}
    st.groupLp = {}
    st.renderedGroups = new Set()
    st.itemStatus = {}
    paths.forEach(function (lp) {
      var ids = new Set()
      lp.groups.forEach(function (g, gi) {
        var key = "g" + lp.id + "-" + (g.mediaItemId != null ? g.mediaItemId : "u" + (gi + 1))
        st.groupItems[key] = g.items
        st.groupLp[key] = lp
        g.items.forEach(function (it) {
          ids.add(it.id)
          if (!it.blacklist) {
            st.knownIds.add(String(it.id))
            st.itemStatus[it.id] = it.status
          }
        })
      })
      st.pathItemIds[lp.id] = ids
    })
    afterRender(root, type)
    rebuildGenreFilter(type)
  }

  function loadBlacklist() {
    if (_loadedTabs.blacklist) return Promise.resolve()
    _loadedTabs.blacklist = true
    var root = document.querySelector("#lp-tab-blacklist .lp-blacklist-root")
    return fetch("/library-paths/blacklist-data")
      .then(function (r) {
        if (redirectIfUnauthorized(r)) return null
        return r.json()
      })
      .then(function (data) {
        if (!data) return
        root.innerHTML = blacklistTableHtml(data.blacklisted || [])
      })
      .catch(function () {
        _loadedTabs.blacklist = false
        showLpToast("error", "Failed to load blacklist")
      })
  }

  function rebuildGenreFilter(type) {
    var sel = document.querySelector("#lp-tab-" + type + " .lp-genre-filter")
    if (!sel) return
    var genres = {}
    ;(S(type).paths || []).forEach(function (lp) {
      lp.groups.forEach(function (g) {
        if (g.mediaItem && g.mediaItem.genres) {
          g.mediaItem.genres.split(",").forEach(function (gg) {
            var tr = gg.trim()
            if (tr) genres[tr] = true
          })
        }
      })
    })
    var sorted = Object.keys(genres).sort()
    var current = sel.value
    sel.innerHTML = '<option value="">All genres</option>'
    sorted.forEach(function (g) {
      sel.insertAdjacentHTML("beforeend", '<option value="' + escAttr(g) + '">' + escHtml(g) + "</option>")
    })
    if (current) sel.value = current
  }

  var _filterTimer = null
  function applyFilters() {
    var container = activeTabContainer()
    if (!container) return
    var q = (container.querySelector(".lp-search") || {}).value || ""
    q = q.trim().toLowerCase()
    var genreEl = container.querySelector(".lp-genre-filter")
    var genre = genreEl ? genreEl.value.toLowerCase() : ""
    container.querySelectorAll("[data-lp-group]").forEach(function (el) {
      var text = el.getAttribute("data-search") || ""
      var elGenre = el.getAttribute("data-genre") || ""
      var matchQ = !q || text.indexOf(q) !== -1
      var matchGenre = !genre || elGenre.indexOf(genre) !== -1
      el.style.display = matchQ && matchGenre ? "" : "none"
    })
  }

  function refreshChangedPaths(type) {
    var st = S(type)
    if (!_loadedTabs[type] || type === "blacklist") return
    fetch("/library-paths/data?type=" + type)
      .then(function (r) {
        if (redirectIfUnauthorized(r)) return null
        return r.json()
      })
      .then(function (data) {
        if (!data) return
        var fresh = data.paths || []
        var root = tabRoot(type)
        if (!root) return
        var prevStateById = {}
        ;(st.paths || []).forEach(function (p) { prevStateById[p.id] = p.state })
        var seen = {}
        fresh.forEach(function (lp) {
          seen[lp.id] = true
          var freshIds = new Set()
          lp.groups.forEach(function (g) {
            g.items.forEach(function (it) {
              freshIds.add(it.id)
            })
          })
          var prevIds = st.pathItemIds[lp.id]
          var changed = !prevIds || !setsEqual(prevIds, freshIds) ||
            prevStateById[lp.id] !== lp.state
          if (changed) {
            replacePathCard(root, lp, type)
            st.pathItemIds[lp.id] = freshIds
            lp.groups.forEach(function (g, gi) {
              var key = "g" + lp.id + "-" + (g.mediaItemId != null ? g.mediaItemId : "u" + (gi + 1))
              st.groupItems[key] = g.items
              st.groupLp[key] = lp
              st.renderedGroups.delete(key)
              g.items.forEach(function (it) {
                if (!it.blacklist) {
                  st.knownIds.add(String(it.id))
                  st.itemStatus[it.id] = it.status
                }
              })
            })
          }
        })
        root.querySelectorAll("details[data-lp-accordion]").forEach(function (el) {
          if (!seen[el.getAttribute("data-lp-accordion")]) el.remove()
        })
        st.paths = fresh
        rebuildGenreFilter(type)
        applyFilters()
      })
      .catch(function () {})
  }

  function setsEqual(a, b) {
    if (!a || a.size !== b.size) return false
    var ok = true
    b.forEach(function (v) {
      if (!a.has(v)) ok = false
    })
    return ok
  }

  function replacePathCard(root, lp, type) {
    var existing = root.querySelector('details[data-lp-accordion="' + lp.id + '"]')
    var tmp = document.createElement("div")
    tmp.innerHTML = pathCardHtml(lp, type)
    var card = tmp.firstElementChild
    if (existing) {
      existing.replaceWith(card)
    } else {
      root.appendChild(card)
    }
    afterRender(card, type)
  }

  var _intentionalNavigation = false
  function reloadWithScrollRestore() {
    _intentionalNavigation = true
    sessionStorage.setItem("lp_scroll_pos", String(window.scrollY || 0))
    location.reload()
  }

  var LP_SCAN_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

  function buildScanCustomFields(v) {
    v = v || {}
    var html = ""
    html += '<div class="field-row"><div class="field"><label>Repeat every</label>'
    html +=
      '<input type="number" name="scanRepeatInterval" value="' +
      (v.scanRepeatInterval || 1) +
      '" min="1" required></div>'
    html += '<div class="field"><label>Unit</label><select name="scanRepeatUnit">'
    html += '<option value="day"' + (v.scanRepeatUnit === "day" ? " selected" : "") + ">Day(s)</option>"
    html += '<option value="week"' + (v.scanRepeatUnit === "week" ? " selected" : "") + ">Week(s)</option>"
    html += '<option value="month"' + (v.scanRepeatUnit === "month" ? " selected" : "") + ">Month(s)</option>"
    html += "</select></div></div>"
    html += '<div class="field-row"><div class="field"><label>Day of week</label><select name="scanDayOfWeek">'
    LP_SCAN_DAYS.forEach(function (d, i) {
      html +=
        '<option value="' + i + '"' + (String(v.scanDayOfWeek) === String(i) ? " selected" : "") + ">" + d + "</option>"
    })
    html += "</select></div>"
    html +=
      '<div class="field"><label>Hour</label><input type="number" name="scanStartTimeHour" value="' +
      (v.scanStartTimeHour || 0) +
      '" min="0" max="23" required></div>'
    html +=
      '<div class="field"><label>Minute</label><input type="number" name="scanStartTimeMinute" value="' +
      (v.scanStartTimeMinute || 0) +
      '" min="0" max="59" required></div></div>'
    html +=
      '<div class="field"><label>Scan duration (minutes)</label><input type="number" name="scanDurationMinutes" value="' +
      (v.scanDurationMinutes || 60) +
      '" min="1" required></div>'
    html +=
      '<div class="field"><label>First start date (optional)</label><input type="date" name="scanFirstStartAt" value="' +
      (v.scanFirstStartAt ? String(v.scanFirstStartAt).slice(0, 10) : "") +
      '"></div>'
    return html
  }

  function lpApplyScanMode(prefix) {
    var mode = "hourly"
    document
      .querySelectorAll('input[name="scanMode"][data-scan-mode="' + prefix + '"]')
      .forEach(function (r) {
        if (r.checked) mode = r.value
      })
    var custom = document.getElementById(prefix + "-scan-custom")
    if (custom) custom.style.display = mode === "custom" ? "" : "none"
    var modal = document.getElementById(prefix + "-modal")
    var hint = modal ? modal.querySelector(".lpx-scan-never-hint") : null
    if (hint) hint.style.display = mode === "never" ? "" : "none"
  }

  function lpApplyStorageMode(prefix) {
    var mode = "local"
    document
      .querySelectorAll('input[name="storage"][data-storage="' + prefix + '"]')
      .forEach(function (r) {
        if (r.checked) mode = r.value
      })
    var sftp = mode === "sftp"
    var fields = document.getElementById(prefix + "-sftp-fields")
    if (fields) fields.style.display = sftp ? "" : "none"
    if (sftp) closeDirBrowser()
    var label = document.querySelector('label[data-lp-path-label="' + prefix + '"]')
    if (label) label.textContent = sftp ? "Remote root (absolute path)" : "Filesystem path"
    var browse = document.querySelector('button[data-lp-browse="' + prefix + '"]')
    if (browse) browse.style.display = sftp ? "none" : ""
    document.querySelectorAll('#' + prefix + '-sftp-fields input, #' + prefix + '-sftp-fields textarea').forEach(function (el) {
      el.disabled = !sftp
    })
    if (!sftp) {
      var result = document.getElementById(prefix + "-sftp-test-result")
      if (result) result.innerHTML = ""
    }
    if (sftp) lpApplyAuthMode(prefix)
  }

  function lpApplyAuthMode(prefix) {
    var mode = "password"
    document
      .querySelectorAll('input[name="sftpAuthMode"][data-sftp-auth="' + prefix + '"]')
      .forEach(function (r) {
        if (r.checked) mode = r.value
      })
    var passRow = document.querySelector('[data-sftp-password-row="' + prefix + '"]')
    var keyRow = document.querySelector('[data-sftp-key-row="' + prefix + '"]')
    if (passRow) passRow.style.display = mode === "password" ? "" : "none"
    if (keyRow) keyRow.style.display = mode === "key" ? "" : "none"
  }

  document.addEventListener("change", function (e) {
    var target = e.target
    if (target && target.name === "scanMode" && target.dataset && target.dataset.scanMode) {
      lpApplyScanMode(target.dataset.scanMode)
    }
    if (target && target.name === "storage" && target.dataset && target.dataset.storage) {
      lpApplyStorageMode(target.dataset.storage)
    }
    if (target && target.name === "sftpAuthMode" && target.dataset && target.dataset.sftpAuth) {
      lpApplyAuthMode(target.dataset.sftpAuth)
    }
  })

  function openEditModal(lp) {
    var form = document.getElementById("edit-form")
    form.action = "/library-paths/update/" + lp.id
    document.getElementById("edit-name").value = lp.name || ""
    document.getElementById("edit-path").value = lp.path || ""
    document.getElementById("edit-type").value = lp.type || "movie"
    document.getElementById("edit-sourceLangId").value = String(lp.sourceLangId || "")
    document.getElementById("edit-enabled").checked = !!lp.enabled
    document.getElementById("edit-autoTranslate").checked = false
    document.getElementById("edit-autoExtract").checked = !!lp.autoExtract

    document.getElementById("edit-scan-custom").innerHTML = buildScanCustomFields(lp)
    var mode = lp.scanMode || "hourly"
    var radio = document.querySelector('input[name="scanMode"][data-scan-mode="edit"][value="' + mode + '"]')
    if (radio) radio.checked = true
    lpApplyScanMode("edit")

    var isSftp = lp.storage === "sftp"
    var storageRadio = document.querySelector('input[name="storage"][data-storage="edit"][value="' + (isSftp ? "sftp" : "local") + '"]')
    if (storageRadio) storageRadio.checked = true
    document.getElementById("edit-sftp-host").value = lp.sftpHost || ""
    document.getElementById("edit-sftp-port").value = String(lp.sftpPort || 22)
    document.getElementById("edit-sftp-username").value = lp.sftpUsername || ""
    var authRadio = document.querySelector(
      'input[name="sftpAuthMode"][data-sftp-auth="edit"][value="' + (lp.sftpAuthMode || "password") + '"]')
    if (authRadio) authRadio.checked = true
    document.getElementById("edit-sftp-password").value = ""
    document.getElementById("edit-sftp-password").placeholder = lp.hasSftpPassword
      ? "Leave empty to keep the stored password"
      : ""
    document.getElementById("edit-sftp-key").value = ""
    var clearPassRow = document.querySelector('[data-sftp-clear-row="edit-password"]')
    if (clearPassRow) {
      clearPassRow.style.display = lp.hasSftpPassword ? "" : "none"
      document.getElementById("edit-sftp-clear-pass").checked = false
    }
    var clearKeyRow = document.querySelector('[data-sftp-clear-row="edit-key"]')
    if (clearKeyRow) {
      clearKeyRow.style.display = lp.hasSftpPrivateKey ? "" : "none"
      document.getElementById("edit-sftp-clear-key").checked = false
    }
    var fp = document.querySelector('input[data-sftp-fingerprint="edit"]')
    if (fp) fp.value = isSftp ? lp.sftpHostKeyFingerprint || "" : ""
    document.getElementById("edit-sftp-test-result").innerHTML = ""
    lpApplyStorageMode("edit")

    closeDirBrowser()
    openModal("edit-modal")
  }

  function lpTestSftpConnection(prefix) {
    var resultBox = document.getElementById(prefix + "-sftp-test-result")
    if (!resultBox) return
    resultBox.innerHTML = '<span class="text-dim">Testing…</span>'
    var val = function (id) {
      var el = document.getElementById(prefix + "-" + id)
      return el ? el.value : ""
    }
    var clearChecked = function (id) {
      var el = document.getElementById(prefix + "-sftp-clear-" + id)
      return el ? el.checked : false
    }
    var storageRadio = document.querySelector('input[name="storage"][data-storage="' + prefix + '"]:checked')
    var authRadio = document.querySelector('input[name="sftpAuthMode"][data-sftp-auth="' + prefix + '"]:checked')
    var editingId = null
    if (prefix === "edit") {
      var m = (document.getElementById("edit-form").action || "").match(/\/library-paths\/update\/(\d+)/)
      if (m) editingId = Number(m[1])
    }
    var fpEl = document.querySelector('input[data-sftp-fingerprint="' + prefix + '"]')

    fetch("/library-paths/test-sftp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        RequestVerificationToken: csrfToken(),
      },
      body: JSON.stringify({
        storage: storageRadio ? storageRadio.value : "sftp",
        path: val("path"),
        sftpHost: val("sftp-host"),
        sftpPort: val("sftp-port"),
        sftpUsername: val("sftp-username"),
        sftpAuthMode: authRadio ? authRadio.value : "password",
        sftpPassword: val("sftp-password"),
        sftpPrivateKey: val("sftp-key"),
        sftpKeyPassphrase: val("sftp-key-pass"),
        clearSftpPassword: clearChecked("pass") ? "1" : "",
        clearSftpPrivateKey: clearChecked("key") ? "1" : "",
        clearSftpKeyPassphrase: "",
        sftpHostKeyFingerprint: fpEl ? fpEl.value : "",
        id: editingId,
      }),
    })
      .then(function (r) {
        if (redirectIfUnauthorized(r)) return null
        return r.json()
      })
      .then(function (data) {
        if (!data) return
        renderSftpTestResult(prefix, data)
      })
      .catch(function () {
        resultBox.innerHTML = '<span class="lpx-sftp-test-error">Test request failed</span>'
      })
  }

  function renderSftpTestResult(prefix, data) {
    var box = document.getElementById(prefix + "-sftp-test-result")
    if (!box) return
    var steps = (data.steps || [])
      .map(function (s) {
        return "<li>" + escHtml(s) + "</li>"
      })
      .join("")
    if (data.success) {
      var fpEl = document.querySelector('input[data-sftp-fingerprint="' + prefix + '"]')
      if (fpEl && data.presentedFingerprint) fpEl.value = data.presentedFingerprint
      box.innerHTML =
        '<div class="lpx-sftp-test-ok">Connection OK</div>' +
        (steps ? "<ul>" + steps + "</ul>" : "")
      return
    }
    var html = '<div class="lpx-sftp-test-error">' + escHtml(data.error || "Test failed") + "</div>"
    if (steps) html += "<ul>" + steps + "</ul>"
    if (data.presentedFingerprint && (data.needsTrust || data.keyChanged)) {
      html +=
        '<div class="lpx-fs-75">' +
        (data.keyChanged
          ? "The server presented a new host key — verify this is expected (e.g. the server was reinstalled) before trusting it:"
          : "Host key fingerprint:") +
        '</div><div class="lpx-sftp-fp">' +
        escHtml(data.presentedFingerprint) +
        '</div><button type="button" class="btn btn-secondary btn-sm" style="margin-top:.35rem" onclick="lpTrustSftpHostKey(\'' +
        prefix +
        '\')">Trust this host key and connect</button>'
    }
    box.innerHTML = html
  }

  function lpTrustSftpHostKey(prefix) {
    var box = document.getElementById(prefix + "-sftp-test-result")
    var shown = box ? box.querySelector(".lpx-sftp-fp") : null
    var fpEl = document.querySelector('input[data-sftp-fingerprint="' + prefix + '"]')
    if (shown && fpEl) fpEl.value = shown.textContent.trim()
    lpTestSftpConnection(prefix)
  }

  var _browserTargetInputId = null
  var _browserCurrentPath = "/"

  function openDirBrowser(inputId) {
    var panel = document.getElementById("dir-browser-panel")
    var anchor = document.getElementById(inputId + "-browser-anchor")
    if (_browserTargetInputId === inputId && panel.style.display !== "none") {
      closeDirBrowser()
      return
    }
    _browserTargetInputId = inputId
    anchor.appendChild(panel)
    panel.style.display = ""
    var inputVal = document.getElementById(inputId).value.trim()
    var startPath = inputVal || ROOT_PATH || "/"
    browseDir(startPath)
  }

  function closeDirBrowser() {
    var panel = document.getElementById("dir-browser-panel")
    panel.style.display = "none"
    _browserTargetInputId = null
  }

  function browseDir(dirPath) {
    _browserCurrentPath = dirPath
    document.getElementById("dir-current-path").textContent = dirPath
    document.getElementById("dir-list").innerHTML =
      '<div class="text-dim" style="padding:.5rem .75rem;font-size:.8rem">Loading…</div>'
    fetch("/library-paths/browse?path=" + encodeURIComponent(dirPath))
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        _browserCurrentPath = data.path
        document.getElementById("dir-current-path").textContent = data.path
        var upBtn = document.getElementById("dir-up-btn")
        var atRoot = !data.parent || (ROOT_PATH && data.path === ROOT_PATH)
        upBtn.disabled = !!atRoot
        upBtn.onclick =
          !atRoot && data.parent
            ? function () {
                browseDir(data.parent)
              }
            : null
        var list = document.getElementById("dir-list")
        if (data.error) {
          list.innerHTML =
            '<div style="padding:.5rem .75rem;color:var(--error);font-size:.82rem">' + escHtml(data.error) + "</div>"
          return
        }
        if (data.dirs.length === 0) {
          list.innerHTML = '<div class="text-dim" style="padding:.5rem .75rem;font-size:.82rem">No subdirectories</div>'
          return
        }
        list.innerHTML = ""
        data.dirs.forEach(function (d) {
          var btn = document.createElement("button")
          btn.type = "button"
          btn.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:.5rem",
            "width:100%",
            "padding:.4rem .75rem",
            "background:none",
            "border:none",
            "border-bottom:1px solid var(--border)",
            "text-align:left",
            "cursor:pointer",
            "color:var(--text)",
            "font-size:.85rem",
            "transition:background .1s",
          ].join(";")
          btn.innerHTML =
            '<i class="fa-solid fa-folder" style="color:var(--accent);font-size:.9rem;flex-shrink:0"></i>' +
            '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
            escHtml(d.name) +
            "</span>"
          btn.addEventListener("mouseenter", function () {
            btn.style.background = "var(--surface-3)"
          })
          btn.addEventListener("mouseleave", function () {
            btn.style.background = "none"
          })
          btn.addEventListener("click", function () {
            browseDir(d.fullPath)
          })
          list.appendChild(btn)
        })
        var last = list.lastElementChild
        if (last) last.style.borderBottom = "none"
      })
      .catch(function (e) {
        document.getElementById("dir-list").innerHTML =
          '<div style="padding:.5rem .75rem;color:var(--error);font-size:.82rem">Error: ' +
          escHtml(String(e)) +
          "</div>"
      })
  }

  function lpAjaxPost(url, body, onSuccess) {
    var tokenPart = "__RequestVerificationToken=" + encodeURIComponent(csrfToken())
    fetch(url + "?json=1", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body ? body + "&" + tokenPart : tokenPart,
    })
      .then(function (r) {
        if (redirectIfUnauthorized(r)) return null
        return r.json()
      })
      .then(function (data) {
        if (!data) return
        if (data.success) onSuccess(data)
        else showLpToast("error", data.msg || "Action failed")
      })
      .catch(function () {
        showLpToast("error", "Request failed")
      })
  }

  function openGroupMatchModal(btn) {
    var itemIds = btn.dataset.itemIds || "[]"
    var firstItemId = btn.dataset.firstItemId || ""
    var type = btn.dataset.type || "movie"
    var groupKey = btn.dataset.groupKey || ""
    var groupName = btn.dataset.groupName || ""
    var candidates = []
    try {
      candidates = JSON.parse(btn.dataset.candidates || "[]")
    } catch (e) {}

    var searchEl = document.getElementById("item-match-search")
    var resultsEl = document.getElementById("item-match-results")
    var candEl = document.getElementById("item-match-candidates")
    searchEl.dataset.itemId = firstItemId
    searchEl.dataset.itemIds = itemIds
    searchEl.dataset.groupKey = groupKey
    searchEl.dataset.type = type
    resultsEl.dataset.itemId = firstItemId
    resultsEl.dataset.groupKey = groupKey
    searchEl.value = ""
    resultsEl.innerHTML = ""

    candEl.innerHTML = ""
    if (candidates.length > 0) {
      candidates.forEach(function (c) {
        var cPoster =
          SHOW_POSTERS && c.photoPath
            ? '<img src="/media-photos/' +
              escAttr(c.photoPath) +
              '" alt="Poster" style="width:54px;height:81px;object-fit:cover;border-radius:4px;flex-shrink:0">'
            : '<div style="width:54px;height:81px;background:var(--surface-2);border-radius:4px;display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="fa-solid fa-film" style="color:var(--text-dim)"></i></div>'
        var b = document.createElement("button")
        b.type = "button"
        b.className = "btn btn-secondary lp-select-group-candidate-btn"
        b.style.cssText =
          "display:flex;flex-direction:row;align-items:center;gap:.75rem;padding:.6rem .75rem;height:auto;width:100%;text-align:left"
        b.dataset.itemIds = itemIds
        b.dataset.mediaItemId = String(c.mediaItemId)
        b.innerHTML =
          cPoster +
          '<span style="font-size:.88rem;line-height:1.35;word-break:break-word;min-width:0"><strong>' +
          escHtml(c.title || "Unknown") +
          '</strong><br><span class="text-dim" style="font-size:.8rem">(' +
          escHtml(c.year || "year unknown") +
          ")</span></span>"
        candEl.appendChild(b)
      })
      candEl.style.display = ""
    } else {
      candEl.style.display = "none"
    }

    document.getElementById("item-match-name").textContent = groupName
    openModal("item-match-modal")
    setTimeout(function () {
      searchEl.focus()
    }, 50)
  }

  document.addEventListener("click", function (e) {
    var toastClose = e.target.closest && e.target.closest("[data-toast-close]")
    if (toastClose) {
      var toast = toastClose.closest(".toast")
      if (toast) toast.remove()
    }

    var editBtn = e.target.closest && e.target.closest(".lp-edit-btn")
    if (editBtn) {
      var lp = JSON.parse(editBtn.getAttribute("data-lp"))
      openEditModal(lp)
      return
    }

    var itemMatchBtn = e.target.closest(".lp-item-match-btn")
    if (itemMatchBtn) {
      var imItemId = itemMatchBtn.dataset.itemId
      var imType = itemMatchBtn.dataset.type || "movie"
      var searchEl = document.getElementById("item-match-search")
      var resultsEl = document.getElementById("item-match-results")
      var imCandEl = document.getElementById("item-match-candidates")
      searchEl.dataset.itemId = imItemId
      searchEl.dataset.type = imType
      delete searchEl.dataset.itemIds
      delete searchEl.dataset.groupKey
      resultsEl.dataset.itemId = imItemId
      delete resultsEl.dataset.groupKey
      searchEl.value = ""
      resultsEl.innerHTML = ""
      if (imCandEl) {
        imCandEl.innerHTML = ""
        imCandEl.style.display = "none"
      }
      document.getElementById("item-match-name").textContent = itemMatchBtn.dataset.itemName || ""
      openModal("item-match-modal")
      setTimeout(function () {
        searchEl.focus()
      }, 50)
      return
    }

    var openBtn = e.target.closest(".lp-group-match-btn")
    if (openBtn) {
      openGroupMatchModal(openBtn)
      return
    }

    var groupCandBtn = e.target.closest(".lp-select-group-candidate-btn")
    if (groupCandBtn) {
      lpAjaxPost(
        "/library-paths/group/select-candidate",
        "itemIds=" +
          encodeURIComponent(groupCandBtn.dataset.itemIds) +
          "&mediaItemId=" +
          encodeURIComponent(groupCandBtn.dataset.mediaItemId),
        function () {
          closeModal("item-match-modal")
          reloadWithScrollRestore()
        },
      )
      return
    }

    var blBtn = e.target.closest(".lp-blacklist-btn")
    if (blBtn) {
      _blItemId = blBtn.dataset.itemId
      _blItemIds = null
      document.getElementById("blacklist-target-name").textContent = blBtn.dataset.itemName || ""
      document.getElementById("blacklist-reason").value = ""
      openModal("blacklist-modal")
      return
    }

    var blGroupBtn = e.target.closest(".lp-blacklist-group-btn")
    if (blGroupBtn) {
      _blItemId = null
      _blItemIds = JSON.parse(blGroupBtn.dataset.itemIds || "[]")
      document.getElementById("blacklist-target-name").textContent =
        (blGroupBtn.dataset.groupName || "this group") + " — all items"
      document.getElementById("blacklist-reason").value = ""
      openModal("blacklist-modal")
      return
    }

    var tmdbBtn = e.target.closest(".lp-select-tmdb-btn")
    if (tmdbBtn) {
      var itemId = tmdbBtn.dataset.itemId
      var itemIds2 = tmdbBtn.dataset.itemIds
      var ti = JSON.parse(tmdbBtn.dataset.tmdbItem)
      var year = ti.releaseDate ? ti.releaseDate.substring(0, 4) : ""
      var bodyParts = [
        "title=" + encodeURIComponent(ti.name || ""),
        "originalTitle=" + encodeURIComponent(ti.originalTitle || ""),
        "year=" + encodeURIComponent(year),
        "isAnime=" + encodeURIComponent(ti.isAnime ? "1" : "0"),
        "genres=" + encodeURIComponent(ti.genres || ""),
        "theMovieDbId=" + encodeURIComponent(String(ti.id || "")),
        "posterUrl=" + encodeURIComponent(ti.posterUrl || ""),
        "type=" + encodeURIComponent(tmdbBtn.dataset.type || ""),
      ]
      if (itemIds2) {
        bodyParts.push("itemIds=" + encodeURIComponent(itemIds2))
        lpAjaxPost("/library-paths/group/select-tmdb-result", bodyParts.join("&"), function () {
          closeModal("item-match-modal")
          reloadWithScrollRestore()
        })
      } else {
        lpAjaxPost("/library-paths/item/" + itemId + "/select-tmdb-result", bodyParts.join("&"), function () {
          closeModal("item-match-modal")
          reloadWithScrollRestore()
        })
      }
      return
    }

    var bulkTmdbBtn = e.target.closest && e.target.closest(".lp-bulk-tmdb-btn")
    if (bulkTmdbBtn) {
      var bti = JSON.parse(bulkTmdbBtn.dataset.tmdbItem)
      var btype = bulkTmdbBtn.dataset.type
      var byear = bti.releaseDate ? bti.releaseDate.substring(0, 4) : ""
      var seenIds = {}
      var allItemIds = []
      Object.values(_selectedGroups).forEach(function (g) {
        ;(g.itemIds || []).forEach(function (id) {
          if (!seenIds[id]) {
            seenIds[id] = true
            allItemIds.push(id)
          }
        })
      })
      var bbp = [
        "itemIds=" + encodeURIComponent(JSON.stringify(allItemIds)),
        "title=" + encodeURIComponent(bti.name || ""),
        "originalTitle=" + encodeURIComponent(bti.originalTitle || ""),
        "year=" + encodeURIComponent(byear),
        "isAnime=" + encodeURIComponent(bti.isAnime ? "1" : "0"),
        "genres=" + encodeURIComponent(bti.genres || ""),
        "theMovieDbId=" + encodeURIComponent(String(bti.id || "")),
        "posterUrl=" + encodeURIComponent(bti.posterUrl || ""),
        "type=" + encodeURIComponent(btype),
      ]
      bulkTmdbBtn.disabled = true
      bulkTmdbBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin:auto"></i>'
      lpAjaxPost("/library-paths/group/select-tmdb-result", bbp.join("&"), function () {
        closeModal("bulk-match-modal")
        _selectedGroups = {}
        document.querySelectorAll(".lp-group-cb:checked, .lp-item-cb:checked").forEach(function (cb) {
          cb.checked = false
        })
        updateBulkBar()
        reloadWithScrollRestore()
      })
      return
    }
  })

  document.addEventListener("submit", function (e) {
    var form = e.target
    if (!form || form.tagName !== "FORM") return
    var action = form.getAttribute("action") || ""
    var translateMatch = action.match(/\/library-paths\/item\/(\d+)\/(translate|readd)$/)
    if (translateMatch) {
      e.preventDefault()
      var itemId = translateMatch[1]
      var row = document.querySelector('[data-item-row="' + itemId + '"]')
      lpAjaxPost(action, "", function (data) {
        if (row) {
          var badge = row.querySelector("[data-item-status]")
          if (badge) {
            badge.className = "badge badge-warning"
            badge.textContent = "queued"
          }
          row.querySelectorAll("form").forEach(function (f) {
            var fa = f.getAttribute("action") || ""
            if (fa.indexOf("/translate") !== -1 || fa.indexOf("/readd") !== -1) f.remove()
          })
        }
        showLpToast("success", data.msg || "Queued")
      })
      return
    }
    if (form.closest && form.closest(".modal-overlay")) {
      _intentionalNavigation = true
    }
  })

  var _blItemId = null
  var _blItemIds = null
  document.getElementById("blacklist-form").addEventListener("submit", function (e) {
    e.preventDefault()
    var reason = document.getElementById("blacklist-reason").value || ""
    if (_blItemIds && _blItemIds.length > 0) {
      lpAjaxPost(
        "/library-paths/group/blacklist",
        "itemIds=" + encodeURIComponent(JSON.stringify(_blItemIds)) + "&reason=" + encodeURIComponent(reason),
        function (data) {
          closeModal("blacklist-modal")
          _blItemIds.forEach(function (id) {
            var row = document.querySelector('[data-item-row="' + id + '"]')
            if (row) row.remove()
            activeState().knownIds.delete(String(id))
          })
          showLpToast("success", data.msg || "Group blacklisted")
          _blItemIds = null
        },
      )
    } else if (_blItemId) {
      lpAjaxPost(
        "/library-paths/item/" + _blItemId + "/blacklist",
        "reason=" + encodeURIComponent(reason),
        function (data) {
          closeModal("blacklist-modal")
          var row = document.querySelector('[data-item-row="' + _blItemId + '"]')
          if (row) row.remove()
          activeState().knownIds.delete(String(_blItemId))
          showLpToast("success", data.msg || "Item blacklisted")
          _blItemId = null
        },
      )
    }
  })

  document.addEventListener("change", function (e) {
    var input = e.target
    if (input.classList && input.classList.contains("lp-photo-input")) {
      var mediaItemId = input.dataset.mediaItemId
      var file = input.files && input.files[0]
      if (!file) return
      var formData = new FormData()
      formData.append("photo", file)
      formData.append("__RequestVerificationToken", csrfToken())
      showLpToast("success", "Uploading…")
      fetch("/library-paths/media-item/" + mediaItemId + "/upload-photo", { method: "POST", body: formData })
        .then(function (r) {
          return r.json()
        })
        .then(function (data) {
          if (data.success) {
            showLpToast("success", "Photo updated")
            _intentionalNavigation = true
            sessionStorage.setItem("lp_scroll_pos", String(window.scrollY || 0))
            location.reload()
          } else {
            showLpToast("error", data.msg || "Upload failed")
          }
        })
        .catch(function () {
          showLpToast("error", "Upload failed")
        })
      input.value = ""
      return
    }
    var cb = e.target.closest && e.target.closest(".lp-group-cb")
    if (cb) {
      var key = cb.dataset.groupKey
      if (cb.checked) {
        _selectedGroups[key] = {
          itemIds: JSON.parse(cb.dataset.itemIds || "[]"),
          firstItemId: cb.dataset.firstItemId,
          type: cb.dataset.lpType,
        }
      } else {
        delete _selectedGroups[key]
      }
      updateBulkBar()
      return
    }
    var icb = e.target.closest && e.target.closest(".lp-item-cb")
    if (icb) {
      var itemId = parseInt(icb.dataset.itemId)
      var ikey = "item-" + itemId
      if (icb.checked) {
        _selectedGroups[ikey] = {
          itemIds: [itemId],
          firstItemId: icb.dataset.itemId,
          type: icb.dataset.lpType,
        }
      } else {
        delete _selectedGroups[ikey]
      }
      updateBulkBar()
    }
  })

  var _tmdbTimers = {}
  document.addEventListener("input", function (e) {
    var input = e.target
    if (!input.classList || !input.classList.contains("lp-tmdb-search")) return
    var itemId = input.dataset.itemId
    var itemIds = input.dataset.itemIds || null
    var groupKey = input.dataset.groupKey || null
    var type = input.dataset.type
    var q = input.value.trim()
    clearTimeout(_tmdbTimers[itemId])

    var scope = input.closest("#item-match-modal") || document
    var resultsEl = scope.querySelector(".lp-tmdb-results")
    if (!q) {
      if (resultsEl) resultsEl.innerHTML = ""
      return
    }

    _tmdbTimers[itemId] = setTimeout(function () {
      if (resultsEl)
        resultsEl.innerHTML = '<div class="text-dim" style="font-size:.8rem;padding:.25rem 0">Searching…</div>'
      fetch("/library-paths/item/" + itemId + "/search-tmdb?q=" + encodeURIComponent(q))
        .then(function (r) {
          return r.json()
        })
        .then(function (data) {
          if (!resultsEl) return
          if (!data.items || data.items.length === 0) {
            resultsEl.innerHTML = '<div class="text-dim" style="font-size:.8rem;padding:.25rem 0">No results.</div>'
            return
          }
          resultsEl.innerHTML = ""
          var grid = document.createElement("div")
          grid.className = "lp-candidate-grid"
          data.items.slice(0, 8).forEach(function (ti) {
            grid.appendChild(tmdbResultButton(ti, itemId, itemIds, groupKey, type, "lp-select-tmdb-btn"))
          })
          resultsEl.appendChild(grid)
        })
        .catch(function () {
          if (resultsEl)
            resultsEl.innerHTML = '<div class="text-dim" style="font-size:.8rem;padding:.25rem 0">Search failed.</div>'
        })
    }, 300)
  })

  function tmdbResultButton(ti, itemId, itemIds, groupKey, type, btnClass) {
    var year = ti.releaseDate && ti.releaseDate.length >= 4 ? ti.releaseDate.substring(0, 4) : "year unknown"
    var btn = document.createElement("button")
    btn.type = "button"
    btn.className = "btn btn-secondary " + btnClass
    btn.dataset.itemId = itemId
    if (itemIds) btn.dataset.itemIds = itemIds
    if (groupKey) btn.dataset.groupKey = groupKey
    btn.dataset.type = type
    btn.dataset.tmdbItem = JSON.stringify(ti)
    btn.style.cssText =
      "display:flex;flex-direction:row;align-items:center;gap:.75rem;padding:.6rem .75rem;height:auto;width:100%;text-align:left"
    var posterHtml =
      SHOW_POSTERS && ti.posterUrl
        ? '<img src="' +
          escHtml(ti.posterUrl) +
          '" alt="Poster" style="width:54px;height:81px;object-fit:cover;border-radius:4px;flex-shrink:0" onerror="this.style.display=\'none\'">'
        : '<div style="width:54px;height:81px;background:var(--surface-2);border-radius:4px;display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="fa-solid fa-film" style="font-size:1.4rem;color:var(--text-dim)"></i></div>'
    btn.innerHTML =
      posterHtml +
      '<span style="font-size:.88rem;line-height:1.35;word-break:break-word;min-width:0"><strong>' +
      escHtml(ti.name || "Unknown") +
      '</strong><br><span class="text-dim" style="font-size:.8rem">(' +
      escHtml(year) +
      ")</span>" +
      (ti.genres ? '<br><span class="text-dim" style="font-size:.75rem">' + escHtml(ti.genres) + "</span>" : "") +
      "</span>"
    return btn
  }

  var _selectedGroups = {}
  function updateBulkBar() {
    var keys = Object.keys(_selectedGroups)
    var bar = document.getElementById("lp-bulk-bar")
    var countEl = document.getElementById("lp-bulk-count")
    if (keys.length === 0) {
      bar.style.display = "none"
      return
    }
    bar.style.display = ""
    var totalItems = bulkSelectedItemCount()
    countEl.textContent = totalItems + " file" + (totalItems !== 1 ? "s" : "") + " selected"
  }

  function bulkSelectedItemCount() {
    var ids = {}
    Object.keys(_selectedGroups).forEach(function (k) {
      ;(_selectedGroups[k].itemIds || []).forEach(function (id) {
        ids[id] = true
      })
    })
    return Object.keys(ids).length
  }

  document.getElementById("lp-bulk-clear-btn").addEventListener("click", function () {
    _selectedGroups = {}
    document.querySelectorAll(".lp-group-cb:checked, .lp-item-cb:checked").forEach(function (cb) {
      cb.checked = false
    })
    updateBulkBar()
  })

  document.getElementById("lp-bulk-change-match-btn").addEventListener("click", function () {
    var keys = Object.keys(_selectedGroups)
    if (keys.length === 0) return
    document.getElementById("bulk-modal-count").textContent = bulkSelectedItemCount()
    document.getElementById("bulk-tmdb-search").value = ""
    document.getElementById("bulk-tmdb-results").innerHTML = ""
    openModal("bulk-match-modal")
  })

  var _bulkTmdbTimer = null
  document.getElementById("bulk-tmdb-search").addEventListener("input", function () {
    var q = this.value.trim()
    var resultsEl = document.getElementById("bulk-tmdb-results")
    clearTimeout(_bulkTmdbTimer)
    if (!q) {
      resultsEl.innerHTML = ""
      return
    }
    var keys = Object.keys(_selectedGroups)
    var firstGroup = keys.length > 0 ? _selectedGroups[keys[0]] : null
    var type = firstGroup ? firstGroup.type || "movie" : "movie"
    var firstItemId = firstGroup ? firstGroup.firstItemId : null
    if (!firstItemId) return
    resultsEl.innerHTML = '<div class="text-dim" style="font-size:.8rem;padding:.25rem 0">Searching…</div>'
    _bulkTmdbTimer = setTimeout(function () {
      fetch("/library-paths/item/" + firstItemId + "/search-tmdb?q=" + encodeURIComponent(q))
        .then(function (r) {
          return r.json()
        })
        .then(function (data) {
          if (!data.items || data.items.length === 0) {
            resultsEl.innerHTML = '<div class="text-dim" style="font-size:.8rem;padding:.25rem 0">No results.</div>'
            return
          }
          var grid = document.createElement("div")
          grid.className = "lp-candidate-grid"
          data.items.slice(0, 8).forEach(function (ti) {
            grid.appendChild(tmdbResultButton(ti, firstItemId, null, null, type, "lp-bulk-tmdb-btn"))
          })
          resultsEl.innerHTML = ""
          resultsEl.appendChild(grid)
        })
        .catch(function () {
          resultsEl.innerHTML = '<div class="text-dim" style="font-size:.8rem;padding:.25rem 0">Search failed.</div>'
        })
    }, 300)
  })

  document.getElementById("dir-select-btn").addEventListener("click", function () {
    if (_browserTargetInputId) {
      document.getElementById(_browserTargetInputId).value = _browserCurrentPath
    }
    closeDirBrowser()
  })
  document.getElementById("dir-up-btn").disabled = true
  document.querySelectorAll(".modal-overlay").forEach(function (overlay) {
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeDirBrowser()
    })
  })
  window.openDirBrowser = openDirBrowser
  window.closeDirBrowser = closeDirBrowser
  window.lpTestSftpConnection = lpTestSftpConnection
  window.lpTrustSftpHostKey = lpTrustSftpHostKey

  document.addEventListener("input", function (e) {
    if (e.target.classList && e.target.classList.contains("lp-search")) {
      clearTimeout(_filterTimer)
      _filterTimer = setTimeout(applyFilters, 300)
    }
  })
  document.addEventListener("change", function (e) {
    if (e.target.classList && e.target.classList.contains("lp-genre-filter")) {
      applyFilters()
    }
  })

  window.lpSwitchTab = function (tab) {
    _activeTab = tab
    document.getElementById("lp-tab-movie").style.display = tab === "movie" ? "" : "none"
    document.getElementById("lp-tab-series").style.display = tab === "series" ? "" : "none"
    document.getElementById("lp-tab-blacklist").style.display = tab === "blacklist" ? "" : "none"
    document.getElementById("lp-tab-btn-movie").classList.toggle("active", tab === "movie")
    document.getElementById("lp-tab-btn-series").classList.toggle("active", tab === "series")
    document.getElementById("lp-tab-btn-blacklist").classList.toggle("active", tab === "blacklist")
    var p = new URLSearchParams(location.search)
    p.set("tab", tab)
    history.replaceState(null, "", location.pathname + "?" + p.toString())
    loadTab(tab)
    if (tab !== "blacklist") applyFilters()
  }

  ;(function () {
    var _lpObserver = null
    if ("IntersectionObserver" in window) {
      _lpObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              var img = entry.target
              if (img.dataset.src) {
                img.src = img.dataset.src
                img.removeAttribute("data-src")
                img.classList.add("is-loaded")
              }
              _lpObserver.unobserve(img)
            }
          })
        },
        { rootMargin: "200px" },
      )
    }
    window.lpInitLazyLoad = function (container) {
      var root = container || document
      var imgs = root.querySelectorAll("img.lp-lazy-img[data-src]")
      if (_lpObserver) {
        imgs.forEach(function (img) {
          _lpObserver.observe(img)
        })
      } else {
        imgs.forEach(function (img) {
          if (img.dataset.src) {
            img.src = img.dataset.src
            img.removeAttribute("data-src")
            img.classList.add("is-loaded")
          }
        })
      }
    }
  })()

  ;(function () {
    if (typeof signalR === "undefined") return
    try {
      var conn = new signalR.HubConnectionBuilder()
        .withUrl("/hubs/library")
        .withAutomaticReconnect()
        .build()
      conn.on("scanEvent", function (evt) {
        if (!evt || evt.libraryPathId == null) return
        var el = document.querySelector('[data-lp-state="' + evt.libraryPathId + '"]')
        if (el) {
          if (evt.phase === "started" || evt.phase === "scanning") {
            setBadge(el, "scanning", "badge-warning")
          } else if (evt.phase === "failed") {
            setBadge(el, "error", "badge-error")
          } else if (evt.phase === "done" || evt.phase === "aborted" || evt.phase === "completed") {
            setBadge(el, "idle", "badge-neutral")
          }
        }
        if (evt.phase === "done" || evt.phase === "completed" || evt.phase === "failed") {
          refreshChangedPaths("movie")
          refreshChangedPaths("series")
        }
      })
      conn.onreconnected(function () {
        refreshChangedPaths("movie")
        refreshChangedPaths("series")
      })
      conn.start().catch(function () {})
    } catch (e) {
    }
  })()

  ;(function () {
    var saved = sessionStorage.getItem("lp_scroll_pos")
    if (saved !== null) {
      sessionStorage.removeItem("lp_scroll_pos")
      var y = parseInt(saved, 10)
      if (!isNaN(y))
        setTimeout(function () {
          window.scrollTo(0, y)
        }, 50)
    }
  })()

  window.addEventListener("beforeunload", function (e) {
    if (!_intentionalNavigation && document.querySelector(".modal-overlay.open")) {
      e.preventDefault()
      e.returnValue = ""
    }
  })

  lpApplyStorageMode("add")
  var initialTab = new URLSearchParams(location.search).get("tab")
  if (initialTab === "series" || initialTab === "blacklist") {
    _activeTab = initialTab
    window.lpSwitchTab(initialTab)
  } else {
    loadTab("movie").then(function () {
      loadTab("series")
    })
  }
})()