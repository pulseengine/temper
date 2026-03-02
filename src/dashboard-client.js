// ── TEMPER Dashboard Client ── tech-punk infra ──

// ── Panel switching ──
var panels = ["signals","reviews","state","firestarter","control","commands"];

function switchPanel(name) {
  panels.forEach(function(p) {
    var el = document.getElementById("panel-" + p);
    if (el) el.classList.toggle("active", p === name);
  });
  document.querySelectorAll("[data-nav]").forEach(function(n) {
    n.classList.toggle("tab-active", n.getAttribute("data-nav") === name);
  });
}

// ── Commands ──
var cmdMap = {
  sync: {url:"/dashboard/actions/sync", method:"POST"},
  refresh: {url:"/dashboard/actions/refresh", method:"POST"},
  "check-config": {url:"/dashboard/actions/check-config", method:"POST"},
  "check-dependabot": {url:"/dashboard/actions/check-dependabot", method:"POST"},
  "fix-dependabot-labels": {url:"/dashboard/actions/fix-dependabot-labels", method:"POST"},
  "analyze-org": {url:"/dashboard/actions/analyze-org", method:"POST"},
};

// ── Review actions ──
function triggerReview(repo, pr) {
  var instructions = document.getElementById("review-instructions-" + repo + "-" + pr);
  var extra = instructions ? instructions.value.trim() : "";
  var statusEl = document.getElementById("review-status-" + repo + "-" + pr);
  if (statusEl) { statusEl.textContent = "triggering..."; statusEl.className = "review-action-status loading"; }
  fetch("/dashboard/actions/review", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({repo: repo, pr: parseInt(pr), instructions: extra})
  })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (statusEl) {
        statusEl.textContent = d.message || (d.success ? "Review triggered" : "Failed");
        statusEl.className = "review-action-status " + (d.success ? "success" : "error");
      }
      // Refresh the reviews list after a short delay
      if (d.success) setTimeout(function() {
        var rev = document.getElementById("reviews-list");
        if (rev) htmx.trigger(rev, "load");
      }, 5000);
    })
    .catch(function(e) {
      if (statusEl) { statusEl.textContent = "ERR: " + e.message; statusEl.className = "review-action-status error"; }
    });
}


function toggleInsightsView(showInsights) {
  var insights = document.getElementById("insights-section");
  var reviews = document.getElementById("reviews-list");
  var filter = document.getElementById("reviews-filter");
  var btns = document.querySelectorAll(".insights-toggle button");
  if (!insights || !reviews) return;

  if (showInsights) {
    insights.style.display = "block";
    reviews.style.display = "none";
    if (filter) filter.style.display = "none";
    btns[0].classList.remove("active");
    btns[1].classList.add("active");
    // Trigger HTMX load if not loaded yet
    htmx.trigger(insights, "insightsLoad");
  } else {
    insights.style.display = "none";
    reviews.style.display = "block";
    if (filter) filter.style.display = "";
    btns[0].classList.add("active");
    btns[1].classList.remove("active");
  }
}

function toggleReviewDetail(id) {
  var el = document.getElementById("review-detail-" + id);
  if (el) el.classList.toggle("open");
}

function runCmd(cmd, resultId) {
  var el = document.getElementById(resultId);
  if (!el) return;
  el.textContent = "Executing...";
  el.className = "cmd-result show loading";
  var info = cmdMap[cmd];
  if (!info) { el.textContent = "Unknown command"; el.className = "cmd-result show error"; return; }
  fetch(info.url, {method:info.method})
    .then(function(r) { return r.json(); })
    .then(function(d) {
      el.textContent = d.message || JSON.stringify(d, null, 2);
      el.className = "cmd-result show " + (d.success ? "success" : "error");
      if (d.success && (cmd === "sync" || cmd === "refresh")) {
        setTimeout(function() {
          document.querySelectorAll("[hx-trigger]").forEach(function(e) { htmx.trigger(e, "load"); });
        }, 500);
      }
    })
    .catch(function(e) { el.textContent = "ERR: " + e.message; el.className = "cmd-result show error"; });
}

// ── Nav badge updates ──
document.body.addEventListener("htmx:afterSwap", function(e) {
  if (e.detail.target.id === "summary-section") {
    e.detail.target.querySelectorAll("[data-metric]").forEach(function(v) {
      var key = v.getAttribute("data-metric");
      var badge = document.getElementById("nav-badge-" + key);
      if (badge) badge.textContent = v.textContent;
    });
  }
  // Auto-expand PR groups with failures
  if (e.detail.target.id === "prs-section" || e.detail.target.id === "overview-prs") {
    e.detail.target.querySelectorAll(".pr-group").forEach(function(g) {
      if (g.querySelector(".badge-err")) g.classList.add("open");
    });
  }
  // Threshold flicker on warn stat cards
  if (e.detail.target.id === "summary-section") {
    e.detail.target.querySelectorAll("[data-threshold]").forEach(function(card) {
      if (card.getAttribute("data-threshold") === "warn") {
        card.classList.add("threshold-flicker");
        setTimeout(function() { card.classList.remove("threshold-flicker"); }, 800);
      }
    });
  }
});

