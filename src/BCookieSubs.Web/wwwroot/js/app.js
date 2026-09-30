function redirectIfUnauthorized(response) {
  if (response && response.status === 401) {
    var next = encodeURIComponent(location.pathname + location.search)
    location.href = "/login?next=" + next
    return true
  }
  return false
}

function csrfToken() {
  var input = document.querySelector('input[name="__RequestVerificationToken"]')
  return input ? input.value : ""
}

function csrfHeaders(extra) {
  var headers = extra || {}
  headers["RequestVerificationToken"] = csrfToken()
  return headers
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
      alert("Please select a subtitle file.")
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
    fd.append("__RequestVerificationToken", csrfToken())

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
  var whisperQueueList = document.getElementById("whisper-queue-list")
  var ocrQueueList = document.getElementById("ocr-queue-list")
  var whisperSeparate = false

  var openSubs = {}
  var openSeries = {}
  var whisperOpenSubs = {}
  var whisperOpenSeries = {}

  var ocrOpenSeries = {}

  var selectMode = false
  var selectedSubs = {}
  var selectedJobs = {}
  var lastPollData = null

  function bulkSelectedSubCount() { return Object.keys(selectedSubs).length }
  function bulkSelectedJobCount() { return Object.keys(selectedJobs).length }

  function updateBulkBar() {
    var bar = document.getElementById("dsh-bulk-bar")
    var countEl = document.getElementById("dsh-bulk-count")
    if (!bar || !countEl) return
    var total = bulkSelectedSubCount() + bulkSelectedJobCount()
    if (!selectMode || total === 0) {
      bar.style.display = "none"
      return
    }
    bar.style.display = ""
    var sel = (typeof APP_STRINGS !== "undefined" && APP_STRINGS.selected) || "selected"
    countEl.textContent = total + " " + sel
  }

  function clearBulkSelection() {
    selectedSubs = {}
    selectedJobs = {}
    document.querySelectorAll(".dsh-bulk-sub-cb, .dsh-bulk-job-cb").forEach(function (cb) {
      cb.checked = false
    })
    updateBulkBar()
  }

  function toggleSelectMode() {
    selectMode = !selectMode
    if (!selectMode) {
      selectedSubs = {}
      selectedJobs = {}
    }
    var btn = document.getElementById("dsh-select-btn")
    if (btn) {
      btn.textContent = selectMode
        ? ((typeof APP_STRINGS !== "undefined" && APP_STRINGS.doneSelect) || "Done")
        : ((typeof APP_STRINGS !== "undefined" && APP_STRINGS.select) || "Select")
    }
    var bar = document.getElementById("dsh-bulk-bar")
    if (bar) bar.style.display = selectMode && (bulkSelectedSubCount() + bulkSelectedJobCount()) > 0 ? "" : "none"
    if (lastPollData) safeRender("queue", function () { renderQueue(lastPollData) })
  }

  function toggleSubSelect(subId, name, checked) {
    if (checked) selectedSubs[subId] = name
    else delete selectedSubs[subId]
    updateBulkBar()
  }

  function toggleJobSelect(jobId, label, checked) {
    if (checked) selectedJobs[jobId] = label
    else delete selectedJobs[jobId]
    updateBulkBar()
  }

  function openBulkConfirm() {
    var subIds = Object.keys(selectedSubs).map(Number)
    var jobIds = Object.keys(selectedJobs).map(Number)
    if (subIds.length === 0 && jobIds.length === 0) return

    var list = document.getElementById("bulk-confirm-list")
    var summary = document.getElementById("bulk-confirm-summary")
    if (!list || !summary) return
    list.innerHTML = ""
    subIds.forEach(function (id) {
      var li = document.createElement("li")
      li.textContent = selectedSubs[id] || ("Subtitle #" + id)
      list.appendChild(li)
    })
    jobIds.forEach(function (id) {
      var li = document.createElement("li")
      li.textContent = (selectedJobs[id] || ("Job #" + id)) + "  ·  " + ((typeof APP_STRINGS !== "undefined" && APP_STRINGS.bulkJobs) || "job")
      list.appendChild(li)
    })

    var mode = (typeof DELETE_NOT_CANCEL !== "undefined" && DELETE_NOT_CANCEL) ? "delete" : "cancel"
    var lines = []
    if (mode === "delete") {
      lines.push((typeof APP_STRINGS !== "undefined" && APP_STRINGS.bulkActiveWillDelete) || "Active items will be deleted.")
    } else {
      lines.push((typeof APP_STRINGS !== "undefined" && APP_STRINGS.bulkActiveWillCancel) || "Active items will be cancelled.")
    }
    lines.push((typeof APP_STRINGS !== "undefined" && APP_STRINGS.bulkCancelledWillDelete) || "Cancelled items will be deleted.")
    summary.textContent = lines.join(" ")

    openModal("bulk-confirm-modal")
  }

  function submitBulkAction() {
    var subIds = Object.keys(selectedSubs).map(Number)
    var jobIds = Object.keys(selectedJobs).map(Number)
    var submitBtn = document.getElementById("bulk-confirm-submit")
    if (submitBtn) submitBtn.disabled = true
    fetch("/dashboard/bulk", {
      method: "POST",
      headers: csrfHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ subtitleIds: subIds, jobIds: jobIds }),
    })
      .then(function (r) { return r.json() })
      .then(function () {
        selectedSubs = {}
        selectedJobs = {}
        selectMode = false
        var btn = document.getElementById("dsh-select-btn")
        if (btn) btn.textContent = (typeof APP_STRINGS !== "undefined" && APP_STRINGS.select) || "Select"
        closeModal("bulk-confirm-modal")
        var bar = document.getElementById("dsh-bulk-bar")
        if (bar) bar.style.display = "none"
        if (submitBtn) submitBtn.disabled = false
        poll()
      })
      .catch(function () {
        if (submitBtn) submitBtn.disabled = false
      })
  }

  window.toggleSelectMode = toggleSelectMode
  window.clearBulkSelection = clearBulkSelection
  window.openBulkConfirm = openBulkConfirm
  window.submitBulkAction = submitBulkAction


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
      if (selectMode && t.jobId != null) {
        var jobLabel = (s.name || "") + (s.season ? " S" + pad(s.season) + (s.episode ? "E" + pad(s.episode) : "") : "") + " · " + tLangCode
        html +=
          '<span class="dsh-bulk-cb-wrap"><input type="checkbox" class="dsh-bulk-job-cb" data-job-id="' +
          t.jobId + '" data-name="' + escapeHtml(jobLabel) + '"' +
          (selectedJobs[t.jobId] ? " checked" : "") + "></span>"
      }
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
    if (s.status === "cancelled" && (typeof CAN_STOP === "undefined" || CAN_STOP)) {
      html += '<form method="POST" action="/dashboard/requeue/' + s.id + '" style="display:inline">'
      html += '<button type="submit" class="btn btn-icon" title="Re-add to queue">↻</button></form>'
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


  function renderSubtitleRow(s, langMap, nested, queueType) {
    var qType = queueType || "translation"
    var moveBase = qType === "whisper" ? "/dashboard/whisper" : "/dashboard"
    var tp = targetProgressHtml(s, langMap)
    var pct =
      tp.totalChunks > 0 ? Math.round((tp.doneChunks / tp.totalChunks) * 100) : s.status === "completed" ? 100 : 0
    var failedPct = tp.totalChunks > 0 ? Math.round((tp.failedChunks / tp.totalChunks) * 100) : 0
    if (pct + failedPct > 100) failedPct = 100 - pct
    var whisperActive = s.source === "whisper" && s.whisperTranscriptionStatus && s.whisperTranscriptionStatus !== "transcription_completed"
    var whisperTranscribing = s.whisperTranscriptionStatus === "transcribing"
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

    var canMove = !nested && isActive && !whisperTranscribing && (typeof CAN_STOP === "undefined" || CAN_STOP)
    var moveHtml = ""
    if (canMove) {
      moveHtml += '<div class="acc-inline-actions">'
      moveHtml += '<form method="POST" action="' + moveBase + "/move-up/" + s.id + '" style="display:inline">'
      moveHtml += '<button type="submit" class="btn btn-icon btn-xs" title="Move up">↑</button></form>'
      moveHtml += '<form method="POST" action="' + moveBase + "/move-down/" + s.id + '" style="display:inline">'
      moveHtml += '<button type="submit" class="btn btn-icon btn-xs" title="Move down">↓</button></form>'
      moveHtml += "</div>"
    }

    var whisperTopHtml = ""
    if (qType === "whisper" && isActive && !whisperTranscribing) {
      whisperTopHtml = '<form method="POST" action="/dashboard/whisper/move-top/' + s.id + '" style="display:inline">'
      whisperTopHtml += '<button type="submit" class="btn btn-icon btn-xs" title="Whisper this next">⤒</button></form>'
    }

    var itemClass = "accordion-item" + (nested ? " acc-nested" : "")
    var headerClass = "accordion-header acc-sub-header" + (nested ? " acc-nested-header" : "")
    var bodyId = "acc-body-sub-" + s.id

    var orderField = qType === "whisper" ? "whisperOrderNumber" : "orderNumber"
    var entryOrder = (s[orderField] != null ? s[orderField] : s.orderNumber) || 0

    var html = '<div class="' + itemClass + '"' +
      (!nested ? ' data-entry-order="' + entryOrder + '"' : "") +
      (!nested && canMove && !selectMode ? ' data-draggable' : '') + '>'
    html += '<div class="' + headerClass + '" data-sub-id="' + s.id + '">'
    html += '<div class="acc-header-left">'
    if (selectMode) {
      var entName = s.name + (s.season ? " S" + pad(s.season) + (s.episode ? "E" + pad(s.episode) : "") : "")
      html +=
        '<span class="dsh-bulk-cb-wrap"><input type="checkbox" class="dsh-bulk-sub-cb" data-sub-id="' +
        s.id + '" data-name="' + escapeHtml(entName) + '"' +
        (selectedSubs[s.id] ? " checked" : "") + "></span>"
    }
    if (!nested) html += posterThumb(s.mediaItemId)
    html += '<div class="accordion-header-info">'
    html += '<span class="accordion-title">' + titleLabel + "</span>"
    html += '<span class="badge ' + statusClass + '">' + statusLabel + "</span>"
    html += "</div></div>"
    var whisperPct = whisperActive ? whisperProgress : pct
    html += '<div class="accordion-progress">' + segmentedBar(whisperPct, whisperActive ? 0 : failedPct, barTitle, false) + '<span class="progress-label">' + (whisperActive ? whisperProgress + "%" : pct + "%") + "</span></div>"
    html += moveHtml
    html += whisperTopHtml
    if (!nested && canMove) html += '<span class="acc-drag-handle" title="Drag to reorder">⠿</span>'
    html += '<span class="accordion-chevron">›</span>'
    html += "</div>"
    html += '<div class="accordion-body" id="' + bodyId + '">'
    var targetsHtml = whisperActive ? whisperProgressRow(whisperProgress) : tp.html
    html += '<div class="accordion-targets">' + targetsHtml + "</div>"
    html += subtitleBodyActions(s, langMap)
    html += "</div></div>"
    return html
  }


  function renderSeriesGroup(group, langMap, queueType) {
    var qType = queueType || "translation"
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
    if (qType === "translation" && isActive && group.mediaItemId && (typeof CAN_STOP === "undefined" || CAN_STOP)) {
      moveHtml += '<div class="acc-inline-actions">'
      moveHtml +=
        '<form method="POST" action="/dashboard/move-series-up/' + group.mediaItemId + '" style="display:inline">'
      moveHtml += '<button type="submit" class="btn btn-icon btn-xs" title="Move up">↑</button></form>'
      moveHtml +=
        '<form method="POST" action="/dashboard/move-series-down/' + group.mediaItemId + '" style="display:inline">'
      moveHtml += '<button type="submit" class="btn btn-icon btn-xs" title="Move down">↓</button></form>'
      moveHtml += "</div>"
    }

    var deleteHtml = ""
    if (group.mediaItemId && (typeof CAN_STOP === "undefined" || CAN_STOP)) {
      var seriesMode = (typeof DELETE_NOT_CANCEL !== "undefined" && DELETE_NOT_CANCEL) ? "delete" : "cancel"
      var seriesBtnTitle = seriesMode === "delete" ? "Delete series from this queue" : "Cancel series from this queue"
      var seriesBtnIcon = seriesMode === "delete" ? "🗑" : "🚫"
      deleteHtml += '<div class="acc-inline-actions">'
      deleteHtml +=
        '<form method="POST" action="/dashboard/delete-series/' + group.mediaItemId + '?queue=' + qType + '" style="display:inline" class="lr-series-delete" data-series-title="' +
        escapeHtml(group.title || "") + '" data-media-item-id="' + group.mediaItemId + '" data-queue="' + qType + '" data-mode="' + seriesMode + '">'
      deleteHtml += '<button type="submit" class="btn btn-icon btn-xs btn-danger" title="' + seriesBtnTitle + '">' + seriesBtnIcon + '</button></form>'
      deleteHtml += "</div>"
    }

    var sortedItems = group.items.slice().sort(function (a, b) {
      return (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0)
    })
    var episodesHtml = sortedItems
      .map(function (s) {
        return renderSubtitleRow(s, langMap, true, qType)
      })
      .join("")

    var key = qType + "-" + group.key
    var bodyId = "acc-body-series-" + key

    var html = '<div class="accordion-item" data-entry-order="' + (group.minOrder === Infinity ? 0 : group.minOrder) + '" data-draggable>'
    html +=
      '<div class="accordion-header acc-series-header" data-series-key="' +
      key +
      '" data-media-item-id="' +
      (group.mediaItemId || "") +
      '">'
    html += '<div class="acc-header-left">'
    if (selectMode) {
      var epIds = group.items.map(function (s) { return s.id }).join(",")
      html +=
        '<span class="dsh-bulk-cb-wrap"><input type="checkbox" class="dsh-bulk-series-cb" data-sub-ids="' +
        epIds + '" data-name="' + escapeHtml(group.title || "") + '"' +
        (group.items.every(function (s) { return selectedSubs[s.id] }) ? " checked" : "") + "></span>"
    }
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
    html += deleteHtml
    html += '<span class="acc-drag-handle" title="Drag to reorder">⠿</span>'
    html += '<span class="accordion-chevron">›</span>'
    html += "</div>"
    html += '<div class="accordion-body" id="' + bodyId + '">' + episodesHtml + "</div>"
    html += "</div>"
    return html
  }

  function isWhisperStage(s) {
    return (
      s.source === "whisper" &&
      s.whisperTranscriptionStatus &&
      s.whisperTranscriptionStatus !== "transcription_completed"
    )
  }

  function renderQueueList(container, subtitles, langMap, queueType, subState, seriesState) {
    if (subtitles.length === 0) {
      container.innerHTML = '<p class="empty-state">' + (queueType === "whisper" ? "No whisper jobs queued." : "No subtitle jobs yet. Add a subtitle file to get started.") + "</p>"
      return
    }

    var orderField = queueType === "whisper" ? "whisperOrderNumber" : "orderNumber"

    var seriesGroupMap = {}
    subtitles.forEach(function (s) {
      if (!s || !s.season) return
      var key = s.mediaItemId != null ? "m" + s.mediaItemId : "n" + (s.name || "")
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
      var ord = (s[orderField] != null ? s[orderField] : s.orderNumber) || 0
      if (ord < seriesGroupMap[key].minOrder) seriesGroupMap[key].minOrder = ord
    })

    var entries = []
    var seenSeries = {}
    subtitles.forEach(function (s) {
      if (!s) return
      if (!s.season) {
        entries.push({ type: "movie", sub: s, order: (s[orderField] != null ? s[orderField] : s.orderNumber) || 0 })
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
        html += renderSubtitleRow(entry.sub, langMap, false, queueType)
      } else {
        html += renderSeriesGroup(entry.group, langMap, queueType)
      }
    })

    container.innerHTML = html

    container.querySelectorAll(".acc-sub-header[data-sub-id]").forEach(function (header) {
      header.addEventListener("click", function (e) {
        if (e.target.closest(".acc-inline-actions")) return
        if (e.target.closest(".dsh-bulk-cb-wrap")) return
        var id = parseInt(this.dataset.subId)
        var body = document.getElementById("acc-body-sub-" + id)
        if (!body) return
        subState[id] = !subState[id]
        body.classList.toggle("open", !!subState[id])
        this.querySelector(".accordion-chevron").style.transform = subState[id] ? "rotate(90deg)" : ""
      })
    })
    container.querySelectorAll(".acc-series-header[data-series-key]").forEach(function (header) {
      header.addEventListener("click", function (e) {
        if (e.target.closest(".acc-inline-actions")) return
        if (e.target.closest(".dsh-bulk-cb-wrap")) return
        var key = this.dataset.seriesKey
        var body = document.getElementById("acc-body-series-" + key)
        if (!body) return
        seriesState[key] = !seriesState[key]
        body.classList.toggle("open", !!seriesState[key])
        this.querySelector(".accordion-chevron").style.transform = seriesState[key] ? "rotate(90deg)" : ""
      })
    })

    container.querySelectorAll(".dsh-bulk-sub-cb").forEach(function (cb) {
      cb.addEventListener("change", function () {
        toggleSubSelect(parseInt(this.dataset.subId), this.dataset.name || "", this.checked)
      })
    })
    container.querySelectorAll(".dsh-bulk-job-cb").forEach(function (cb) {
      cb.addEventListener("change", function () {
        toggleJobSelect(parseInt(this.dataset.jobId), this.dataset.name || "", this.checked)
      })
    })
    container.querySelectorAll(".dsh-bulk-series-cb").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var ids = String(this.dataset.subIds || "").split(",").map(function (v) { return parseInt(v) }).filter(function (n) { return !isNaN(n) })
        var name = this.dataset.name || ""
        var checked = this.checked
        ids.forEach(function (id) {
          if (checked) selectedSubs[id] = name
          else delete selectedSubs[id]
          var epCb = container.querySelector('.dsh-bulk-sub-cb[data-sub-id="' + id + '"]')
          if (epCb) epCb.checked = checked
        })
        updateBulkBar()
      })
    })

    container.querySelectorAll("form.lr-series-delete").forEach(function (form) {
      form.addEventListener("submit", function (e) {
        var title = this.getAttribute("data-series-title") || ""
        var mediaItemId = this.getAttribute("data-media-item-id") || ""
        var queue = this.getAttribute("data-queue") || "all"
        if (!confirmDeleteSeries(title, mediaItemId, queue)) e.preventDefault()
      })
    })

    Object.keys(subState).forEach(function (id) {
      if (subState[id]) {
        var body = document.getElementById("acc-body-sub-" + id)
        if (body) {
          body.classList.add("open")
          var header = container.querySelector('.acc-sub-header[data-sub-id="' + id + '"] .accordion-chevron')
          if (header) header.style.transform = "rotate(90deg)"
        }
      }
    })
    Object.keys(seriesState).forEach(function (key) {
      if (seriesState[key]) {
        var body = document.getElementById("acc-body-series-" + key)
        if (body) {
          body.classList.add("open")
          var header = container.querySelector('.acc-series-header[data-series-key="' + key + '"] .accordion-chevron')
          if (header) header.style.transform = "rotate(90deg)"
        }
      }
    })

    if (!selectMode) {
      setupDragDrop(container, queueType === "whisper" ? "/dashboard/whisper/reorder" : "/dashboard/reorder")
    }
  }

  function renderQueue(data) {
    var subtitles = data.subtitles || []
    var langMap = data.languageMap || (typeof LANGUAGE_MAP !== "undefined" ? LANGUAGE_MAP : {})
    whisperSeparate = !!data.whisperSeparate

    var translationSubs = whisperSeparate ? subtitles.filter(function (s) { return !isWhisperStage(s) }) : subtitles
    safeRender("translationQueue", function () {
      renderQueueList(queueList, translationSubs, langMap, "translation", openSubs, openSeries)
    })

    if (whisperQueueList) {
      var whisperSubs = whisperSeparate ? subtitles.filter(isWhisperStage) : []
      whisperQueueList.parentElement.style.display = whisperSeparate && whisperSubs.length > 0 ? "" : "none"
      safeRender("whisperQueue", function () {
        renderQueueList(whisperQueueList, whisperSubs, langMap, "whisper", whisperOpenSubs, whisperOpenSeries)
      })
    }

    if (ocrQueueList) {
      var ocrJobs = data.ocrJobs || []
      ocrQueueList.parentElement.style.display = ocrJobs.length > 0 ? "" : "none"
      safeRender("ocrQueue", function () { renderOcrQueue(ocrJobs) })
    }
  }

  function safeRender(name, fn) {
    try {
      fn()
    } catch (e) {
      if (window.console) console.error("[dashboard] render '" + name + "' failed:", e)
    }
  }

  function ocrStatusLabel(j) {
    return j.status === "processing"
      ? ((typeof APP_STRINGS !== "undefined" && APP_STRINGS.ocrStatus_processing) || "Processing")
      : j.status === "failed"
        ? ((typeof APP_STRINGS !== "undefined" && APP_STRINGS.ocrStatus_failed) || "Failed")
        : ((typeof APP_STRINGS !== "undefined" && APP_STRINGS.ocrStatus_queued) || "Queued")
  }
  function ocrStatusClass(j) {
    return j.status === "processing"
      ? "badge badge-processing"
      : j.status === "failed"
        ? "badge badge-error"
        : "badge badge-neutral"
  }

  function ocrSeriesStatus(group) {
    var anyProcessing = false,
      anyFailed = false,
      anyQueued = false
    group.items.forEach(function (j) {
      if (j.status === "processing") anyProcessing = true
      else if (j.status === "failed") anyFailed = true
      else anyQueued = true
    })
    if (anyProcessing) return { cls: "badge badge-processing", label: (typeof APP_STRINGS !== "undefined" && APP_STRINGS.ocrStatus_processing) || "Processing" }
    if (anyFailed) return { cls: "badge badge-error", label: (typeof APP_STRINGS !== "undefined" && APP_STRINGS.ocrStatus_failed) || "Failed" }
    return { cls: "badge badge-neutral", label: (typeof APP_STRINGS !== "undefined" && APP_STRINGS.ocrStatus_queued) || "Queued" }
  }

  function ocrJobRowHtml(j, nested) {
    if (!j || j.id == null) return ""
    var statusLabel = ocrStatusLabel(j)
    var statusClass = ocrStatusClass(j)
    var title = nested
      ? "S" + pad(j.season) + "E" + pad(j.episode) + (j.name ? " · " + j.name : "")
      : j.name || j.mediaItemTitle || "OCR job #" + j.id
    var progress = j.status === "processing" && j.progress > 0 ? " · " + j.progress + "%" : ""
    var err = j.status === "failed" && j.errorMessage ? '<div class="text-dim" style="font-size:.8rem">⚠ ' + escapeHtml(String(j.errorMessage)) + "</div>" : ""

    var controls = ""
    if (j.status === "queued") {
      controls =
        '<form method="post" action="/dashboard/ocr/move-up/' + j.id + '" style="display:inline"><button class="btn btn-icon" title="Up">↑</button></form>' +
        '<form method="post" action="/dashboard/ocr/move-down/' + j.id + '" style="display:inline"><button class="btn btn-icon" title="Down">↓</button></form>'
    }
    if (j.status === "failed") {
      controls += '<form method="post" action="/dashboard/ocr/retry/' + j.id + '" style="display:inline"><button class="btn btn-secondary" title="Retry">↻</button></form>'
    }
    controls += '<form method="post" action="/dashboard/ocr/delete/' + j.id + '" style="display:inline"><button class="btn btn-icon" title="Remove" onclick="return confirm(\'Remove this OCR job?\')">✕</button></form>'

    return (
      '<div class="ocr-queue-row' + (nested ? " ocr-queue-row-nested" : "") + '" data-ocr-id="' + j.id + '">' +
        '<div class="ocr-queue-row-main">' +
          '<strong>' + escapeHtml(String(title)) + '</strong> ' +
          '<span class="' + statusClass + '">' + escapeHtml(String(statusLabel)) + progress + '</span>' +
          err +
        '</div>' +
        '<div class="ocr-queue-row-controls">' + controls + '</div>' +
      '</div>'
    )
  }

  function ocrSeriesCardHtml(group) {
    var seriesStatus = ocrSeriesStatus(group)
    var epCount = group.items.length
    var hasFailedOrActive = group.items.some(function (j) {
      return j.status === "failed" || j.status === "processing"
    })
    var isOpen = ocrOpenSeries.hasOwnProperty(group.key) ? !!ocrOpenSeries[group.key] : hasFailedOrActive
    var bodyId = "acc-body-ocr-series-" + group.key

    var html = '<div class="accordion-item">'
    html +=
      '<div class="accordion-header acc-series-header" data-series-key="ocr-' + group.key + '">'
    html += '<div class="acc-header-left">'
    html += posterThumb(group.mediaItemId)
    html += '<div class="accordion-header-info">'
    html += '<span class="accordion-title">' + escapeHtml(String(group.title)) + "</span>"
    html += '<span class="' + seriesStatus.cls + '">' + escapeHtml(String(seriesStatus.label)) + "</span>"
    html +=
      '<span class="text-dim" style="font-size:.8rem">' +
      epCount +
      " episode" +
      (epCount !== 1 ? "s" : "") +
      "</span>"
    html += "</div></div>"
    html += '<span class="accordion-chevron">›</span>'
    html += "</div>"
    var bodyHtml = group.items
      .slice()
      .sort(function (a, b) {
        return (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0)
      })
      .map(function (j) {
        return ocrJobRowHtml(j, true)
      })
      .join("")
    html += '<div class="accordion-body' + (isOpen ? " open" : "") + '" id="' + bodyId + '">' + bodyHtml + "</div>"
    html += "</div>"
    return html
  }

  function renderOcrQueue(jobs) {
    if (!ocrQueueList) return
    if (!jobs || !jobs.length) {
      ocrQueueList.innerHTML = '<p class="empty-state">No OCR jobs queued.</p>'
      return
    }

    var seriesMap = {}
    var seriesOrder = []
    var standalone = []
    jobs.forEach(function (j) {
      if (!j || j.id == null) return
      if (j.mediaItemId != null && j.season != null) {
        var key = "m" + j.mediaItemId
        if (!seriesMap[key]) {
          seriesMap[key] = { key: key, mediaItemId: j.mediaItemId, title: j.mediaItemTitle || j.name, items: [] }
          seriesOrder.push(key)
        }
        seriesMap[key].items.push(j)
      } else {
        standalone.push(j)
      }
    })

    var html = ""
    standalone.forEach(function (j) {
      html += ocrJobRowHtml(j, false)
    })
    seriesOrder.forEach(function (key) {
      html += ocrSeriesCardHtml(seriesMap[key])
    })
    ocrQueueList.innerHTML = html

    ocrQueueList.querySelectorAll(".acc-series-header[data-series-key]").forEach(function (header) {
      header.addEventListener("click", function (e) {
        if (e.target.closest("form") || e.target.closest("button")) return
        var rawKey = this.dataset.seriesKey
        var key = rawKey && rawKey.indexOf("ocr-") === 0 ? rawKey.slice(4) : rawKey
        var body = document.getElementById("acc-body-ocr-series-" + key)
        if (!body) return
        ocrOpenSeries[key] = !body.classList.contains("open")
        body.classList.toggle("open", ocrOpenSeries[key])
      })
    })
  }


  var dragSrcEl = null

  function setupDragDrop(container, reorderUrl, onlyEl) {
    if ("ontouchstart" in window) return
    var url = reorderUrl || "/dashboard/reorder"

    var items = onlyEl ? [onlyEl] : Array.prototype.slice.call(container.querySelectorAll(".accordion-item[data-draggable]"))
    items.forEach(function (item) {
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

        fetch(url, {
          method: "POST",
          headers: csrfHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ orderedIds: allIds }),
        }).catch(function () {})
      })
    })
  }

  function logEntryHtml(log) {
    return (
      '<div class="log-entry" data-log-id="' + log.id + '">' +
      '<span class="log-time">' + escapeHtml(formatLocalTime(log.createdAt)) + "</span>" +
      '<span class="log-msg">' + escapeHtml(log.message || "") + "</span>" +
      "</div>"
    )
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
      if (!log) return
      html += logEntryHtml(log)
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

  function updateWhisperWorkerButtons(paused) {
    var stopBtn = document.getElementById("whisper-worker-stop-btn")
    var startBtn = document.getElementById("whisper-worker-start-btn")
    if (!stopBtn || !startBtn) return
    stopBtn.style.display = paused ? "none" : "inline-flex"
    startBtn.style.display = paused ? "inline-flex" : "none"
  }

  function poll() {
    return fetch("/dashboard/poll")
      .then(function (r) {
        if (redirectIfUnauthorized(r)) return null
        return r.json()
      })
      .then(function (data) {
        if (!data) return
        lastPollData = data
        safeRender("queue", function () { renderQueue(data) })
        safeRender("logs", function () { renderLogs(data.logs || []) })
        safeRender("workerButtons", function () { updateWorkerButtons(!!data.workerPaused) })
        safeRender("whisperButtons", function () { updateWhisperWorkerButtons(!!data.whisperWorkerPaused) })
        if (typeof data.deleteNotCancel !== "undefined") {
          window.DELETE_NOT_CANCEL = !!data.deleteNotCancel
        }
      })
      .catch(function (err) {
        if (window.console) console.error("[dashboard] poll failed:", err)
      })
  }

  poll()


  function fromHtml(html) {
    var tpl = document.createElement("template")
    tpl.innerHTML = html.trim()
    return tpl.content.firstChild
  }

  function entryOrderValue(s, queueType) {
    var orderField = queueType === "whisper" ? "whisperOrderNumber" : "orderNumber"
    return (s[orderField] != null ? s[orderField] : s.orderNumber) || 0
  }

  function queueTypeOf(row) {
    return whisperSeparate && isWhisperStage(row) ? "whisper" : "translation"
  }

  function containerFor(queueType) {
    return queueType === "whisper" ? whisperQueueList : queueList
  }

  function subStateFor(queueType) {
    return queueType === "whisper" ? whisperOpenSubs : openSubs
  }

  function seriesStateFor(queueType) {
    return queueType === "whisper" ? whisperOpenSeries : openSeries
  }

  function langMapFor() {
    return (lastPollData && lastPollData.languageMap) || (typeof LANGUAGE_MAP !== "undefined" ? LANGUAGE_MAP : {})
  }

  function visibleRows(queueType) {
    var subs = (lastPollData && lastPollData.subtitles) || []
    if (queueType === "whisper") return subs.filter(isWhisperStage)
    return whisperSeparate ? subs.filter(function (s) { return !isWhisperStage(s) }) : subs.slice()
  }

  function buildGroupModel(rows, queueType) {
    var map = {}
    rows.forEach(function (s) {
      if (!s || !s.season) return
      var key = s.mediaItemId != null ? "m" + s.mediaItemId : "n" + (s.name || "")
      if (!map[key]) {
        map[key] = { key: key, mediaItemId: s.mediaItemId, title: s.mediaItemTitle || s.name, items: [], minOrder: Infinity }
      }
      map[key].items.push(s)
      var ord = entryOrderValue(s, queueType)
      if (ord < map[key].minOrder) map[key].minOrder = ord
    })
    return map
  }

  function groupKeyOf(row) {
    return row.mediaItemId != null ? "m" + row.mediaItemId : "n" + (row.name || "")
  }

  function findTopLevelRow(container, id) {
    for (var i = 0; i < container.children.length; i++) {
      var k = container.children[i]
      if (!k.classList || !k.classList.contains("accordion-item")) continue
      var header = k.querySelector('.acc-sub-header[data-sub-id="' + id + '"]')
      if (header && !header.closest(".accordion-body")) return k
    }
    return null
  }

  function positionTopLevel(container, el, order) {
    var kids = []
    Array.prototype.forEach.call(container.children, function (c) {
      if (c !== el && c.classList && c.classList.contains("accordion-item") && c.hasAttribute("data-entry-order")) {
        kids.push(c)
      }
    })
    for (var i = 0; i < kids.length; i++) {
      if (order < (parseFloat(kids[i].getAttribute("data-entry-order")) || 0)) {
        container.insertBefore(el, kids[i])
        return
      }
    }
    container.appendChild(el)
  }

  function wireQueueEntry(el, queueType) {
    var subState = subStateFor(queueType)
    var seriesState = seriesStateFor(queueType)
    el.querySelectorAll(".acc-sub-header[data-sub-id]").forEach(function (header) {
      header.addEventListener("click", function (e) {
        if (e.target.closest(".acc-inline-actions")) return
        if (e.target.closest(".dsh-bulk-cb-wrap")) return
        var id = parseInt(this.dataset.subId)
        var body = document.getElementById("acc-body-sub-" + id)
        if (!body) return
        subState[id] = !subState[id]
        body.classList.toggle("open", !!subState[id])
        this.querySelector(".accordion-chevron").style.transform = subState[id] ? "rotate(90deg)" : ""
      })
    })
    el.querySelectorAll(".acc-series-header[data-series-key]").forEach(function (header) {
      header.addEventListener("click", function (e) {
        if (e.target.closest(".acc-inline-actions")) return
        if (e.target.closest(".dsh-bulk-cb-wrap")) return
        var key = this.dataset.seriesKey
        var body = document.getElementById("acc-body-series-" + key)
        if (!body) return
        seriesState[key] = !seriesState[key]
        body.classList.toggle("open", !!seriesState[key])
        this.querySelector(".accordion-chevron").style.transform = seriesState[key] ? "rotate(90deg)" : ""
      })
    })
    el.querySelectorAll(".dsh-bulk-sub-cb").forEach(function (cb) {
      cb.addEventListener("change", function () {
        toggleSubSelect(parseInt(this.dataset.subId), this.dataset.name || "", this.checked)
      })
    })
    el.querySelectorAll(".dsh-bulk-job-cb").forEach(function (cb) {
      cb.addEventListener("change", function () {
        toggleJobSelect(parseInt(this.dataset.jobId), this.dataset.name || "", this.checked)
      })
    })
    el.querySelectorAll(".dsh-bulk-series-cb").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var ids = String(this.dataset.subIds || "").split(",").map(function (v) { return parseInt(v) }).filter(function (n) { return !isNaN(n) })
        var name = this.dataset.name || ""
        var checked = this.checked
        ids.forEach(function (id) {
          if (checked) selectedSubs[id] = name
          else delete selectedSubs[id]
          var epCb = el.querySelector('.dsh-bulk-sub-cb[data-sub-id="' + id + '"]')
          if (epCb) epCb.checked = checked
        })
        updateBulkBar()
      })
    })
    el.querySelectorAll("form.lr-series-delete").forEach(function (form) {
      form.addEventListener("submit", function (e) {
        var title = this.getAttribute("data-series-title") || ""
        var mediaItemId = this.getAttribute("data-media-item-id") || ""
        var queue = this.getAttribute("data-queue") || "all"
        if (!confirmDeleteSeries(title, mediaItemId, queue)) e.preventDefault()
      })
    })
    Object.keys(subState).forEach(function (id) {
      if (!subState[id]) return
      var body = document.getElementById("acc-body-sub-" + id)
      if (body && el.contains(body)) {
        body.classList.add("open")
        var chevron = el.querySelector('.acc-sub-header[data-sub-id="' + id + '"] .accordion-chevron')
        if (chevron) chevron.style.transform = "rotate(90deg)"
      }
    })
    Object.keys(seriesState).forEach(function (key) {
      if (!seriesState[key]) return
      var body = document.getElementById("acc-body-series-" + key)
      if (body && el.contains(body)) {
        body.classList.add("open")
        var chevron = el.querySelector('.acc-series-header[data-series-key="' + key + '"] .accordion-chevron')
        if (chevron) chevron.style.transform = "rotate(90deg)"
      }
    })
  }

  function applyRowOpenState(el, id, queueType) {
    var subState = subStateFor(queueType)
    if (!subState[id]) return
    var body = el.querySelector(".accordion-body")
    if (body) {
      body.classList.add("open")
      var chevron = el.querySelector(".acc-sub-header .accordion-chevron")
      if (chevron) chevron.style.transform = "rotate(90deg)"
    }
  }

  function queueContainer(queueType) {
    return queueType === "whisper" ? "/dashboard/whisper/reorder" : "/dashboard/reorder"
  }

  function upsertMovieRow(container, row, queueType) {
    var existing = findTopLevelRow(container, row.id)
    var el = fromHtml(renderSubtitleRow(row, langMapFor(), false, queueType))
    if (existing) {
      existing.replaceWith(el)
    } else {
      var empty = container.querySelector(".empty-state")
      if (empty) empty.remove()
    }
    positionTopLevel(container, el, entryOrderValue(row, queueType))
    wireQueueEntry(el, queueType)
    if (!selectMode) setupDragDrop(container, queueContainer(queueType), el)
    applyRowOpenState(el, row.id, queueType)
  }

  function updateSeriesCardDom(cardEl, group) {
    var totalChunks = 0, doneChunks = 0, failedChunks = 0
    group.items.forEach(function (s) {
      ;(s.targets || []).forEach(function (t) {
        totalChunks += t.total
        doneChunks += t.done
        failedChunks += (t.failed || 0)
      })
    })
    var allDone = group.items.every(function (s) { return s.status === "completed" || s.status === "cancelled" })
    var pct = totalChunks > 0 ? Math.round((doneChunks / totalChunks) * 100) : allDone ? 100 : 0
    var sFailedPct = totalChunks > 0 ? Math.round((failedChunks / totalChunks) * 100) : 0
    if (pct + sFailedPct > 100) sFailedPct = 100 - pct
    var badge = cardEl.querySelector(".acc-series-header .badge")
    if (badge) {
      badge.className = "badge " + (allDone ? "badge-success" : "badge-processing")
      badge.textContent = allDone ? "Done" : pct + "%"
    }
    var count = cardEl.querySelector(".acc-series-header .text-dim")
    if (count) count.textContent = group.items.length + " episode" + (group.items.length !== 1 ? "s" : "")
    var prog = cardEl.querySelector(".accordion-progress")
    if (prog) {
      var sRemaining = Math.max(0, totalChunks - doneChunks - failedChunks)
      prog.innerHTML = segmentedBar(pct, sFailedPct, doneChunks + " completed, " + failedChunks + " failed, " + sRemaining + " remaining") +
        '<span class="progress-label">' + pct + "%</span>"
    }
  }

  function insertEpisodeSorted(body, el, row) {
    var mine = [(row.season || 0), (row.episode || 0)]
    var subs = (lastPollData && lastPollData.subtitles) || []
    var kids = []
    Array.prototype.forEach.call(body.children, function (c) {
      if (c.classList && c.classList.contains("accordion-item")) kids.push(c)
    })
    for (var i = 0; i < kids.length; i++) {
      var header = kids[i].querySelector(".acc-sub-header[data-sub-id]")
      if (!header) continue
      var other = subs.find(function (x) { return x && x.id === parseInt(header.dataset.subId) })
      if (!other) continue
      var o = [(other.season || 0), (other.episode || 0)]
      if (mine[0] < o[0] || (mine[0] === o[0] && mine[1] < o[1])) {
        body.insertBefore(el, kids[i])
        return
      }
    }
    body.appendChild(el)
  }

  function upsertEpisodeRow(container, row, queueType) {
    var key = groupKeyOf(row)
    var model = buildGroupModel(visibleRows(queueType), queueType)
    var group = model[key]
    if (!group) return
    var header = container.querySelector('.acc-series-header[data-series-key="' + queueType + "-" + key + '"]')
    var card = header ? header.closest(".accordion-item") : null
    if (!card) {
      var el = fromHtml(renderSeriesGroup(group, langMapFor(), queueType))
      positionTopLevel(container, el, group.minOrder === Infinity ? 0 : group.minOrder)
      wireQueueEntry(el, queueType)
      if (!selectMode) setupDragDrop(container, queueContainer(queueType), el)
      return
    }
    var body = card.querySelector(".accordion-body")
    if (!body) return
    var existing = body.querySelector('.acc-sub-header[data-sub-id="' + row.id + '"]')
    var el = fromHtml(renderSubtitleRow(row, langMapFor(), true, queueType))
    if (existing) {
      existing.closest(".accordion-item").replaceWith(el)
    } else {
      var empty = body.querySelector(".empty-state")
      if (empty) empty.remove()
      insertEpisodeSorted(body, el, row)
    }
    wireQueueEntry(el, queueType)
    applyRowOpenState(el, row.id, queueType)
    updateSeriesCardDom(card, group)
    card.setAttribute("data-entry-order", group.minOrder === Infinity ? 0 : group.minOrder)
    positionTopLevel(container, card, group.minOrder === Infinity ? 0 : group.minOrder)
  }

  function upsertRowDom(container, row, queueType) {
    if (row.season) upsertEpisodeRow(container, row, queueType)
    else upsertMovieRow(container, row, queueType)
  }

  function removeRowDom(row, queueType) {
    var container = containerFor(queueType)
    if (!container || !row) return
    if (row.season) {
      var key = groupKeyOf(row)
      var header = container.querySelector('.acc-series-header[data-series-key="' + queueType + "-" + key + '"]')
      if (!header) return
      var card = header.closest(".accordion-item")
      var epHeader = card.querySelector('.acc-sub-header[data-sub-id="' + row.id + '"]')
      if (epHeader) epHeader.closest(".accordion-item").remove()
      var group = buildGroupModel(visibleRows(queueType), queueType)[key]
      if (!group || group.items.length === 0) card.remove()
      else updateSeriesCardDom(card, group)
    } else {
      var top = findTopLevelRow(container, row.id)
      if (top) top.remove()
      if (!container.querySelector(".accordion-item")) {
        container.innerHTML = '<p class="empty-state">' + (queueType === "whisper" ? "No whisper jobs queued." : "No subtitle jobs yet. Add a subtitle file to get started.") + "</p>"
      }
    }
  }

  function syncWhisperCardVisibility() {
    if (!whisperQueueList) return
    var n = ((lastPollData && lastPollData.subtitles) || []).filter(isWhisperStage).length
    whisperQueueList.parentElement.style.display = whisperSeparate && n > 0 ? "" : "none"
  }

  function applyQueueRow(id, row) {
    if (!lastPollData) return
    var subs = lastPollData.subtitles || []
    var idx = subs.findIndex(function (s) { return s && s.id === id })
    var oldRow = idx >= 0 ? subs[idx] : null
    if (row) {
      if (idx >= 0) subs[idx] = row
      else subs.push(row)
    } else if (idx >= 0) {
      subs.splice(idx, 1)
    } else {
      return
    }
    safeRender("queue", function () {
      var oldType = oldRow ? queueTypeOf(oldRow) : null
      var newType = row ? queueTypeOf(row) : oldType
      if (oldRow && (!row || oldType !== newType)) removeRowDom(oldRow, oldType)
      if (row) {
        var container = containerFor(newType)
        if (container) upsertRowDom(container, row, newType)
      }
      syncWhisperCardVisibility()
    })
  }

  function applyRowViaHttp(id) {
    fetch("/dashboard/queue-row/" + id)
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (data) {
        if (data && data.row) applyQueueRow(id, data.row)
      })
      .catch(function () {})
  }

  function applyOcrEvent(id, payload) {
    if (!lastPollData || !ocrQueueList) return
    if (id == null) {
      if (!Array.isArray(payload)) return
      lastPollData.ocrJobs = payload
      ocrQueueList.parentElement.style.display = payload.length > 0 ? "" : "none"
      safeRender("ocrQueue", function () { renderOcrQueue(lastPollData.ocrJobs) })
      return
    }
    var jobs = lastPollData.ocrJobs = lastPollData.ocrJobs || []
    var idx = jobs.findIndex(function (j) { return j && j.id === id })
    if (payload) {
      if (idx >= 0) jobs[idx] = payload
      else jobs.push(payload)
    } else if (idx >= 0) {
      jobs.splice(idx, 1)
    } else {
      return
    }
    ocrQueueList.parentElement.style.display = jobs.length > 0 ? "" : "none"
    safeRender("ocrQueue", function () { updateOcrRowDom(id, payload) })
  }

  function updateOcrRowDom(id, row) {
    var existing = ocrQueueList.querySelector('[data-ocr-id="' + id + '"]')
    if (!row) {
      if (!existing) return
      var body = existing.closest(".accordion-body")
      existing.remove()
      if (body) {
        var card = body.closest(".accordion-item")
        if (!body.querySelector(".ocr-queue-row")) card.remove()
        else updateOcrSeriesHeader(card)
      }
      return
    }
    if (row.mediaItemId != null && row.season != null) upsertOcrSeriesRow(id, row)
    else upsertOcrStandaloneRow(id, row, existing)
  }

  function upsertOcrStandaloneRow(id, row, existing) {
    var jobs = (lastPollData && lastPollData.ocrJobs) || []
    var el = fromHtml(ocrJobRowHtml(row, false))
    if (existing) existing.replaceWith(el)
    else {
      var empty = ocrQueueList.querySelector(".empty-state")
      if (empty) empty.remove()
    }
    var myIdx = jobs.findIndex(function (j) { return j && j.id === id })
    for (var i = myIdx - 1; i >= 0; i--) {
      var prior = jobs[i]
      if (!prior || (prior.mediaItemId != null && prior.season != null)) continue
      var priorEl = ocrQueueList.querySelector('[data-ocr-id="' + prior.id + '"]')
      if (priorEl && !priorEl.closest(".accordion-body")) {
        priorEl.after(el)
        return
      }
    }
    ocrQueueList.insertBefore(el, ocrQueueList.firstChild)
  }

  function upsertOcrSeriesRow(id, row) {
    var jobs = (lastPollData && lastPollData.ocrJobs) || []
    var key = "m" + row.mediaItemId
    var header = ocrQueueList.querySelector('.acc-series-header[data-series-key="ocr-' + key + '"]')
    var card = header ? header.closest(".accordion-item") : null
    if (!card) {
      var el = fromHtml(ocrSeriesCardHtml({ key: key, mediaItemId: row.mediaItemId, title: row.mediaItemTitle || row.name, items: jobs.filter(function (j) { return j && j.mediaItemId != null && j.season != null && "m" + j.mediaItemId === key }) }))
      var myIdx = jobs.findIndex(function (j) { return j && j.id === id })
      for (var i = myIdx - 1; i >= 0; i--) {
        var prior = jobs[i]
        if (!prior || prior.mediaItemId == null || prior.season == null) continue
        var priorKey = "m" + prior.mediaItemId
        if (priorKey === key) continue
        var priorEl = ocrQueueList.querySelector('.acc-series-header[data-series-key="ocr-' + priorKey + '"]')
        if (priorEl) { priorEl.closest(".accordion-item").after(el); break }
      }
      if (!el.parentNode) {
        var firstCard = ocrQueueList.querySelector(".acc-series-header")
        if (firstCard) ocrQueueList.insertBefore(el, firstCard.closest(".accordion-item"))
        else ocrQueueList.appendChild(el)
      }
      wireOcrSeriesCard(el, key)
      return
    }
    var body = card.querySelector(".accordion-body")
    if (!body) return
    var existingRow = body.querySelector('[data-ocr-id="' + id + '"]')
    var elRow = fromHtml(ocrJobRowHtml(row, true))
    if (existingRow) existingRow.replaceWith(elRow)
    else {
      var empty = body.querySelector(".empty-state")
      if (empty) empty.remove()
      insertEpisodeSorted(body, elRow, row)
    }
    updateOcrSeriesHeader(card)
  }

  function wireOcrSeriesCard(el, key) {
    var header = el.querySelector(".acc-series-header")
    if (!header) return
    header.addEventListener("click", function (e) {
      if (e.target.closest("form") || e.target.closest("button")) return
      var body = document.getElementById("acc-body-ocr-series-" + key)
      if (!body) return
      ocrOpenSeries[key] = !body.classList.contains("open")
      body.classList.toggle("open", ocrOpenSeries[key])
    })
    var body = el.querySelector(".accordion-body")
    if (body && ocrOpenSeries[key]) body.classList.add("open")
  }

  function updateOcrSeriesHeader(card) {
    var header = card.querySelector(".acc-series-header")
    if (!header) return
    var key = (header.dataset.seriesKey || "").slice(4)
    var jobs = (lastPollData && lastPollData.ocrJobs) || []
    var items = jobs.filter(function (j) { return j && j.mediaItemId != null && j.season != null && "m" + j.mediaItemId === key })
    if (items.length === 0) { card.remove(); return }
    var status = ocrSeriesStatus({ items: items })
    var badge = card.querySelector(".accordion-header .badge")
    if (badge) { badge.className = status.cls; badge.textContent = status.label }
    var count = card.querySelector(".accordion-header .text-dim")
    if (count) count.textContent = items.length + " episode" + (items.length !== 1 ? "s" : "")
  }

  function applyLogEvent(log) {
    var panel = document.getElementById("log-panel")
    if (!panel || !log || log.id == null || !lastPollData) return
    var logs = lastPollData.logs = lastPollData.logs || []
    var idx = logs.findIndex(function (l) { return l && l.id === log.id })
    if (idx >= 0) logs[idx] = log
    else logs.unshift(log)
    if (logs.length > 20) logs.length = 20
    var empty = panel.querySelector("p.text-dim")
    if (empty) empty.remove()
    var existing = panel.querySelector('[data-log-id="' + log.id + '"]')
    var fresh = fromHtml(logEntryHtml(log))
    if (existing) existing.replaceWith(fresh)
    else panel.prepend(fresh)
    while (panel.children.length > 20) panel.lastElementChild.remove()
  }

  function applyQueueCounts(counts) {
    if (!counts) return
    Object.keys(counts).forEach(function (key) {
      var el = document.querySelector('[data-dash-count="' + key + '"]')
      if (el) el.textContent = String(counts[key])
    })
  }

  function connectDashboardHub() {
    if (typeof signalR === "undefined") return
    var conn = new signalR.HubConnectionBuilder()
      .withUrl("/hubs/dashboard")
      .withAutomaticReconnect()
      .build()

    conn.on("translationChanged", function (id, row) {
      if (id == null) return
      if (row === undefined) { applyRowViaHttp(id); return }
      applyQueueRow(id, row)
    })
    conn.on("whisperQueueChanged", function (id, row) {
      if (id == null) return
      if (row === undefined) { applyRowViaHttp(id); return }
      applyQueueRow(id, row)
    })
    conn.on("translationRemoved", function (id) {
      if (id == null || !lastPollData) return
      var subs = lastPollData.subtitles || []
      var idx = subs.findIndex(function (s) { return s && s.id === id })
      if (idx < 0) return
      var oldRow = subs[idx]
      subs.splice(idx, 1)
      safeRender("queue", function () { removeRowDom(oldRow, queueTypeOf(oldRow)) })
      syncWhisperCardVisibility()
    })
    conn.on("ocrQueueChanged", function (id, payload) { applyOcrEvent(id, payload) })
    conn.on("logAdded", function (log) { applyLogEvent(log) })
    conn.on("logUpdated", function (log) { applyLogEvent(log) })
    conn.on("dashboardCountsChanged", function (counts) { applyQueueCounts(counts) })
    conn.on("libraryRequestsChanged", function (counts) {
      document.dispatchEvent(new CustomEvent("bcs:library-requests-changed", { detail: counts }))
    })

    conn.onreconnected(function () {
      poll()
    })

    conn.start().catch(function (e) {
      if (window.console) console.error("[dashboard] SignalR start failed:", e)
    })
  }

  connectDashboardHub()
})()

