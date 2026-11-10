(function () {
  "use strict";
  // CEP10 embeds an older Chromium without flex gap support.
  var gapProbe = document.createElement("div");
  gapProbe.style.cssText = "position:absolute;visibility:hidden;display:flex;flex-direction:column;row-gap:1px;";
  gapProbe.appendChild(document.createElement("div"));
  gapProbe.appendChild(document.createElement("div"));
  document.body.appendChild(gapProbe);
  if (gapProbe.scrollHeight !== 1) document.body.classList.add("afm-no-flex-gap");
  document.body.removeChild(gapProbe);
  var nav = document.querySelector(".page-tabs");
  if (!nav) return;
  var brand = document.createElement("span");
  brand.className = "anime-nav-brand";
  brand.innerHTML = '<b>✧</b><span>星屿<small>FILE MANAGER</small></span>';
  nav.insertBefore(brand, nav.firstChild);
  Array.prototype.forEach.call(nav.querySelectorAll(".page-tab"), function (tab, i) {
    tab.setAttribute("data-chapter", "0" + (i + 1));
    if (tab.classList.contains("active")) tab.setAttribute("aria-current", "page");
  });
  var promo = document.createElement("aside");
  promo.className = "anime-promo";
  promo.setAttribute("aria-label", "插件联系与源码下载");
  promo.innerHTML = '<span>最新版插件可以联系：<b>uqeh3208</b></span><a href="https://www.jck123.cn/" target="_blank" rel="noopener noreferrer">其他海量源码下载地址：<b>www.jck123.cn</b> ↗</a>';
  var settings = document.getElementById("aiSettingsBtn");
  nav.insertBefore(promo, settings || null);
  promo.querySelector("a").addEventListener("click", function (event) {
    if (window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) {
      event.preventDefault();
      window.cep.util.openURLInDefaultBrowser("https://www.jck123.cn/");
    } else if (window.require && window.process && window.process.platform === "win32") {
      event.preventDefault();
      window.require("child_process").execFile("explorer.exe", ["https://www.jck123.cn/"], { windowsHide: true }, function () {});
    }
  });
}());
