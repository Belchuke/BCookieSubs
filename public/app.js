function redirectIfUnauthorized(response) {
  if (response && response.status === 401) {
    var next = encodeURIComponent(location.pathname + location.search)
    location.href = "/login?next=" + next
    return true
  }
  return false
}

function openModal(id) {
  var el = document.getElementById(id)
  if (el) el.classList.add("open")
}

function closeModal(id) {
  var el = document.getElementById(id)
  if (el) el.classList.remove("open")
}

function closeModalOnOverlay(event) {
  if (event.target === event.currentTarget) {
    event.currentTarget.classList.remove("open")
  }
}

;(function () {
  var toast = document.getElementById("page-toast")
  if (toast) {
    setTimeout(function () {
      toast.style.transition = "opacity .4s"
      toast.style.opacity = "0"
      setTimeout(function () {
        toast.remove()
      }, 400)
    }, 4000)
  }
})()

;(function () {
  var form1 = document.getElementById("upload-form-step1")
  var form2 = document.getElementById("upload-form-step2")
  if (!form1 || !form2) return

  var storedFile = null
  var tmdbResults = []

  function applyTmdbResult(r) {
    var nameEl = document.getElementById("up2-name")
    var yearEl = document.getElementById("up2-year")
    var theMovieDbIdField = document.getElementById("up2-theMovieDbId")
    var posterBase64Field = document.getElementById("up2-posterBase64")
    var posterWrap = document.getElementById("up2-poster-wrap")
    var posterImg = document.getElementById("up2-poster")
    var originalTitleField = document.getElementById("up2-originalTitle")
    var isAnimeField = document.getElementById("up2-isAnime")
    var genresField = document.getElementById("up2-genres")
    var posterUrlField = document.getElementById("up2-posterUrl")
    if (nameEl && r.name) nameEl.value = r.name
    if (yearEl && r.releaseDate) yearEl.value = r.releaseDate.slice(0, 4)
    if (theMovieDbIdField) theMovieDbIdField.value = r.id || ""
    if (posterBase64Field) posterBase64Field.value = r.posterBase64 || ""
    if (originalTitleField) originalTitleField.value = r.originalTitle || ""
    if (isAnimeField) isAnimeField.value = r.isAnime ? "1" : "0"
    if (genresField) genresField.value = r.genres || ""
    if (posterUrlField) posterUrlField.value = r.posterUrl || ""
    if (posterWrap && posterImg) {
      if (r.posterBase64) {
        posterImg.src = r.posterBase64
        posterWrap.style.display = ""
      } else {
        posterWrap.style.display = "none"
      }
    }
  }

  var tmdbSelectEl = document.getElementById("up2-tmdb-select")
  if (tmdbSelectEl) {
    tmdbSelectEl.addEventListener("change", function () {
      var r = tmdbResults[parseInt(this.value)]
      if (r) applyTmdbResult(r)
    })
  }

  form1.addEventListener("submit", function (e) {
    e.preventDefault()
    var fileInput = document.getElementById("up1-srtFile")
    var langSelect = document.getElementById("up1-sourceLangId")

    if (!fileInput.files || !fileInput.files[0]) {
      alert("Please select an SRT file.")
      return
    }
    if (!langSelect || !langSelect.value) {
      alert("Please select a source language.")
      return
    }

    storedFile = fileInput.files[0]
    var btn = form1.querySelector('[type="submit"]')
    btn.disabled = true
    btn.textContent = "Analyzing…"

    var fd = new FormData()
    fd.append("srtFile", storedFile)
    fd.append("filename", storedFile.name)

    fetch("/dashboard/upload/step1", { method: "POST", body: fd })
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        btn.disabled = false
        btn.textContent = "Next →"

        var nameEl = document.getElementById("up2-name")
        var typeEl = document.getElementById("up2-type")
        var yearEl = document.getElementById("up2-year")
        var seasonEl = document.getElementById("up2-season")
        var episodeEl = document.getElementById("up2-episode")
        var srcHidden = document.getElementById("up2-sourceLangId")
        var tmdbSelector = document.getElementById("up2-tmdb-selector")
        var posterWrap = document.getElementById("up2-poster-wrap")

        if (srcHidden) srcHidden.value = langSelect.value

                tmdbResults = []
        if (tmdbSelector) tmdbSelector.style.display = "none"
        if (posterWrap) posterWrap.style.display = "none"
        var posterBase64Field = document.getElementById("up2-posterBase64")
        if (posterBase64Field) posterBase64Field.value = ""

        var detectedName =
          data.detected && data.detected.name ? data.detected.name : data.filename || storedFile.name || ""
        if (nameEl) nameEl.value = detectedName

        if (data.detected && typeEl) {
          typeEl.value = data.detected.type || "unknown"
          if (typeof toggleSeriesFields === "function") toggleSeriesFields(typeEl.value)
          if (data.detected.year && yearEl) yearEl.value = data.detected.year
          if (data.detected.season && seasonEl) seasonEl.value = data.detected.season
          if (data.detected.episode && episodeEl) episodeEl.value = data.detected.episode
        }

                tmdbResults = (data.detected && data.detected.theMovieDbRequestResult) || []
        if (tmdbResults.length === 1) {
          applyTmdbResult(tmdbResults[0])
        } else if (tmdbResults.length > 1 && tmdbSelectEl && tmdbSelector) {
          tmdbSelectEl.innerHTML = tmdbResults
            .map(function (r, i) {
              var year = r.releaseDate ? " (" + r.releaseDate.slice(0, 4) + ")" : ""
              return (
                '<option value="' + i + '">' + escapeHtml(r.name || r.originalTitle || "Unknown") + year + "</option>"
              )
            })
            .join("")
          tmdbSelector.style.display = ""
          applyTmdbResult(tmdbResults[0])
        }

        closeModal("upload-modal")
        openModal("upload-modal-step2")
        if (typeof updateLangChips === "function") updateLangChips()
      })
      .catch(function (e) {
        btn.disabled = false
        btn.textContent = "Next →"
        alert("Error analyzing file: " + e.message)
      })
  })

  form2.addEventListener("submit", function (e) {
    e.preventDefault()
    if (!storedFile) {
      alert("No file selected — please go back to step 1.")
      return
    }

    var fd = new FormData(form2)
    fd.append("srtFile", storedFile, storedFile.name)

    var btn = form2.querySelector('[type="submit"]')
    btn.disabled = true
    btn.textContent = "Adding…"

    fetch("/dashboard/upload/step2", { method: "POST", body: fd })
      .then(function (r) {
        window.location.href = r.url
      })
      .catch(function (e) {
        btn.disabled = false
        btn.textContent = "Add to Queue"
        alert("Error: " + e.message)
      })
  })
})()