function workerControl(action) {
  var stopBtn = document.getElementById("worker-stop-btn")
  var startBtn = document.getElementById("worker-start-btn")
  var btn = action === "pause" ? stopBtn : startBtn
  if (btn) {
    btn.disabled = true
  }

  fetch("/dashboard/worker/" + action, { method: "POST", headers: csrfHeaders() })
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

function whisperWorkerControl(action) {
  var stopBtn = document.getElementById("whisper-worker-stop-btn")
  var startBtn = document.getElementById("whisper-worker-start-btn")
  var btn = action === "pause" ? stopBtn : startBtn
  if (btn) {
    btn.disabled = true
  }

  fetch("/dashboard/whisper-worker/" + action, { method: "POST", headers: csrfHeaders() })
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

function ocrWorkerControl(action) {
  var stopBtn = document.getElementById("ocr-worker-stop-btn")
  var startBtn = document.getElementById("ocr-worker-start-btn")
  var btn = action === "pause" ? stopBtn : startBtn
  if (btn) {
    btn.disabled = true
  }

  fetch("/dashboard/ocr-worker/" + action, { method: "POST", headers: csrfHeaders() })
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

function confirmDeleteSeries(title, mediaItemId, queue) {
  var queueLabel = queue === "whisper" ? "whisper" : queue === "translation" ? "translation" : ""
  var mode = (typeof DELETE_NOT_CANCEL !== "undefined" && DELETE_NOT_CANCEL) ? "delete" : "cancel"
  var verb = mode === "delete" ? "Delete" : "Cancel"
  var scopeLine =
    queue === "whisper" || queue === "translation"
      ? "This " + (mode === "delete" ? "removes" : "cancels") + " every episode currently in the " + queueLabel +
        " queue. Episodes in the other queue are left untouched."
      : "This " + (mode === "delete" ? "removes" : "cancels") + " every episode from both the translation and whisper queues."
  return window.confirm(
    verb + " the entire series \"" + (title || "this series") + "\" (" +
      mediaItemId + ") from the " + (queueLabel || "all") + " queue?\n\n" +
      scopeLine + (mode === "delete" ? " This cannot be undone." : " Cancelled items stay visible and can be deleted later.")
  )
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
  fetch("/dashboard/retry-chunk/" + chunkId, { method: "POST", headers: csrfHeaders() })
    .then(function (r) { return r.json() })
    .then(function (data) {
      if (data.error) { alert("Retry failed: " + data.error); return }
      inspectJob(subtitleId)
    })
    .catch(function (e) { alert("Retry failed: " + e.message) })
}

function resetChunk(chunkId, subtitleId) {
  fetch("/dashboard/reset-chunk/" + chunkId, { method: "POST", headers: csrfHeaders() })
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

