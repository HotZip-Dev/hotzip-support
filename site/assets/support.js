// Support form: posts the report to the relay, which opens a GitHub issue.
// The relay address comes from the form (data-endpoint); empty means the form
// isn't open yet and shows a short note instead.
(function () {
  "use strict";

  var form = document.getElementById("report");
  if (!form) return;
  var ENDPOINT = form.getAttribute("data-endpoint") || "";

  var status = document.getElementById("form-status");
  var submit = form.querySelector("button[type=submit]");
  var errorsField = document.getElementById("errors-field");
  var versionField = document.getElementById("version-field");

  // Wording per type. Ideas don't need a version or error text.
  var TEXT = {
    bug: {
      label: "What happened?",
      hint: "What you did, what you expected, and what happened instead.",
      submit: "Send report",
      missing: "Pick an addon and tell us what happened."
    },
    idea: {
      label: "Your idea",
      hint: "What would you like, and what would it help you do?",
      submit: "Send idea",
      missing: "Pick an addon and tell us your idea."
    }
  };

  // Preselect the addon from ?addon=OnlyOres (addon pages link here that way).
  var params = new URLSearchParams(location.search);
  var addon = params.get("addon");
  if (addon) {
    var select = form.elements.addon;
    for (var i = 0; i < select.options.length; i++) {
      if (select.options[i].value === addon) select.selectedIndex = i;
    }
  }
  if (params.get("type") === "idea") form.elements.type.value = "idea";

  function isIdea() { return form.elements.type.value === "idea"; }

  function syncType() {
    var t = TEXT[isIdea() ? "idea" : "bug"];
    document.getElementById("details-label").textContent = t.label;
    document.getElementById("details-hint").textContent = t.hint;
    document.getElementById("submit-label").textContent = t.submit;
    errorsField.hidden = isIdea();
    versionField.hidden = isIdea();
  }
  form.addEventListener("change", function (e) {
    if (e.target.name === "type") syncType();
  });
  syncType();

  if (!ENDPOINT) {
    submit.disabled = true;
    document.getElementById("form-closed").hidden = false;
    return;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var data = {
      addon: form.elements.addon.value,
      type: form.elements.type.value,
      version: isIdea() ? "" : form.elements.version.value.trim(),
      details: form.elements.details.value.trim(),
      errors: isIdea() ? "" : form.elements.errors.value.trim(),
      website: form.elements.website.value // honeypot: people leave it empty
    };
    if (!data.addon || !data.details) {
      showStatus(TEXT[data.type].missing, true);
      return;
    }

    submit.disabled = true;
    showStatus("Sending…", false);

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) throw new Error(body.error || "Couldn't send. Try again in a minute.");
          var next = form.getAttribute("data-thanks");
          location.href = next + (body.url ? "?issue=" + encodeURIComponent(body.url) : "");
        });
      })
      .catch(function (err) {
        submit.disabled = false;
        showStatus(err.message === "Failed to fetch" ? "Couldn't send. Check your connection and try again." : err.message, true);
      });
  });

  function showStatus(text, isError) {
    status.textContent = text;
    status.className = "form-status" + (isError ? " error" : "");
  }
})();