;(function () {
  var queueList = document.getElementById("queue-list")
  if (!queueList) return

  var POLL_INTERVAL = 15000
  var openSubs = {}
  var openSeries = {}

  
  function posterThumb(mediaItemId) {
    if (typeof SHOW_POSTERS !== 'undefined' && !SHOW_POSTERS) return ''
    if (!mediaItemId) return '<div class="acc-poster-placeholder"></div>'
    return (
      '<img class="acc-poster-thumb" src="/dashboard/poster/' +
      mediaItemId +
      '" ' +
      'onerror="this.style.display=\'none\'" alt="">'
    )
  }

  function segmentedBar(donePct, failedPct, title, indeterminate) {
    var html = '<div class="progress-bar' + (indeterminate ? ' progress-bar-indeterminate' : '') + '" title="' + title + '"><div style="height:100%;display:flex">'
    if (indeterminate) {
      html += '<div class="progress-fill-indeterminate"></div>'
    } else {
      html += '<div class="progress-fill" style="width:' + donePct + '%"></div>'
      if (failedPct > 0) html += '<div class="progress-fill-failed" style="width:' + failedPct + '%"></div>'
    }
    html += '</div></div>'
    return html
  }

  // A single determinate "Whispering" progress row shown while a Whisper
  // subtitle is still transcribing (before any translation jobs can run).
  function whisperProgressRow(pct) {
    var label = (typeof APP_STRINGS !== "undefined" && APP_STRINGS.whispering) || "Whispering"
    return (
      '<div class="target-progress">' +
      '<span class="target-lang">' + label + "</span>" +
      segmentedBar(pct, 0, label, false) +
      '<span class="progress-label">' + pct + "%</span>" +
      "</div>"
    )
  }

  function targetProgressHtml(s, langMap) {
    var totalChunks = 0,
      doneChunks = 0,
      failedChunks = 0,
      html = ""
    var multiTarget = (s.targets || []).length > 1
    ;(s.targets || []).forEach(function (t) {
      totalChunks += t.total
      doneChunks += t.done
      failedChunks += (t.failed || 0)
      var tLang = langMap[t.targetLangId]
      var tLangCode = tLang ? (tLang.iso639 || "").toUpperCase() : String(t.targetLangId)
      var tLabel = tLang ? (tLang.flagCode ? '<span class="fi fi-' + tLang.flagCode + '"></span> ' : '') + tLangCode : tLangCode
      var isPlaceholder = t.total === 0 && t.jobStatus === "queued"
      var tDonePct = t.total > 0 ? Math.round((t.done / t.total) * 100) : t.jobStatus === "completed" ? 100 : 0
      var tFailedPct = t.total > 0 ? Math.round(((t.failed || 0) / t.total) * 100) : 0
      if (tDonePct + tFailedPct > 100) tFailedPct = 100 - tDonePct
      var tRemaining = Math.max(0, t.total - t.done - (t.failed || 0))
      var tTitle = isPlaceholder
        ? "Waiting for Whisper transcription"
        : t.done + " completed, " + (t.failed || 0) + " failed, " + tRemaining + " remaining"
      var jobActive = t.jobStatus !== "completed" && t.jobStatus !== "cancelled"
      html += '<div class="target-progress">'
      html += '<span class="target-lang">' + tLabel + "</span>"
      html += segmentedBar(tDonePct, tFailedPct, tTitle, isPlaceholder)
      html += '<span class="progress-label">' + (isPlaceholder ? "—" : t.done + "/" + t.total + " (" + tDonePct + "%)") + "</span>"
      if (multiTarget && jobActive && (typeof CAN_STOP === "undefined" || CAN_STOP)) {
        html += '<form method="POST" action="/dashboard/cancel-job/' + t.jobId + '" style="display:inline"'
        html += ' onsubmit="return confirm(\'Cancel ' + escapeHtml(tLangCode) + '?\')">'
        html += '<button type="submit" class="btn btn-icon btn-xs btn-danger" title="Cancel ' + escapeHtml(tLangCode) + '">✕</button></form>'
      }
      html += "</div>"
    })
    return { html: html, totalChunks: totalChunks, doneChunks: doneChunks, failedChunks: failedChunks }
  }

  function subtitleBodyActions(s, langMap) {
    var isActive = s.status !== "completed" && s.status !== "cancelled"
    var html = '<div class="accordion-actions">'
    if (isActive && (typeof CAN_STOP === "undefined" || CAN_STOP)) {
      html += '<form method="POST" action="/dashboard/cancel/' + s.id + '" style="display:inline"'
      html += " onsubmit=\"return confirm('Cancel?')\">"
      html += '<button type="submit" class="btn btn-icon btn-danger" title="Cancel">✕</button></form>'
    }
    if (!isActive && (typeof CAN_DELETE === "undefined" || CAN_DELETE)) {
      html += '<form method="POST" action="/dashboard/delete/' + s.id + '" style="display:inline"'
      html += " onsubmit=\"return confirm('Delete?')\">"
      html += '<button type="submit" class="btn btn-icon btn-danger" title="Delete">🗑</button></form>'
      html += '<form method="POST" action="/dashboard/hide/' + s.id + '" style="display:inline">'
      html += '<button type="submit" class="btn btn-icon" title="Hide">👁</button></form>'
    }
    ;(s.targets || []).forEach(function (t) {
      if (t.hasTranslation) {
        var tLang = langMap[t.targetLangId]
        var tLabel = tLang ? tLang.iso639.toUpperCase() : t.targetLangId
        html +=
          '<a href="/dashboard/download/' +
          t.jobId +
          '" class="btn btn-secondary btn-sm">↓ ' +
          escapeHtml(String(tLabel)) +
          "</a>"
      }
    })
    html += '<button type="button" class="btn btn-secondary btn-sm" onclick="inspectJob(' + s.id + ')">Inspect</button>'
    html += "</div>"
    return html
  }

  
  function renderSubtitleRow(s, langMap, nested) {
    var tp = targetProgressHtml(s, langMap)
    var pct =
      tp.totalChunks > 0 ? Math.round((tp.doneChunks / tp.totalChunks) * 100) : s.status === "completed" ? 100 : 0
    var failedPct = tp.totalChunks > 0 ? Math.round((tp.failedChunks / tp.totalChunks) * 100) : 0
    if (pct + failedPct > 100) failedPct = 100 - pct
    var whisperActive = s.source === "whisper" && s.whisperTranscriptionStatus && s.whisperTranscriptionStatus !== "transcription_completed"
    var whisperProgress = Math.max(0, Math.min(100, Math.round(parseFloat(s.whisperProgress) || 0)))
    var barRemaining = Math.max(0, tp.totalChunks - tp.doneChunks - tp.failedChunks)
    var barTitle = whisperActive
      ? "Whisper transcription in progress"
      : tp.doneChunks + " completed, " + tp.failedChunks + " failed, " + barRemaining + " remaining"
    var statusClass =
      s.status === "completed"
        ? "badge-success"
        : s.status === "cancelled"
          ? "badge-error"
          : s.whisperTranscriptionStatus === "transcription_failed"
            ? "badge-error"
            : "badge-processing"
    var statusLabel = s.status === "completed"
      ? "Done"
      : s.status === "cancelled"
        ? "Cancelled"
        : s.whisperTranscriptionStatus
          ? (APP_STRINGS["whisperStatus_" + s.whisperTranscriptionStatus] || s.whisperTranscriptionStatus)
          : "Processing"
    var isActive = s.status !== "completed" && s.status !== "cancelled"
    var titleLabel = escapeHtml(s.name)
    if (s.season) titleLabel += " <small>S" + pad(s.season) + (s.episode ? "E" + pad(s.episode) : "") + "</small>"

    var canMove = !nested && isActive && !whisperActive && (typeof CAN_STOP === "undefined" || CAN_STOP)
    var moveHtml = ""
    if (canMove) {
      moveHtml += '<div class="acc-inline-actions">'
      moveHtml += '<form method="POST" action="/dashboard/move-up/' + s.id + '" style="display:inline">'
      moveHtml += '<button type="submit" class="btn btn-icon btn-xs" title="Move up">↑</button></form>'
      moveHtml += '<form method="POST" action="/dashboard/move-down/' + s.id + '" style="display:inline">'
      moveHtml += '<button type="submit" class="btn btn-icon btn-xs" title="Move down">↓</button></form>'
      moveHtml += "</div>"
    }

    var itemClass = "accordion-item" + (nested ? " acc-nested" : "")
    var headerClass = "accordion-header acc-sub-header" + (nested ? " acc-nested-header" : "")
    var bodyId = "acc-body-sub-" + s.id

    var html = '<div class="' + itemClass + '"' + (!nested && canMove ? ' data-draggable' : '') + '>'
    html += '<div class="' + headerClass + '" data-sub-id="' + s.id + '">'
    html += '<div class="acc-header-left">'
    if (!nested) html += posterThumb(s.mediaItemId)
    html += '<div class="accordion-header-info">'
    html += '<span class="accordion-title">' + titleLabel + "</span>"
    html += '<span class="badge ' + statusClass + '">' + statusLabel + "</span>"
    html += "</div></div>"
    var whisperPct = whisperActive ? whisperProgress : pct
    // Always determinate — no back-and-forth indeterminate animation for Whisper.
    html += '<div class="accordion-progress">' + segmentedBar(whisperPct, whisperActive ? 0 : failedPct, barTitle, false) + '<span class="progress-label">' + (whisperActive ? whisperProgress + "%" : pct + "%") + "</span></div>"
    html += moveHtml
    if (!nested && canMove) html += '<span class="acc-drag-handle" title="Drag to reorder">⠿</span>'
    html += '<span class="accordion-chevron">›</span>'
    html += "</div>"
    html += '<div class="accordion-body" id="' + bodyId + '">'
    // While transcribing, show one "Whispering" progress row instead of the
    // per-target-language placeholder rows (translation can't start until done).
    var targetsHtml = whisperActive ? whisperProgressRow(whisperProgress) : tp.html
    html += '<div class="accordion-targets">' + targetsHtml + "</div>"
    html += subtitleBodyActions(s, langMap)
    html += "</div></div>"
    return html
  }

  
  function renderSeriesGroup(group, langMap) {
    var totalChunks = 0,
      doneChunks = 0,
      failedChunks = 0
    group.items.forEach(function (s) {
      ;(s.targets || []).forEach(function (t) {
        totalChunks += t.total
        doneChunks += t.done
        failedChunks += (t.failed || 0)
      })
    })
    var allDone = group.items.every(function (s) {
      return s.status === "completed" || s.status === "cancelled"
    })
    var pct = totalChunks > 0 ? Math.round((doneChunks / totalChunks) * 100) : allDone ? 100 : 0
    var sFailedPct = totalChunks > 0 ? Math.round((failedChunks / totalChunks) * 100) : 0
    if (pct + sFailedPct > 100) sFailedPct = 100 - pct
    var sRemaining = Math.max(0, totalChunks - doneChunks - failedChunks)
    var sBarTitle = doneChunks + " completed, " + failedChunks + " failed, " + sRemaining + " remaining"
    var statusClass = allDone ? "badge-success" : "badge-processing"
    var statusLabel = allDone ? "Done" : pct + "%"
    var isActive = !allDone

    var moveHtml = ""
    if (isActive && group.mediaItemId && (typeof CAN_STOP === "undefined" || CAN_STOP)) {
      moveHtml += '<div class="acc-inline-actions">'
      moveHtml +=
        '<form method="POST" action="/dashboard/move-series-up/' + group.mediaItemId + '" style="display:inline">'
      moveHtml += '<button type="submit" class="btn btn-icon btn-xs" title="Move up">↑</button></form>'
      moveHtml +=
        '<form method="POST" action="/dashboard/move-series-down/' + group.mediaItemId + '" style="display:inline">'
      moveHtml += '<button type="submit" class="btn btn-icon btn-xs" title="Move down">↓</button></form>'
      moveHtml += "</div>"
    }

    var sortedItems = group.items.slice().sort(function (a, b) {
      return (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0)
    })
    var episodesHtml = sortedItems
      .map(function (s) {
        return renderSubtitleRow(s, langMap, true)
      })
      .join("")

    var key = group.key
    var bodyId = "acc-body-series-" + key

    var html = '<div class="accordion-item" data-draggable>'
    html +=
      '<div class="accordion-header acc-series-header" data-series-key="' +
      key +
      '" data-media-item-id="' +
      (group.mediaItemId || "") +
      '">'
    html += '<div class="acc-header-left">'
    html += posterThumb(group.mediaItemId)
    html += '<div class="accordion-header-info">'
    html += '<span class="accordion-title">' + escapeHtml(group.title) + "</span>"
    html += '<span class="badge ' + statusClass + '">' + statusLabel + "</span>"
    html +=
      '<span class="text-dim" style="font-size:.8rem">' +
      group.items.length +
      " episode" +
      (group.items.length !== 1 ? "s" : "") +
      "</span>"
    html += "</div></div>"
    html += '<div class="accordion-progress">' + segmentedBar(pct, sFailedPct, sBarTitle) + '<span class="progress-label">' + pct + "%</span></div>"
    html += moveHtml
    html += '<span class="acc-drag-handle" title="Drag to reorder">⠿</span>'
    html += '<span class="accordion-chevron">›</span>'
    html += "</div>"
    html += '<div class="accordion-body" id="' + bodyId + '">' + episodesHtml + "</div>"
    html += "</div>"
    return html
  }

  
  function renderQueue(data) {
    var subtitles = data.subtitles || []
    var langMap = data.languageMap || (typeof LANGUAGE_MAP !== "undefined" ? LANGUAGE_MAP : {})

    if (subtitles.length === 0) {
      queueList.innerHTML = '<p class="empty-state">No subtitle jobs yet. Add a .srt file to get started.</p>'
      return
    }

        var seriesGroupMap = {}
    subtitles.forEach(function (s) {
      if (!s.season) return
      var key = s.mediaItemId != null ? "m" + s.mediaItemId : "n" + s.name
      if (!seriesGroupMap[key]) {
        seriesGroupMap[key] = {
          key: key,
          mediaItemId: s.mediaItemId,
          title: s.mediaItemTitle || s.name,
          items: [],
          minOrder: Infinity,
        }
      }
      seriesGroupMap[key].items.push(s)
      var ord = s.orderNumber || 0
      if (ord < seriesGroupMap[key].minOrder) seriesGroupMap[key].minOrder = ord
    })

        var entries = []
    var seenSeries = {}
    subtitles.forEach(function (s) {
      if (!s.season) {
        entries.push({ type: "movie", sub: s, order: s.orderNumber || 0 })
      } else {
        var key = s.mediaItemId != null ? "m" + s.mediaItemId : "n" + s.name
        if (!seenSeries[key]) {
          seenSeries[key] = true
          entries.push({ type: "series", group: seriesGroupMap[key], order: seriesGroupMap[key].minOrder })
        }
      }
    })
    entries.sort(function (a, b) {
      return a.order - b.order
    })

    var html = ""
    entries.forEach(function (entry) {
      if (entry.type === "movie") {
        html += renderSubtitleRow(entry.sub, langMap, false)
      } else {
        html += renderSeriesGroup(entry.group, langMap)
      }
    })

    queueList.innerHTML = html

        queueList.querySelectorAll(".acc-sub-header[data-sub-id]").forEach(function (header) {
      header.addEventListener("click", function (e) {
        if (e.target.closest(".acc-inline-actions")) return
        var id = parseInt(this.dataset.subId)
        var body = document.getElementById("acc-body-sub-" + id)
        if (!body) return
        openSubs[id] = !openSubs[id]
        body.classList.toggle("open", !!openSubs[id])
        this.querySelector(".accordion-chevron").style.transform = openSubs[id] ? "rotate(90deg)" : ""
      })
    })
    queueList.querySelectorAll(".acc-series-header[data-series-key]").forEach(function (header) {
      header.addEventListener("click", function (e) {
        if (e.target.closest(".acc-inline-actions")) return
        var key = this.dataset.seriesKey
        var body = document.getElementById("acc-body-series-" + key)
        if (!body) return
        openSeries[key] = !openSeries[key]
        body.classList.toggle("open", !!openSeries[key])
        this.querySelector(".accordion-chevron").style.transform = openSeries[key] ? "rotate(90deg)" : ""
      })
    })

        Object.keys(openSubs).forEach(function (id) {
      if (openSubs[id]) {
        var body = document.getElementById("acc-body-sub-" + id)
        if (body) {
          body.classList.add("open")
          var header = queueList.querySelector('.acc-sub-header[data-sub-id="' + id + '"] .accordion-chevron')
          if (header) header.style.transform = "rotate(90deg)"
        }
      }
    })
    Object.keys(openSeries).forEach(function (key) {
      if (openSeries[key]) {
        var body = document.getElementById("acc-body-series-" + key)
        if (body) {
          body.classList.add("open")
          var header = queueList.querySelector('.acc-series-header[data-series-key="' + key + '"] .accordion-chevron')
          if (header) header.style.transform = "rotate(90deg)"
        }
      }
    })

        setupDragDrop(queueList)
  }

  
  var dragSrcEl = null

  function setupDragDrop(container) {
    if ("ontouchstart" in window) return

    container.querySelectorAll(".accordion-item[data-draggable]").forEach(function (item) {
      item.setAttribute("draggable", "true")

      item.addEventListener("dragstart", function (e) {
        dragSrcEl = item
        e.dataTransfer.effectAllowed = "move"
        setTimeout(function () { item.classList.add("dragging") }, 0)
      })

      item.addEventListener("dragend", function () {
        item.classList.remove("dragging")
        container.querySelectorAll(".drag-over").forEach(function (el) { el.classList.remove("drag-over") })
        dragSrcEl = null
      })

      item.addEventListener("dragover", function (e) {
        e.preventDefault()
        e.dataTransfer.dropEffect = "move"
        if (dragSrcEl && dragSrcEl !== item) item.classList.add("drag-over")
      })

      item.addEventListener("dragleave", function () {
        item.classList.remove("drag-over")
      })

      item.addEventListener("drop", function (e) {
        e.preventDefault()
        item.classList.remove("drag-over")
        if (!dragSrcEl || dragSrcEl === item) return

                var parent = item.parentNode
        var srcIdx = Array.from(parent.children).indexOf(dragSrcEl)
        var dstIdx = Array.from(parent.children).indexOf(item)
        if (srcIdx < dstIdx) parent.insertBefore(dragSrcEl, item.nextSibling)
        else parent.insertBefore(dragSrcEl, item)

                var allIds = []
        container.querySelectorAll(".accordion-item[data-draggable]").forEach(function (el) {
          el.querySelectorAll("[data-sub-id]").forEach(function (h) {
            allIds.push(parseInt(h.dataset.subId))
          })
        })

        fetch("/dashboard/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderedIds: allIds }),
        }).catch(function () {})
      })
    })
  }

  function renderLogs(logs) {
    var logPanel = document.getElementById("log-panel")
    var logCount = document.getElementById("log-count")
    if (!logPanel) return
    if (logCount) logCount.textContent = "Last " + logs.length + " entries"

    if (logs.length === 0) {
      logPanel.innerHTML = '<p class="text-dim" style="padding:.5rem">No log entries yet.</p>'
      return
    }
    var html = ""
    logs.forEach(function (log) {
      html += '<div class="log-entry">'
      html += '<span class="log-time">' + escapeHtml(formatLocalTime(log.createdAt)) + "</span>"
      html += '<span class="log-msg">' + escapeHtml(log.message) + "</span>"
      html += "</div>"
    })
    logPanel.innerHTML = html
  }

  function updateWorkerButtons(paused) {
    var stopBtn = document.getElementById("worker-stop-btn")
    var startBtn = document.getElementById("worker-start-btn")
    if (!stopBtn || !startBtn) return
    stopBtn.style.display = paused ? "none" : "inline-flex"
    startBtn.style.display = paused ? "inline-flex" : "none"
  }

  function poll() {
    fetch("/dashboard/poll")
      .then(function (r) {
        if (redirectIfUnauthorized(r)) return null
        return r.json()
      })
      .then(function (data) {
        if (!data) return
        renderQueue(data)
        renderLogs(data.logs || [])
        updateWorkerButtons(!!data.workerPaused)
      })
      .catch(function () {})
  }

  poll()
  setInterval(poll, POLL_INTERVAL)
})()