// ── PR group toggle ──
document.body.addEventListener("click", function(e) {
  var header = e.target.closest(".pr-group-header");
  if (header) {
    var group = header.closest(".pr-group");
    if (group) group.classList.toggle("open");
    return;
  }

  // ── Table sorting ──
  var th = e.target.closest("th[data-sort]");
  if (!th) return;
  var table = th.closest("table");
  var idx = Array.from(th.parentElement.children).indexOf(th);
  var tbody = table.querySelector("tbody");
  if (!tbody) return;
  var rows = Array.from(tbody.querySelectorAll("tr"));
  var asc = th.getAttribute("data-sort") !== "asc";
  th.parentElement.querySelectorAll("th[data-sort]").forEach(function(h) { h.setAttribute("data-sort",""); });
  th.setAttribute("data-sort", asc ? "asc" : "desc");
  rows.sort(function(a, b) {
    var at = (a.children[idx]||{}).textContent || "";
    var bt = (b.children[idx]||{}).textContent || "";
    return (asc ? 1 : -1) * at.localeCompare(bt, undefined, {numeric:true});
  });
  rows.forEach(function(r) { tbody.appendChild(r); });
});

// ── Table filtering ──
document.body.addEventListener("input", function(e) {
  if (!e.target.hasAttribute("data-filter")) return;
  var q = e.target.value.toLowerCase();
  var id = e.target.getAttribute("data-filter");
  var tbody = document.querySelector("#" + id + " tbody");
  if (!tbody) return;
  Array.from(tbody.querySelectorAll("tr")).forEach(function(row) {
    row.style.display = row.textContent.toLowerCase().indexOf(q) !== -1 ? "" : "none";
  });
});

// ── Reviews filter ──
document.body.addEventListener("input", function(e) {
  if (e.target.id !== "reviews-filter") return;
  var q = e.target.value.toLowerCase();
  document.querySelectorAll(".review-entry").forEach(function(entry) {
    var filterText = entry.getAttribute("data-review-filter") || "";
    entry.style.display = filterText.toLowerCase().indexOf(q) !== -1 ? "" : "none";
  });
});

// ── Reviews badge update ──
document.body.addEventListener("htmx:afterSwap", function(e) {
  if (e.detail.target.id === "reviews-list") {
    var metric = e.detail.target.querySelector("[data-metric='reviews']");
    var badge = document.getElementById("nav-badge-reviews");
    if (metric && badge) badge.textContent = metric.textContent;
  }
});

// ── Quake Console ──
var qOpen = false, qHistory = [], qHistIdx = -1;

function qLog(text, cls) {
  var out = document.getElementById("qconsole-output");
  var div = document.createElement("div");
  if (cls) { var span = document.createElement("span"); span.className = cls; span.textContent = text; div.appendChild(span); }
  else { div.textContent = text; }
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
}

(function() { qLog("TEMPER console v1.0 // type help", "q-accent"); })();

var qCmds = {
  help: function() {
    [["sync","Sync all repos"],["refresh","Refresh cache"],["check-config","Config report"],
     ["check-deps","Dependabot audit"],["fix-labels","Fix dep labels"],["analyze","Org analysis"],
     ["review","Review PR (repo#N)"],["insights","Review analytics"],["status","Compliance summary"],["prs","Open PRs"],["clear","Clear"]].forEach(function(c) {
      qLog("  " + c[0].padEnd(16) + c[1]);
    });
  },
  clear: function() { document.getElementById("qconsole-output").textContent = ""; },
  status: function() {
    qLog("fetching...", "q-warn");
    fetch("/api/org/health").then(function(r){return r.json()}).then(function(d) {
      var s = Math.round(((d.withProtection+d.correctMerge+d.withSigned+d.withAutoMerge+d.withAllLabels)/(d.total*5))*100);
      qLog("compliance:" + s + "%  repos:" + d.total + "  protected:" + d.withProtection + "  signed:" + d.withSigned, "q-accent");
      qLog("ci:" + d.ciPassing + "/" + d.withCI + "  merge_ok:" + d.correctMerge + "  prs:" + (d.totalPRs||0));
    }).catch(function(e) { qLog("ERR: " + e.message, "q-err"); });
  },
  prs: function() {
    qLog("fetching...", "q-warn");
    fetch("/api/org/repos").then(function(r){return r.json()}).then(function(d) {
      var prs = [];
      (d.repos||[]).forEach(function(r) { (r.open_prs||[]).forEach(function(p) { prs.push(r.name + " #" + p.number + " " + p.title); }); });
      if (!prs.length) qLog("no open PRs", "q-accent");
      else prs.forEach(function(p) { qLog("  " + p); });
    }).catch(function(e) { qLog("ERR: " + e.message, "q-err"); });
  },
};
// review command: review repo#N [instructions]
qCmds["review"] = "special";
qCmds["insights"] = function() {
  qLog("fetching review insights...", "q-warn");
  fetch("/api/reviews/insights").then(function(r){return r.json()}).then(function(d) {
    if (!d.success || !d.insights || !d.insights.total) {
      qLog("no review data available yet", "q-info");
      return;
    }
    var i = d.insights;
    qLog("\n  REVIEW INSIGHTS", "q-accent");
    qLog("  ─────────────────────────────────────");
    qLog("  reviews: " + i.total + "  repos: " + i.repos + "  unique PRs: " + i.uniquePRs + "  avg findings: " + i.avgFindings);
    qLog("  last 7d: " + i.last7d + "  last 30d: " + i.last30d + "  find rate: " + i.actionable + "%");
    qLog("");
    qLog("  VERDICTS", "q-accent");
    qLog("  approve: " + i.verdicts.approve + "  minor: " + i.verdicts.minor + "  major: " + i.verdicts.major + "  no verdict: " + i.verdicts.unknown);
    qLog("");
    qLog("  SEVERITY", "q-accent");
    qLog("  critical: " + i.criticals + "  warning: " + i.warnings + "  suggestion: " + i.suggestions + "  total: " + i.totalFindings);
    if (i.repoBreakdown && i.repoBreakdown.length > 0) {
      qLog("");
      qLog("  TOP REPOS BY FINDINGS", "q-accent");
      i.repoBreakdown.slice(0, 5).forEach(function(r) {
        qLog("  " + r.name.padEnd(20) + r.findings + " findings / " + r.reviews + " reviews (avg " + r.avgFindings + ")");
      });
    }
    qLog("");
  }).catch(function(e) { qLog("ERR: " + e.message, "q-err"); });
};
 // placeholder, handled in command dispatch below

