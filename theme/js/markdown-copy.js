(function () {
  function getMarkdownUrl() {
    var path = window.location.pathname;
    var filename = path.split("/").pop() || "index.html";
    var mdFilename =
      filename === "" ? "index.md" : filename.replace(/\.html$/, ".md");
    return window.location.origin + "/md/" + mdFilename;
  }

  var mdUrl = getMarkdownUrl();

  // Set <link rel="alternate"> for LLM crawlers
  var linkEl = document.getElementById("markdown-alternate");
  if (linkEl) linkEl.href = mdUrl;

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("copy-markdown-button");
    if (!btn) return;

    btn.addEventListener("click", function () {
      fetch(mdUrl)
        .then(function (r) {
          return r.text();
        })
        .then(function (text) {
          navigator.clipboard.writeText(text).then(function () {
            btn.title = "Copied!";
            setTimeout(function () {
              btn.title = "Copy page as Markdown";
            }, 2000);
          });
        })
        .catch(function () {
          btn.title = "Failed to copy";
          setTimeout(function () {
            btn.title = "Copy page as Markdown";
          }, 2000);
        });
    });
  });
})();