function workerControl(action) {
  var stopBtn = document.getElementById("worker-stop-btn")
  var startBtn = document.getElementById("worker-start-btn")
  var btn = action === "pause" ? stopBtn : startBtn
  if (btn) {
    btn.disabled = true
  }

  fetch("/dashboard/worker/" + action, { method: "POST" })
    .then(function (r) {
      return r.json()
    })
    .then(function (data) {
      if (stopBtn) stopBtn.disabled = false
      if (startBtn) startBtn.disabled = false
      if (typeof data.workerPaused !== "undefined") {
        stopBtn && (stopBtn.style.display = data.workerPaused ? "none" : "inline-flex")
        startBtn && (startBtn.style.display = data.workerPaused ? "inline-flex" : "none")
      }
    })
    .catch(function () {
      if (stopBtn) stopBtn.disabled = false
      if (startBtn) startBtn.disabled = false
    })
}

function inspectJob(id) {
  var modal = document.getElementById("inspect-modal")
  var body = document.getElementById("inspect-body")
  var title = document.getElementById("inspect-title")
  if (!modal || !body) return

  body.innerHTML = '<p style="padding:.75rem;color:var(--text-dim)">Loading…</p>'
  openModal("inspect-modal")

  fetch("/dashboard/inspect/" + id)
    .then(function (r) { return r.json() })
    .then(function (data) {
      if (data.error) {
        body.innerHTML = '<p class="empty-state">' + escapeHtml(data.error) + "</p>"
        return
      }
      var s = data.subtitle
      var srcLang = s.sourceLang
      if (title)
        title.innerHTML = escapeHtml(s.name) + (srcLang ? ' — ' + (srcLang.flagCode ? '<span class="fi fi-' + srcLang.flagCode + '"></span> ' : '') + srcLang.iso639.toUpperCase() : '')

      var statusLabels = { queued: "Queued", running: "Running", completed: "Done", failed: "Failed", cancelled: "Cancelled", retrying: "Retrying", waiting_for_judge: "Waiting" }
      var statusBadge = { queued: "badge-neutral", running: "badge-processing", completed: "badge-success", failed: "badge-error", cancelled: "badge-neutral", retrying: "badge-processing", waiting_for_judge: "badge-processing" }

      var html = ""

      // While a Whisper subtitle is still transcribing there are no translation
      // chunks yet — show how far the transcription has progressed along the
      // audio timeline (latest timestamp / total duration).
      if (s.source === "whisper" && s.whisperTranscriptionStatus && s.whisperTranscriptionStatus !== "transcription_completed") {
        var wPct = Math.max(0, Math.min(100, Math.round(parseFloat(s.whisperProgress) || 0)))
        var wPos = parseInt(s.whisperPositionMs, 10) || 0
        var wDur = parseInt(s.whisperDurationMs, 10) || 0
        var wLabel = (typeof APP_STRINGS !== "undefined" && APP_STRINGS.whispering) || "Whispering"
        var wTime = wDur > 0 ? msToClock(wPos) + " / " + msToClock(wDur) : msToClock(wPos)
        html += '<div style="margin-bottom:1.5rem">'
        html += '<div style="font-weight:600;margin-bottom:.5rem">' + wLabel + (s.whisperModel ? " — " + escapeHtml(s.whisperModel) : "") + "</div>"
        html += '<div class="progress-bar"><div class="progress-fill" style="width:' + wPct + '%"></div></div>'
        html += '<span class="progress-label" style="display:block;margin-top:.4rem">' + escapeHtml(wTime) + " (" + wPct + "%)</span>"
        html += "</div>"
      }

      ;(data.perJob || []).forEach(function (pj) {
        var langLabel = pj.lang ? (pj.lang.flagCode ? '<span class="fi fi-' + pj.lang.flagCode + '"></span> ' : '') + pj.lang.iso639.toUpperCase() : 'Unknown'
        var pct = pj.total > 0 ? Math.round((pj.done / pj.total) * 100) : 0

        html += '<div style="margin-bottom:1.5rem">'
        html += '<div style="font-weight:600;margin-bottom:.5rem">' + langLabel + " — " + pj.job.status + "</div>"
        html += '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>'
        html += '<span class="progress-label" style="display:block;margin-bottom:.75rem">' + pj.done + "/" + pj.total + " chunks (" + pct + "%)</span>"
        html += '<div style="overflow-x:auto">'
        html += '<table style="width:100%;border-collapse:collapse;font-size:.85rem">'
        html += '<thead><tr style="border-bottom:1px solid var(--border);text-align:left">'
        html += '<th style="padding:.4rem .6rem;white-space:nowrap">#</th>'
        html += '<th style="padding:.4rem .6rem;white-space:nowrap">Status</th>'
        html += '<th style="padding:.4rem .6rem;white-space:nowrap">Started At</th>'
        html += '<th style="padding:.4rem .6rem;white-space:nowrap">Finished At</th>'
        html += '<th style="padding:.4rem .6rem;white-space:nowrap">Duration</th>'
        html += '<th style="padding:.4rem .6rem;white-space:nowrap">Actions</th>'
        html += '</tr></thead><tbody>'
        ;(pj.chunks || []).forEach(function (c) {
          var badge = statusBadge[c.status] || "badge-neutral"
          var label = statusLabels[c.status] || c.status
          var startedAt = c.startedAt ? formatLocalTime(c.startedAt) : '<span class="text-dim">—</span>'
          var finishedAt = c.finishedAt ? formatLocalTime(c.finishedAt) : '<span class="text-dim">—</span>'
          var duration = c.durationMs != null ? (c.durationMs / 1000).toFixed(1) + "s" : '<span class="text-dim">—</span>'
          html += '<tr style="border-bottom:1px solid var(--border)">'
          html += '<td style="padding:.35rem .6rem">' + (c.chunkIndex + 1) + '</td>'
          html += '<td style="padding:.35rem .6rem"><span class="badge ' + badge + '">' + label + '</span>'
          if (c.retryCount > 0) html += ' <span class="text-dim" style="font-size:.75rem">×' + c.retryCount + '</span>'
          html += '</td>'
          html += '<td style="padding:.35rem .6rem;white-space:nowrap">' + startedAt + '</td>'
          html += '<td style="padding:.35rem .6rem;white-space:nowrap">' + finishedAt + '</td>'
          html += '<td style="padding:.35rem .6rem;white-space:nowrap">' + duration + '</td>'
          html += '<td style="padding:.35rem .6rem"><button class="btn btn-secondary btn-sm" onclick="resetChunk(' + c.id + ',' + id + ')">Reset</button></td>'
          html += '</tr>'
        })
        html += '</tbody></table></div></div>'
      })

      body.innerHTML = html || '<p class="empty-state">No chunk data.</p>'
    })
    .catch(function (e) {
      body.innerHTML = '<p class="empty-state">Failed to load: ' + escapeHtml(e.message) + "</p>"
    })
}

