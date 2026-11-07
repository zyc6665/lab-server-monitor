/* Custom titlebar controls for the Electron desktop shell. */
(function () {
  "use strict";
  var bridge = window.desktopBridge;
  if (!bridge || typeof bridge.windowAction !== "function") return;
  document.querySelectorAll("[data-window-action]").forEach(function (button) {
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      bridge.windowAction(button.getAttribute("data-window-action"));
    });
  });
  var bar = document.getElementById("app-titlebar");
  if (bar) {
    bar.addEventListener("dblclick", function (event) {
      if (event.target.closest(".no-drag")) return;
      bridge.windowAction("maximize");
    });
  }
})();
