/* Settings section tabs. Plain ES2017, no build step. */
(function () {
  "use strict";

  var KEY = "servermonitor-settings-tab";
  var tabs = Array.prototype.slice.call(document.querySelectorAll("[data-settings-tab]"));
  var sections = Array.prototype.slice.call(document.querySelectorAll(".settings-card[data-section]"));
  if (!tabs.length || !sections.length) return;

  function known(name) {
    return sections.some(function (section) {
      return section.getAttribute("data-section") === name;
    });
  }

  function stored() {
    try {
      var hash = (window.location.hash || "").replace(/^#/, "");
      if (hash && known(hash)) return hash;
      var value = sessionStorage.getItem(KEY);
      if (value && known(value)) return value;
    } catch (e) {}
    return "monitoring";
  }

  function show(name) {
    tabs.forEach(function (tab) {
      var active = tab.getAttribute("data-settings-tab") === name;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    sections.forEach(function (section) {
      section.hidden = section.getAttribute("data-section") !== name;
    });
    try { sessionStorage.setItem(KEY, name); } catch (e) {}
    window.scrollTo(0, 0);
  }

  document.getElementById("settings-tabs").addEventListener("click", function (event) {
    var button = event.target.closest("[data-settings-tab]");
    if (!button) return;
    show(button.getAttribute("data-settings-tab"));
  });

  show(stored());
})();