function retryChunk(chunkId, subtitleId) {
  fetch("/dashboard/retry-chunk/" + chunkId, { method: "POST" })
    .then(function (r) { return r.json() })
    .then(function (data) {
      if (data.error) { alert("Retry failed: " + data.error); return }
      inspectJob(subtitleId)
    })
    .catch(function (e) { alert("Retry failed: " + e.message) })
}

function resetChunk(chunkId, subtitleId) {
  fetch("/dashboard/reset-chunk/" + chunkId, { method: "POST" })
    .then(function (r) { return r.json() })
    .then(function (data) {
      if (data.error) { alert("Reset failed: " + data.error); return }
      inspectJob(subtitleId)
    })
    .catch(function (e) { alert("Reset failed: " + e.message) })
}

function openPasswordModal(userId, username) {
  var form = document.getElementById("pw-form")
  var label = document.getElementById("pw-username")
  if (!form || !label) return

  form.action = "/users/change-password/" + userId
  label.textContent = username
  document.getElementById("pw-password").value = ""
  document.getElementById("pw-password2").value = ""
  var errEl = document.getElementById("pw-error")
  if (errEl) {
    errEl.textContent = ""
    errEl.style.display = "none"
  }

  openModal("pw-modal")
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function pad(n) {
  return n < 10 ? "0" + n : String(n)
}

// Format milliseconds as m:ss (or h:mm:ss) for the Whisper transcription timeline.
function msToClock(ms) {
  ms = Math.max(0, Math.floor(ms))
  var totalSec = Math.floor(ms / 1000)
  var h = Math.floor(totalSec / 3600)
  var m = Math.floor((totalSec % 3600) / 60)
  var sec = totalSec % 60
  return (h > 0 ? h + ":" + pad(m) : String(m)) + ":" + pad(sec)
}

function formatLocalTime(utcStr) {
  if (!utcStr) return "—"
  var d = new Date(utcStr.replace(" ", "T") + "Z")
  if (isNaN(d.getTime())) return utcStr
  return d.toLocaleString()
}

;(function () {
  var COLLAPSED_KEY = "sidebar_collapsed"
  var MOBILE_BREAKPOINT = 768

  function isMobile() {
    return window.innerWidth <= MOBILE_BREAKPOINT
  }

    if (!isMobile() && localStorage.getItem(COLLAPSED_KEY) === "1") {
    document.body.classList.add("sidebar-collapsed")
  }

  var toggleBtn = document.getElementById("sidebarToggleBtn")
  var hamburgerBtn = document.getElementById("hamburgerBtn")
  var overlay = document.getElementById("sidebarOverlay")

  if (toggleBtn) {
    toggleBtn.addEventListener("click", function () {
      if (isMobile()) return
      var collapsed = document.body.classList.toggle("sidebar-collapsed")
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0")
    })
  }

  function openMobileSidebar() {
    document.body.classList.add("sidebar-mobile-open")
    if (overlay) overlay.classList.add("open")
  }

  function closeMobileSidebar() {
    document.body.classList.remove("sidebar-mobile-open")
    if (overlay) overlay.classList.remove("open")
  }

  if (hamburgerBtn) {
    hamburgerBtn.addEventListener("click", openMobileSidebar)
  }

  if (overlay) {
    overlay.addEventListener("click", closeMobileSidebar)
  }

    window.addEventListener("resize", function () {
    if (!isMobile()) {
      closeMobileSidebar()
    }
  })
})()