["sync","refresh","check-config","check-deps","fix-labels","analyze"].forEach(function(cmd) {
  var apiCmd = cmd === "check-deps" ? "check-dependabot" : cmd === "fix-labels" ? "fix-dependabot-labels" : cmd === "analyze" ? "analyze-org" : cmd;
  qCmds[cmd] = function() {
    qLog("running " + cmd + "...", "q-warn");
    var url = cmdMap[apiCmd] ? cmdMap[apiCmd].url : "/dashboard/actions/" + apiCmd;
    fetch(url, {method:"POST"}).then(function(r){return r.json()}).then(function(d) {
      var msg = d.message || JSON.stringify(d);
      if (msg.length > 2000) msg = msg.substring(0,2000) + " ...(truncated)";
      qLog(msg, d.success ? "q-ok" : "q-err");
    }).catch(function(e) { qLog("ERR: " + e.message, "q-err"); });
  };
});

document.addEventListener("keydown", function(e) {
  var input = document.getElementById("qconsole-input");
  if (e.key === "`" && document.activeElement !== input && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    qOpen = !qOpen;
    document.getElementById("qconsole").classList.toggle("open", qOpen);
    if (qOpen) input.focus();
  }
  if (e.key === "Escape" && qOpen) {
    qOpen = false;
    document.getElementById("qconsole").classList.remove("open");
  }
});
document.getElementById("qconsole-input").addEventListener("keydown", function(e) {
  if (e.key === "`") { e.preventDefault(); qOpen = false; document.getElementById("qconsole").classList.remove("open"); return; }
  if (e.key === "Enter") {
    var val = e.target.value.trim(); if (!val) return;
    qHistory.unshift(val); qHistIdx = -1;
    qLog("> " + val, "q-cmd");
    // Handle commands with arguments
    var parts = val.split(/\s+/);
    var cmdName = parts[0];
    var cmdArgs = parts.slice(1).join(" ");
    if (cmdName === "review") {
      // Parse: review repo#N [instructions] or review repo N [instructions]
      var match = cmdArgs.match(/^(\S+?)(?:#|\s+)(\d+)\s*(.*)?$/);
      if (!match) { qLog("usage: review repo#N [instructions]", "q-err"); }
      else {
        var rRepo = match[1], rPr = match[2], rInstr = (match[3]||"").trim();
        qLog("triggering review for " + rRepo + " #" + rPr + (rInstr ? " (" + rInstr + ")" : "") + "...", "q-warn");
        fetch("/dashboard/actions/review", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({repo:rRepo,pr:parseInt(rPr),instructions:rInstr})})
          .then(function(r){return r.json()}).then(function(d) { qLog(d.message || JSON.stringify(d), d.success ? "q-ok" : "q-err"); })
          .catch(function(e) { qLog("ERR: " + e.message, "q-err"); });
      }
    } else {
      var fn = qCmds[cmdName];
      if (fn && fn !== "special") fn(); else if (!fn) qLog("unknown command. type help.", "q-err");
    }
    e.target.value = "";
  }
  if (e.key === "ArrowUp") { e.preventDefault(); if (qHistIdx < qHistory.length-1) { qHistIdx++; e.target.value = qHistory[qHistIdx]; } }
  if (e.key === "ArrowDown") { e.preventDefault(); if (qHistIdx > 0) { qHistIdx--; e.target.value = qHistory[qHistIdx]; } else { qHistIdx=-1; e.target.value=""; } }
});
