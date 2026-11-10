/*
 * Minimal CSInterface bridge for CEP panels. If Adobe's full CSInterface.js is
 * available, this subset is enough for evalScript-based AE communication.
 */
(function () {
  "use strict";

  function CSInterface() {}

  CSInterface.prototype.evalScript = function (script, callback) {
    if (window.__adobe_cep__ && typeof window.__adobe_cep__.evalScript === "function") {
      window.__adobe_cep__.evalScript(script, callback || function () {});
      return;
    }
    if (callback) {
      callback("CEP bridge unavailable");
    }
  };

  CSInterface.prototype.getSystemPath = function (pathType) {
    if (window.__adobe_cep__ && typeof window.__adobe_cep__.getSystemPath === "function") {
      return window.__adobe_cep__.getSystemPath(pathType);
    }
    return "";
  };

  window.CSInterface = window.CSInterface || CSInterface;
})();
