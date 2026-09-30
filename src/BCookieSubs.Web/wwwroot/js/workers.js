(function () {
    var container = document.getElementById("workers-table");
    if (!container) return;

    var refreshTimer = null;
    function scheduleRefresh() {
        if (refreshTimer) return;
        refreshTimer = setTimeout(function () {
            refreshTimer = null;
            fetch(container.dataset.partialUrl, { headers: { "X-Requested-With": "fetch" } })
                .then(function (r) { return r.ok ? r.text() : null; })
                .then(function (html) { if (html) container.innerHTML = html; })
                .catch(function () {  });
        }, 200);
    }

    var connection = new signalR.HubConnectionBuilder()
        .withUrl("/hubs/workers")
        .withAutomaticReconnect()
        .build();

    connection.on("workerEvent", scheduleRefresh);

    connection.start().catch(function () {
    });
})();

function copyToken() {
    var box = document.getElementById("enrollment-token-box");
    if (!box) return;
    var code = box.querySelector("code.token");
    if (code && navigator.clipboard) {
        navigator.clipboard.writeText(code.textContent.trim());
    }
}

document.addEventListener("submit", function (event) {
    var form = event.target;
    if (form.classList && form.classList.contains("confirm-remove")) {
        if (!window.confirm("Remove this worker? It must be re-enrolled to return.")) {
            event.preventDefault();
        }
    }
}, true);